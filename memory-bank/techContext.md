# 技术语境（techContext）

> 纯事实参考：版本号、命令、配置，全部从实际配置文件提取，不猜测。

## 技术栈版本矩阵

### 前端（package.json — 实际已装）

| 依赖 | 版本 | 用途 |
|---|---|---|
| next | 16.1.6 | App Router + 静态导出（`output: export` → `out/`） |
| react / react-dom | 19.2.3 | UI |
| @tauri-apps/api | ^2.10.1 | IPC + event |
| @tauri-apps/cli | ^2.10.0 (dev) | tauri 命令 |
| tailwindcss + @tailwindcss/postcss | ^4 (dev) | 样式 |
| typescript | ^5 (dev) | 类型 |

> **规划未装**（按周引入）：`@xyflow/react`（拓扑图）、`react-virtuoso`（虚拟滚动）、`zustand`、`i18next`/`react-i18next`、`shadcn`/`radix-ui`、`lucide-react`、`sonner`、`vitest`、`playwright`。

### 后端 Rust（workspace.dependencies — 实际已装）

| 依赖 | 版本 / features | 用途 |
|---|---|---|
| tokio | 1（features = full） | 异步运行时 |
| russh | 0.54 | 纯 Rust 异步 SSH，多跳隧道 |
| sqlx | 0.8（default-features=false, `mysql` + `runtime-tokio-rustls`） | MySQL driver |
| thiserror | 2 | 错误派生 |
| serde | 1（derive） | 序列化 |
| log | 0.4 | 日志 facade |

`src-tauri` 额外：`tauri` 2、`tauri-plugin-log` 2、`serde_json` 1、`tauri-build` 2（build-dep）。

> **规划未引入**：`dashmap`（AppState 注册表）、`tokio-util`（CancellationToken）、`sqlparser-rs`（拒多语句）、`aes-gcm`（加密 store）、`@xyflow` 对应后端无。

### 工具链版本

| 项 | 值 | 来源 |
|---|---|---|
| Rust edition | 2021 | Cargo.toml `[workspace.package]` |
| MSRV | 1.77.2 | `rust-version` |
| Node | 见 `.nvmrc` | CI 用 Node 24 |
| pnpm | 11+ | pnpm-workspace.yaml |
| 应用版本 | 0.1.0 | package.json / src-tauri/Cargo.toml / tauri.conf.json |

## 构建命令（justfile，`set dotenv-load`）

| 命令 | 作用 |
|---|---|
| `just install` | `pnpm install` + `cargo fetch` |
| `just dev` / `just dev-web` | Tauri 完整开发 / 仅 Next.js |
| `just build` / `just build-web` | 桌面应用 / 前端静态导出 |
| `just check` | 提交前自检 = `fmt-check` + `lint-rust` + `test-rust` + `build-web`（对齐 CI） |
| `just lint` / `lint-rust` / `lint-web` | tsc + clippy / 仅 clippy / 仅 tsc |
| `just fmt` / `fmt-check` | 格式化 / 仅检查 |
| `just test` / `test-rust` | workspace 单元测试 |
| `just test-integration` | `cargo test -p db-driver -- --include-ignored`（连本地 MySQL） |
| `just version <ver>` | 同步 package.json / Cargo.toml / tauri.conf.json 版本号 |
| `just release <tag>` | 更新版本 + CHANGELOG + commit + tag + push 触发云端构建 |

## CI（.github/workflows/ci.yml）

- 单 job，**macOS arm64**，Node 24 + pnpm + Rust stable（含 clippy）。
- 步骤：`pnpm install --frozen-lockfile` → `pnpm build` → `cargo fmt --all --check` → `cargo clippy --workspace -- -D warnings` → `cargo test --workspace`。
- **CI 不跑 integration**（无 MySQL 服务器）；MySQL 5.7 兼容推到 dogfooding 验证。

## 关键配置事实

| 项 | 值 |
|---|---|
| productName / identifier | `tiny-sql` / `com.kurisu.tiny-sql`（tauri.conf.json） |
| frontendDist | `../out`（Next 静态导出） |
| beforeDevCommand | `pnpm dev` |
| pnpm build script 批准 | `pnpm-workspace.yaml` 的 `allowBuilds: sharp: true`（否则 pnpm 11 的 verify-deps-before-run 会 exit 1） |
| 集成测试 env | `TINY_SQL_TEST_MYSQL_URL`（见 `.env.example`，`.env` 已忽略） |
| 加密 store 路径（规划） | `~/Library/Application Support/tiny-sql/connections.enc`（AES-GCM） |
| known_hosts 路径（规划） | `~/Library/Application Support/tiny-sql/known_hosts.json` |

## 当前 command（src-tauri 实际）

- `test_select_1(input: ConnectInput)`：hops 空则直连，否则开隧道连本地端口，跑 `SELECT 1`。
- 规划 command（ARCHITECTURE §3.3）：`connection_create/list/update/delete/test/open/close`、`query_execute/cancel`、`ssh_tofu_decision`。

相关：[[systemPatterns]] · [[progress]]
