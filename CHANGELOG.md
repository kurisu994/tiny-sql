# Changelog

本文件记录 tiny-sql 的所有版本变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/)，遵循[语义化版本](https://semver.org/)。

---

## [Unreleased]

### 🏗️ 工程脚手架（Week 1 vertical slice）

- 初始化 Cargo workspace：`ssh-multihop`（隧道）/ `db-driver`（MySQL）/ `src-tauri`（Tauri 壳）三成员；`src-tauri` 引用 workspace crate 编译通过，无需退回扁平 mod。
- 前端：Next.js 16 (Turbopack) + React 19 + Tailwind CSS 4 静态导出（`output: export` → `out/`）。
- 命令入口 `justfile`：`dev` / `build` / `check` / `lint` / `fmt` / `test` / `version` / `release` 等。
- GitHub Actions CI（macOS arm64）：`cargo fmt --check` + `clippy` + `cargo test` + 前端 build。

### ✨ 新功能

#### 多跳 SSH 隧道（crates/ssh-multihop）

- 基于 `russh 0.54` 的纯 Rust 异步 SSH 隧道，**不依赖 Tauri**，未来可独立 publish 到 crates.io。
- 支持任意 N 跳串联（OpenSSH ProxyJump 等效）：第一跳本地直连，后续每跳在前一跳的 SSH 通道上递归建立，最后一跳对目标开 `direct-tcpip`，在本地 `127.0.0.1` 绑定随机端口。
- 密码 / 私钥（含 `~` 路径展开 + passphrase）两种认证。
- 错误走稳定 i18n key（`error.ssh.*`），不向前端泄露后端语言。
- v0.1 host key 暂用 accept-all；known_hosts + TOFU 校验留 Week 3。

#### MySQL driver（crates/db-driver）

- 基于 `sqlx 0.8`（`runtime-tokio-rustls`）。v0.1 是具体 `struct`，**不抽 `trait Driver`**；v0.2 加 PostgreSQL 时再 extract trait（避免抽象提前）。
- `ping_select_1`：经「隧道本地端口 → `mysql://127.0.0.1:port`」桥接连上 MySQL 跑 `SELECT 1`，用来打通整条最小链路。

#### 前端测试连接页

- Next.js hello 页：可填 MySQL（host/port/user/password/database）+ 可选单跳 SSH 跳板，点「测试连接 (SELECT 1)」验证「前端 → tauri command → ssh-multihop → db-driver → MySQL」端到端链路。

---
