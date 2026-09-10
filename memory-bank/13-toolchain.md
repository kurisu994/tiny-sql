---
name: 13-toolchain
description: 技术栈版本矩阵、just 构建命令、CI 与发布流程（全部从真实配置提取）
paths:
  - "justfile"
  - "Cargo.toml"
  - "package.json"
  - "pnpm-workspace.yaml"
  - "src-tauri/Cargo.toml"
  - "src-tauri/tauri.conf.json"
  - ".github/workflows/**"
  - ".env.example"
---

# 工具链与构建（13-toolchain）

> 纯事实参考：版本号、命令、配置，全部从实际配置文件提取，**不猜测**。改构建 / 发版流程前读这份。

## 前端依赖（package.json — 实际已装）

| 依赖 | 版本 | 用途 |
|---|---|---|
| next | 16.1.6 | App Router + 静态导出（`output: export` → `out/`） |
| react / react-dom | 19.2.3 | UI |
| @tauri-apps/api | ^2.11.1 | IPC + event |
| @tauri-apps/cli | ^2.11.4 (dev) | tauri 命令 |
| tailwindcss + @tailwindcss/postcss | ^4.3.3 (dev) | 样式 |
| typescript | ^5.9.3 (dev) | 类型 |
| radix-ui | ^1.6.7 | shadcn 组件底层 primitives（统一包） |
| lucide-react | ^1.34.0 | 图标 |
| class-variance-authority / clsx / tailwind-merge | ^0.7 / ^2.1 / ^3.6 | shadcn 组件 variant + `cn()` className 合并 |
| tw-animate-css | ^1.4.0 | shadcn 弹窗 / 菜单动画 |
| react-virtuoso | ^4.18.12 | 结果表格虚拟滚动 |
| @tauri-apps/plugin-dialog | ^2.7.2 | 导出路径选择与证书文件浏览系统对话框 |
| codemirror / @codemirror/* | codemirror ^6.0.2；lang-sql ^6.10.0；lint ^6.9.7；state ^6.7.1；view ^6.43.9 | SQL 编辑器、MySQL 高亮、基础 schema/table 补全和错误 gutter |

> **已装**：`zustand` 5（状态）、`vitest` + `@testing-library/react`（前端单测）、CodeMirror 6、shadcn/ui 体系。
> **规划未装**：`i18next` / `react-i18next`、`sonner`（toast）、`playwright`（推迟）、`@xyflow/react`（拓扑图最终用纯 CSS）。

## 后端依赖（workspace.dependencies — 实际已装）

| 依赖 | 版本 / features | 用途 |
|---|---|---|
| tokio | 1（features = full） | 异步运行时 |
| russh | 0.54 | 纯 Rust 异步 SSH，多跳隧道 |
| sqlx | 0.8.6（default-features=false, `mysql` + `postgres` + `sqlite` + `runtime-tokio-rustls` + `chrono` + `bigdecimal` + `json`） | 三 driver 与动态结果解码 |
| tokio-util | 0.7 | `CancellationToken` 查询取消 |
| thiserror | 2 | 错误派生 |
| serde | 1（derive） | 序列化 |
| log | 0.4 | 日志 facade |

`src-tauri` 额外依赖见 [[12-tauri-shell]]。

> **规划未引入**：`sqlparser-rs`（拒多语句当前用自有 SQL 分析 / 分号状态机）。

## 工具链版本

| 项 | 值 | 来源 |
|---|---|---|
| Rust edition | 2021 | `Cargo.toml` `[workspace.package]` |
| MSRV | 1.77.2 | `rust-version` |
| Node | 见 `.nvmrc` | CI 用 Node 24 |
| pnpm | 11+ | `pnpm-workspace.yaml` |
| 应用版本 | 0.8.0 | `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`（`v0.8.0` 已发布，tag `v0.8.0` / 发布提交 `12d3aae`） |

## 构建命令（justfile，`set dotenv-load`）

| 命令 | 作用 |
|---|---|
| `just install` | `pnpm install` + `cargo fetch` |
| `just dev` / `just dev-web` | Tauri 完整开发 / 仅 Next.js |
| `just build` / `just build-web` | 桌面应用 / 前端静态导出 |
| `just check` | 提交前自检 = `fmt-check` + `lint-rust` + `test-rust` + `test-web` + `build-web`（对齐 CI） |
| `just lint` / `lint-rust` / `lint-web` | tsc + clippy / 仅 clippy / 仅 tsc |
| `just fmt` / `fmt-check` | 格式化 / 仅检查 |
| `just test` / `test-rust` | Rust workspace + 前端 Vitest / 仅 Rust workspace |
| `just test-mysql-integration` / `test-postgres-integration` | 分别连接本地 MySQL / PostgreSQL；任一显式门禁缺 URL 时明确失败 |
| `just test-integration` | 顺序执行 MySQL / PostgreSQL 两个 driver 的真实 integration（SQLite 不需要外部服务，用临时文件库并入 `just test`） |
| `just version <ver>` | 同步 package.json / Cargo.toml / tauri.conf.json 版本号 |
| `just release <tag>` | 更新版本 + CHANGELOG + commit + tag + push 触发云端构建 |

**集成测试 env**：`TINY_SQL_TEST_MYSQL_URL` / `TINY_SQL_TEST_POSTGRES_URL`（见 `.env.example`，`.env` 已忽略）。**不使用 Docker。**

**发布签名**：release workflow 依赖 `TAURI_SIGNING_PRIVATE_KEY`；无密码私钥时 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可留空。本地按 Redis 项目方式把真实私钥写入 ignored `.env`，`just build` 会加载；直接 `pnpm tauri build` 不经 justfile 注入 `.env`，仍需手动 export，且无密码私钥要显式保留 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`。

`just version` 已会同步 `Cargo.lock` 本地 package 版本，`just release` 已收窄到版本 / CHANGELOG / Cargo.lock 相关文件；**正式发版前仍必须确认工作区没有无关改动**。

## CI（.github/workflows/ci.yml）

- 单 job，**macOS arm64**，Node 24 + pnpm + Rust stable（含 clippy）。
- 步骤：`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm test` → `cargo fmt --all --check` → `cargo clippy --workspace -- -D warnings` → `cargo test --workspace`。
- **CI 不跑 integration**（无外部数据库服务器）；MySQL 5.7 已在 dogfooding 期完成验证，正式版前保留人工双 driver 回归。
- warning 即失败。

## 关键配置事实

| 项 | 值 |
|---|---|
| productName / identifier | `tiny-sql` / `com.kurisu.tiny-sql`（`tauri.conf.json`） |
| frontendDist | `../out`（Next 静态导出） |
| beforeDevCommand | `pnpm dev` |
| pnpm build script 批准 | `pnpm-workspace.yaml` 的 `allowBuilds: sharp: true`（否则 pnpm 11 的 verify-deps-before-run 会 exit 1） |
| 打包目标 | macOS arm64 / x64（`.dmg`）、Windows x64（`.exe`）、Linux x64（`.AppImage`）+ updater `.sig` 与四平台 `latest.json` |

相关：[[12-tauri-shell]] · [[20-frontend]]
