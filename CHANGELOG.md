# Changelog

本文件记录 tiny-sql 的所有版本变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/)，遵循[语义化版本](https://semver.org/)。

---

## [Unreleased]

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
- 错误走稳定 i18n key（`error.ssh.*`），不向前端泄露后端语言。
- v0.1 host key 暂用 accept-all；known_hosts + TOFU 校验留 Week 3。

#### MySQL driver（crates/db-driver）

- 基于 `sqlx 0.8`（`runtime-tokio-rustls`）。v0.1 是具体 `struct MySqlDriver`，**不抽 `trait Driver`**；v0.2 加 PostgreSQL 时再 extract trait（避免抽象提前）。
- `MySqlDriver`：`connect` / `connect_url` / `ping` / `list_databases` / `list_tables` / `list_columns` / `query`；动态结果集按列类型分派解码为字符串（`chrono` 解日期、`bigdecimal` 解 DECIMAL，NULL → None）。
- `query` 的子查询包装防 OOM、10w 行截断、独立 control connection 的 `KILL QUERY` 取消留 Week 4。

#### 连接管理（src-tauri + 前端）

- 命令 `connection_create` / `connection_list` / `connection_update` / `connection_delete` / `connection_test`；配置整体加密落盘，`connection_test` 走完整链路（可选多跳 SSH + `SELECT 1`），错误以稳定 i18n key 回传。
- 前端：左侧连接列表 + 右侧编辑表单（`zustand` 状态），测试连接即时反馈；SSH 跳板配置 UI 留 Week 3。

---
