---
name: 11-db-driver
description: Driver 契约与 MySQL/PostgreSQL/SQLite 三实现 —— 元数据分层、取消机制、SQL guard
paths:
  - "crates/db-driver/**"
---

# 数据库 driver（11-db-driver）

> 改 `crates/db-driver/**` 前读这份。这个 crate **不知道 SSH 存在**。

## 文件划分

- `src/lib.rs`：公共契约、MySQL 实现与共享 SQL guard；
- `src/postgres.rs`：PostgreSQL metadata / query / cancel；
- `src/sqlite.rs`：SQLite（文件型连接 + progress handler 取消，**无 control pool**）；
- `src/session.rs`：可靠事务用的独占 session；
- `tests/integration.rs`（MySQL，`#[ignore]`）、`tests/postgres_integration.rs`（`#[ignore]`）、`tests/sqlite_integration.rs`（临时文件库，**不标 `#[ignore]`**，进默认 `just test`）。

## Driver 契约

- 对象安全：用装箱 Future 保持对象安全，**不引入 `async-trait`**；取消令牌作为 query 契约的一部分，由具体 driver 映射为原生取消机制。
- 契约只覆盖通用能力：ping、metadata、query / cancel、close。
- metadata 通过 `MetadataScope { database, schema }` 显式表达层级；MySQL schema 与 database 同义，PostgreSQL schema 是独立层级且不能在同一连接上跨 database 查询，SQLite 无 schema。
- `src-tauri` 侧用 `ActiveDriver` 包装；通用 `Driver` 方法统一走 `inner() -> &dyn Driver` 委托，`as_mysql()` 与 enum 保留，方言专属能力（`CREATE DATABASE`、权限）仍按 enum 分流。

## 取消机制（三实现各不相同）

| driver | 机制 | 代价 |
|---|---|---|
| MySQL | 独立 control pool（max=1）发 `KILL QUERY` | 不从主 pool 借连接（pool 满时借不到） |
| PostgreSQL | 独立 control pool 调 `pg_cancel_backend` | 取消或客户端截断后**关闭该执行连接**，避免未消费协议消息回池 |
| SQLite | 连接内 SQLite 原生 progress handler（回调返 false 即 `SQLITE_INTERRUPT`） | **不需要 control pool**；handler 会跟着连接回池，**语句结束必须摘除**，否则旧 cancel token 会误伤后续查询 |

control pool 是「同一连接参数独立连接池」，**不是**独立本地端口。

## SQL guard 与结果集防护

- 拒多语句（自有 SQL 分析 / 分号状态机，未引 `sqlparser-rs`）。
- LIMIT 防护用**顶层安全追加 LIMIT**（顶层无 LIMIT/FOR/LOCK/INTO/PROCEDURE 时末尾追加 `LIMIT n+1`），**不做 derived table 包装**（JOIN 重名列触发 1060）；顶层已含这些子句时客户端截断兜底，截断且无服务端 LIMIT 时主动 `KILL QUERY` 止损。
- 写操作二次确认为**首 token 白名单分类**（SELECT/WITH 读、SHOW/EXPLAIN/DESC/DESCRIBE 元数据免确认、其余一律需 allow_write），前后端同一套规则，**不用黑名单正则**。
- `rowLimit` 后端 clamp 到 100000（表浏览 1000，SQL 编辑器 100000）。
- PostgreSQL guard 独立处理 `TABLE` / `VALUES`、`OFFSET` / `FETCH`、dollar-quoted body 与数据修改 CTE；DML `RETURNING` 需写确认并返回结果行。

## MySQL 专属

- 支持 5.7（`mysql_native_password`）与 8.0 / 8.4（`caching_sha2_password`）。
- SSL 默认 `Disabled`；用户显式选择 Preferred / Required / Verify CA / Verify Identity 时，`src-tauri` 把模式与 CA / 客户端证书 / 私钥路径传给 `db-driver::MySqlConnectSettings`。**不要把「真实 TLS 尚未验收」写成「代码完全未启用」**。
- `MySqlDriver::list_constraints` 用两条 information_schema 等值查询，避免结构页卡死。

## PostgreSQL 专属

- database 与 schema 分层；`list_schemas/list_tables/list_columns` 只允许当前 database，跨 database 返回 `error.driver.database_switch_required`。UI 对该 key 给「一键切换」引导：`connection_reconnect` 带 session 级 `databaseOverride` 重建连接（不落盘），**不做隐式重连**。
- 版本基线：正式支持 15-18，最低 15；14 及以下 best-effort，不在连接阶段主动阻止。
- **风险**：session 客户端截断 / 取消后事务大概率保不住（协议残留低频路径），session 验证失败即 `session_broken`，前端引导重建。

## SQLite 专属

- 连接模型：`DriverKind::is_file_based()` 是新判据；`StoredConnection.database` 承载 `.db` 文件路径，host / port / 账号与 SSH 隧道、SSL 全部旁路。
- 无 schema 层级：`MetadataScope.schema` 恒为 `None`、`list_schemas` 返回空。
- **动态类型按取值真实类型解码**：`SqliteColumn::type_info()` 给的是**列声明类型**，表达式列（`COUNT(*)`、`a + b`）没有声明类型 → 按它分派会把非空值一律解码成 NULL；必须按 `ValueRef` 的取值真实类型（INTEGER / REAL / TEXT / BLOB / NULL）分派。
- 数据库文件不存在时连接失败（不自动建库）；外键约束默认开启（SQLite 自身默认关闭）；改写数据库的 `PRAGMA`（如 `PRAGMA journal_mode = WAL`）按写操作处理。
- 备份 / 恢复依赖用户机器上有 `sqlite3` 命令行（`.dump` / stdin 灌入），与 mysqldump / pg_dump 同一套外部工具链路。
- 有意不做：账号权限视图（`db_list_accounts` 返回 `error.privilege.unsupported`）；`ALTER TABLE` 改类型 / 空性 / 默认值（需重建表，`validateAlterTable` 阶段拒绝）；结构页不列 CHECK 约束；复制表不带索引（索引名库级唯一会撞名）。

## 依赖事实

`sqlx` 0.8.6，`default-features=false`，features = `mysql` + `postgres` + `sqlite` + `runtime-tokio-rustls` + `chrono` + `bigdecimal` + `json`；`sqlite` feature 走 `sqlx-sqlite/bundled`，SQLite 静态内建，无系统 libsqlite3 依赖。`sqlx-postgres` 为 MIT OR Apache-2.0。

## 负向约束（❌ 不要做）

- ❌ **不把方言专属对象操作塞进 `Driver`** —— 通用契约只覆盖 ping、metadata、query/cancel、close；连接创建与 MySQL `CREATE DATABASE` 等能力留在具体实现 / factory。
- ❌ **不用 regex 检测 SQL 的 LIMIT** —— 会被注释 / 字符串 / CTE / UNION 骗，用顶层安全追加 LIMIT（也不做 derived table 包装）。
- ❌ **不向前端泄露原始 Rust / sqlx / 数据库错误** —— 必须走 i18n key。
- ❌ **不伪造 FOREIGN KEY 关系** —— 数据库设计不定义 FOREIGN KEY，关联由代码与索引控制；补全候选只基于已加载的实际列。

相关：[[10-ssh-multihop]] · [[12-tauri-shell]] · [[20-frontend]]
