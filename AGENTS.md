# Repository Guidelines

tiny-sql 是一个多级跳板机友好的 MySQL 桌面客户端，技术栈为 Tauri 2 + Next.js 16 + Rust。本文件供贡献者（含 AI 协作）快速对齐协作约定。

## 项目结构与模块组织

- `crates/ssh-multihop/`：N 跳 SSH 隧道，基于 russh，**不依赖 Tauri**，未来可独立 publish。
- `crates/db-driver/`：MySQL driver，基于 sqlx。v0.1 是具体 `struct`，v0.2 再抽 `trait`。
- `src-tauri/`：Tauri 壳，`src/lib.rs` 放入口与 `#[tauri::command]`，配置见 `tauri.conf.json`。
- `src/app/`：前端源码（Next.js App Router），静态导出到 `out/`。
- `docs/`：需求 / 计划 / 架构 / 路线图，改动方案前先读。
- 根目录 `Cargo.toml` 是 workspace，公共依赖统一在 `[workspace.dependencies]`。

## 构建、测试与开发命令

统一通过 `just` 运行（`just` 或 `just default` 看全部）：

- `just install`：`pnpm install` + `cargo fetch`，首次准备环境。
- `just dev`：启动 Tauri 完整开发模式（前后端热重载）；`just dev-web` 仅前端。
- `just build`：生产构建桌面应用（`.dmg` / `.app`）；`just build-web` 仅前端静态导出。
- `just check`：提交前一键自检，等价 CI（`fmt-check` + `clippy` + `test` + 前端 build）。
- `just fmt` / `just lint`：格式化 Rust / 全量检查（tsc + clippy）。

## 测试规范

- Rust 单元测试用 `#[test]`，与被测代码同文件的 `#[cfg(test)] mod tests` 内；`just test`（= `cargo test --workspace`）运行。
- 连真实 MySQL 的集成测试标 `#[ignore]`，用 `just test-integration` 跑；需在 `.env` 配 `TINY_SQL_TEST_MYSQL_URL`（见 `.env.example`），**不使用 Docker**。
- 提 PR 前本地必须通过 `just check`；CI 仅在 macOS arm64 上跑，warning 即失败。

## 提交与 Pull Request 规范

- 提交信息**用中文**，格式 `[可选 emoji] 类型(可选范围): 动词开头主题`，主题 ≤ 50 字。
- 常用类型：`feat` / `fix` / `docs` / `refactor` / `perf` / `chore` / `tests` / `release`（参考 `git log`）。
- **不要**添加 `Co-authored-by`、`Generated with` 等署名。
- PR 描述说明「做了什么 / 为什么」，关联 issue；涉及 UI 改动附截图。功能变更同步更新 `CHANGELOG.md` 的 `[Unreleased]` 段。

## 编码约定

- 公共类型与函数加中文注释说明用途；复杂逻辑补行内中文注释。
- 错误对外走稳定 i18n key（如 `error.ssh.*`），不向前端泄露后端语言。
- 数据库设计**不定义 FOREIGN KEY**，表关联由代码与索引控制。

## AI 会话收尾与记忆银行

每次最终回复前，AI 必须检查本轮是否产生代码变更、重要决策、阻塞或下一步计划；如有，先更新 `memory-bank/activeContext.md`，记录当前状态、活跃文件、已做决策、下一步和阻塞。涉及里程碑、架构调整或长期约定变化时，同步更新 `memory-bank/progress.md`，最后再检查一下是否需要更新 `CHANGELOG.md`。