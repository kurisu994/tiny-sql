# Changelog

本文件记录 tiny-sql 的所有版本变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/)，遵循[语义化版本](https://semver.org/)。

---

## [Unreleased]

### 🎨 体验调整

- 更新 tiny-sql 专属应用图标，以数据库与多跳连接为主体，并重新生成 Tauri 桌面与平台图标资源。

### 🏗️ 工程脚手架

- 初始化 Cargo workspace：`ssh-multihop`（隧道）/ `db-driver`（MySQL）/ `src-tauri`（Tauri 壳）三成员；`src-tauri` 引用 workspace crate 编译通过，无需退回扁平 mod。
- 前端：Next.js 16 (Turbopack) + React 19 + Tailwind CSS 4 静态导出（`output: export` → `out/`）。
- 命令入口 `justfile`：`dev` / `build` / `check` / `lint` / `fmt` / `test` / `version` / `release` 等。
- 连接配置加密：复用 AES-256-GCM + master key（0600），tiny-sql 对**整个 `connections.enc` 文件**加密（满足 FR-001：明文 host/user/password 不落盘）。
- 测试基础设施：前端 `vitest` + `@testing-library/react`；`db-driver` integration 测试连本地 MySQL（`TINY_SQL_TEST_MYSQL_URL`，默认 `#[ignore]`）。
- GitHub Actions CI（macOS arm64）：`cargo fmt --check` + `clippy` + `cargo test` + `vitest` + 前端 build。
- ⏸️ playwright E2E 因 Tauri WebDriver 不支持 macOS 推迟（留将来 Linux CI / Week 5 dogfooding）。

### ✨ 新功能

#### 多跳 SSH 隧道（crates/ssh-multihop）

- 基于 `russh 0.54` 的纯 Rust 异步 SSH 隧道，**不依赖 Tauri**，未来可独立 publish 到 crates.io。
- 支持任意 N 跳串联（OpenSSH ProxyJump 等效）：第一跳本地直连，后续每跳在前一跳的 SSH 通道上递归建立，最后一跳对目标开 `direct-tcpip`，在本地 `127.0.0.1` 绑定随机端口。
- 密码 / 私钥（含 `~` 路径展开 + passphrase）两种认证。
- 错误走稳定 i18n key（`error.ssh.*`），不向前端泄露后端语言；每个变体带 `hop_index`，故障可归因到具体某一跳（FR-013）。
- **keepalive（FR-014）**：russh 内置 keepalive 60s / 连续 3 次未响应（≈180s）判定断开，每跳一个监控 task 经回调上报 `ssh:hop-status`，隧道 drop 时一并 abort 防 leak。
- **三个 mid-session 错误变体** `TunnelLost` / `ChannelDropped` / `AcceptLoopDied`，覆盖运行中断开的三种 failure mode。
- **host key 校验 / TOFU**：`HostKeyVerifier` 回调注入（仍不依赖 Tauri）——已信任比对、指纹变更**硬拒绝**（不给「忽略」）、未知 host 走 TOFU 弹窗确认。

#### MySQL driver（crates/db-driver）

- 基于 `sqlx 0.8`（`runtime-tokio-rustls`）。v0.1 是具体 `struct MySqlDriver`，**不抽 `trait Driver`**；v0.2 加 PostgreSQL 时再 extract trait（避免抽象提前）。
- `MySqlDriver`：`connect` / `connect_url` / `ping` / `list_databases` / `list_tables` / `list_columns` / `query`；动态结果集按列类型分派解码为字符串（`chrono` 解日期、`bigdecimal` 解 DECIMAL，NULL → None）。
- `query` 的子查询包装防 OOM、10w 行截断、独立 control connection 的 `KILL QUERY` 取消留 Week 4。

#### 连接管理（src-tauri + 前端）

- 命令 `connection_create` / `connection_list` / `connection_update` / `connection_delete` / `connection_test`；配置整体加密落盘，`connection_test` 走完整链路（可选多跳 SSH + `SELECT 1`），错误以稳定 i18n key 回传。
- **持久连接**：`connection_open` / `connection_close` 把（可选）SSH 隧道 + MySQL 连接池存入 `AppState` 活跃注册表，生命周期绑定（先关 pool 后关隧道）；私钥 passphrase 首次输入后**会话内缓存**（NFR-011），下次打开静默。
- 前端：左侧连接列表 + 右侧编辑表单（`zustand`），SSH 跳板折叠区可配 N 跳（增删 / 调序）；TOFU 指纹确认、passphrase、隧道断开提示弹窗。

#### 数据浏览（src-tauri + 前端）

- 命令 `db_list_databases` / `db_list_tables` / `db_list_columns` / `db_query`（基于已打开连接）。
- 前端：左侧 database/table 树，点表查看前 1000 行（`SELECT … LIMIT 1000`）。
- ⏸️ 1000 行用普通滚动表格，`react-virtuoso` 虚拟滚动留 Week 4 的 10 万行硬上限再引入。
- TOFU 信任库 `known_hosts.json`（自有 store，**不碰** `~/.ssh/known_hosts`，NFR-012）。

---
