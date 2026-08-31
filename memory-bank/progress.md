# 进度（progress）

> 面向历史回溯：发生了什么、为什么变。重大架构变更记日期。

## 版本发布历史

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.0.3 | ✅ 预览版已发布 | 2026-07-03 全平台 Release 成功，含 updater 签名产物与 `latest.json` |
| v0.1.0 | ✅ 正式版已发布 | 2026-08-18 全平台 Release 成功，含安装包、签名更新产物与四平台 `latest.json` |
| v0.2 | ✅ 正式版已发布 | 2026-08-20 发布 `v0.2.0`（发布提交 `4f6b07f`）；V2-CP1~CP5 全部关闭。范围：多 driver + PostgreSQL、主密码加密/TLS 诊断、schema intelligence、查询工作台、SSH RTT/重连；详见 CHANGELOG `0.2.0` 段 |
| v0.3 | ✅ 正式版已发布 | 2026-08-22 发布 `v0.3.0`（发布提交 `0825da5`，Release run `32546492367` 四平台成功，含四平台资产与 `latest.json`）。范围：可靠事务、服务端筛选分页、index/constraint 元数据树与对象搜索、多语句与格式化、SQL 文件工作流；详见 CHANGELOG `0.3.0` 段 |
| v0.4 | ✅ 随 v0.7.0 正式发布 | 2026-08-22 完成三项 FR 并打 `v0.4.0-rc1`；2026-08-24 与 v0.5–v0.7 一并打进 `v0.7.0` |
| v0.5 | ✅ 随 v0.7.0 正式发布 | FR-253 / FR-260 / FR-221 |
| v0.6 | ✅ 随 v0.7.0 正式发布 | FR-220 / FR-261 / FR-263 |
| v0.7 | ✅ 正式版已发布 | 2026-08-24 `just release v0.7.0`（发布提交 `d2d3f5c`，tag `v0.7.0`）。范围含 v0.4–v0.7 全部已编码功能 |
| v0.8 | ✅ 正式版已发布 | 2026-08-29 `just release v0.8.0`（发布提交 `12d3aae`，tag `v0.8.0`，Release run `33230468506` 四平台全部成功，Release 为 latest，含四平台资产与已核对的 `latest.json`）。范围：FR-270–275、SQLite driver、应用设置弹窗与更新代理、ER 关系图重做为实体卡片画布 + 整库结构批量拉取。rc1 2026-08-26、rc2 2026-08-28。双向同步 / BI / AI 挂 v0.9+ |

CHANGELOG 已切出 `0.1.0` 版本段，`[Unreleased]` 已开始记录后续体验变化。v0.1.0 Release notes 与该版本段一致，并明确记录三项已知限制。

## 架构变更：新增 SQLite driver（2026-08-25）

第三个 `Driver` 实现落地，`db-driver` 从「双 driver」变成「三 driver」。这是第一个**非网络型** driver，因此动了三处一直只为网络型数据库准备的假设：

1. **连接模型多了一类**：`DriverKind::is_file_based()` 成为新判据。SQLite 用 `StoredConnection.database` 承载 `.db` 文件路径，host / port / 账号与 SSH 隧道、SSL 全部旁路 —— `connection.rs` 在「建隧道」与「session 级 database_override」两处按它短路。选这个映射而不是加字段，是为了不动已加密落盘的连接记录结构。
2. **取消机制多了一类**：MySQL 发 `KILL QUERY`、PostgreSQL 调 `pg_cancel_backend`，都要另开一条 control 连接；SQLite 没有服务端，改用连接内的 SQLite 原生 progress handler（回调返 false 即 SQLITE_INTERRUPT），因此 SqliteDriver **不需要 control pool**。代价是 handler 会跟着连接回池，语句结束必须摘除，否则旧 cancel token 会误伤后续查询。
3. **元数据层级少了一层**：SQLite 没有 schema，`MetadataScope.schema` 恒为 None、`list_schemas` 返回空。前端原本 `driver === "postgresql" ? 有 schema : 无 schema` 的分支天然适配，只有两处写死 `=== "mysql"` 的（schema-browser 表树、session-store 元数据加载）需要放宽成 `!== "postgresql"`。

顺带把 `ActiveDriver` 的通用 `Driver` 方法从「每个方法三份 match」收敛成 `inner() -> &dyn Driver` 委托；`as_mysql()` 与 enum 保留，方言专属能力（CREATE DATABASE、权限）仍按 enum 分流。

**踩到的坑**：SQLite 是动态类型，`SqliteColumn::type_info()` 给的是**列声明类型**，表达式列（`COUNT(*)`、`a + b`）根本没有声明类型 → 按它分派会把非空值一律解码成 NULL。改为按 `ValueRef` 的**取值真实类型**（INTEGER / REAL / TEXT / BLOB / NULL）分派。这个 bug 是 SQLite integration 测试抓出来的 —— 也正因为 SQLite 不需要外部服务，这套测试用临时文件库、不标 `#[ignore]`，进了默认 `just test`。

## 待验证 / 风险跟踪

- **CP-4 / GUI dogfooding**：用户提交 `4f54f02` 已标记完成；真实记录在 ignored `docs/dogfooding-log.md`，本轮未读取其中环境细节。
- **CP-2** Week 2/3 累计工时未正式记录；该历史检查点不再进入当前待办计划。
- **CP-3** MySQL 5.7 兼容已由用户提交 `4f54f02` 标记完成；不进入 CI 的策略不变。
- **v0.1.0 产物验证**：全平台 Release workflow、安装包、签名更新产物和四平台 `latest.json` 已验证；从 v0.0.3 应用内发现、下载、安装并重启到 v0.1.0 也已实测。
- **发布脚本暂存范围**：`just version` 已会同步 `Cargo.lock` 本地 package 版本，`just release` 已收窄到版本/CHANGELOG/Cargo.lock 相关文件；正式发版前仍必须确认工作区没有无关改动。
- **自动更新 GitHub Secrets**：release workflow 依赖 `TAURI_SIGNING_PRIVATE_KEY`；无密码私钥时 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可留空。本地按 Redis 项目方式把真实私钥写入 ignored `.env`，`just build` 会加载；直接 `pnpm tauri build` 不经 justfile 注入 `.env`，仍需手动 export，且无密码私钥要显式保留 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`。
- **连接 tab 表单 GUI 验证**：常规 / SSH / SSL / 高级标签页、新建数据库、schema 树和更新菜单已由用户确认完成验收；环境细节不写入公开仓库。
- **R-001** Tauri+workspace 摩擦：已规避（CP-1 通过）。
- **R-002** caching_sha2 握手：MySQL 5.7 兼容已由用户提交 `4f54f02` 标记验证完成。
- **R-keepalive** keepalive 在某些 server 不响应 / drop 后 task leak：60s+3 次阈值留缓冲；Drop 已 abort 全部 keepalive task。
- **R-updater-release** 已关闭：云端全平台 artifact、正式版 `latest.json` 及 v0.0.3 → v0.1.0 应用内发现、下载、安装、重启全链路均已验证。
- **R-ssh-runtime-errors 已关闭**：首跳掉线、嵌套 channel 断开与 accept worker 异常均有运行路径、去重和正常关闭抑制测试。
- **R-passphrase-test** `connection_test` 不接收 passphrase，带口令私钥只能在正式打开连接时验证完整链路。
- **R-query-error-contract 已关闭**：前端仅接收稳定 key 与可选正整数行号，原始 Rust/sqlx/MySQL 错误不跨 IPC。

相关：[[activeContext]] · [[projectbrief]]

## 归档
- [2026-08](./archive/progress-2026-08.md) — 已交付周计划明细 / 开发阶段完成度 / Git 提交历史 / 旧决策明细 / 已解决阻碍
