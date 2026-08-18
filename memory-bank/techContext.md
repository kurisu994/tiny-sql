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
| radix-ui | ^1.6.0 | shadcn 组件底层 primitives（统一包） |
| lucide-react | ^1.21.0 | 图标 |
| class-variance-authority / clsx / tailwind-merge | ^0.7 / ^2.1 / ^3.6 | shadcn 组件 variant + `cn()` className 合并 |
| tw-animate-css | ^1.4.0 | shadcn 弹窗 / 菜单动画 |
| react-virtuoso | ^4.18.9 | 结果表格虚拟滚动 |
| codemirror / @codemirror/* | codemirror ^6.0.2；lang-sql ^6.10.0；lint ^6.9.7；state ^6.7.0；view ^6.43.4 | SQL 编辑器、MySQL 高亮、基础 schema/table 补全和错误 gutter |

> **已装**：`zustand` 5（状态）、`vitest` + `@testing-library/react`（前端单测）、`react-virtuoso`（虚拟滚动）、CodeMirror 6 SQL 编辑器、shadcn/ui 体系（`shadcn` CLI + `radix-ui` + `lucide-react` + `class-variance-authority` + `clsx` + `tailwind-merge` + `tw-animate-css`）。
> **规划未装**：`i18next`/`react-i18next`、`sonner`（toast）、`playwright`（推迟）、`@xyflow/react`（拓扑图最终用纯 CSS）。

### 后端 Rust（workspace.dependencies — 实际已装）

| 依赖 | 版本 / features | 用途 |
|---|---|---|
| tokio | 1（features = full） | 异步运行时 |
| russh | 0.54 | 纯 Rust 异步 SSH，多跳隧道 |
| sqlx | 0.8.6（default-features=false, `mysql` + `postgres` + `runtime-tokio-rustls` + `chrono` + `bigdecimal` + `json`） | MySQL/PostgreSQL driver 与动态结果解码；`sqlx-postgres` 为 MIT OR Apache-2.0 |
| tokio-util | 0.7 | `CancellationToken` 查询取消 |
| thiserror | 2 | 错误派生 |
| serde | 1（derive） | 序列化 |
| log | 0.4 | 日志 facade |

`src-tauri` 额外：`tauri` 2、`tauri-plugin-log` 2、`tauri-plugin-updater` 2、`tauri-plugin-process` 2、`serde_json` 1、`aes-gcm` 0.10 + `base64` 0.22（加密 store）、`uuid` 1（连接 id）、`chrono` 0.4（最近使用时间戳）、`tauri-build` 2（build-dep）。

> **AppState 注册表**实际用 `std`/`tokio` 的 `Mutex<HashMap>` 而非 `dashmap`（够用、少依赖）。
> **规划未引入**：`sqlparser-rs`（拒多语句当前用自有 SQL 分析 / 分号状态机）。

### PostgreSQL v0.2 版本基线

- **正式支持范围**：PostgreSQL 15-18；最低支持大版本为 PostgreSQL 15。
- **必测矩阵**：最低支持大版本 `15.latest` + 当前最新稳定大版本 `18.latest`，始终使用各自最新 minor；截至 2026-08-18 对应 15.18 / 18.4。
- **中间版本**：PostgreSQL 16 / 17 属于正式支持范围，不要求每轮重复跑 integration；用最低版本与最新稳定版本的双端点回归覆盖公共协议、metadata、query 与 cancel 契约。
- **旧版本策略**：PostgreSQL 14 及以下仅 best-effort 兼容，不纳入正式支持承诺，也不在连接阶段主动阻止。
- **新版本策略**：开发版 / Beta 不进入基线；若 v0.2 RC 前 PostgreSQL 19 正式发布，则增加一次最新 GA 发布回归，但不改变 v0.2 的最低支持版本。
- **测试环境**：通过 `TINY_SQL_TEST_POSTGRES_URL` 连接用户本地实例，不引入 Docker；CI 仍只跑无外部数据库的单元测试。

### 工具链版本

| 项 | 值 | 来源 |
|---|---|---|
| Rust edition | 2021 | Cargo.toml `[workspace.package]` |
| MSRV | 1.77.2 | `rust-version` |
| Node | 见 `.nvmrc` | CI 用 Node 24 |
| pnpm | 11+ | pnpm-workspace.yaml |
| 应用版本 | 0.1.0 | package.json / Cargo.lock / src-tauri/Cargo.toml / tauri.conf.json |

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
| `just test-integration` | 顺序执行两个 driver 的真实 integration |
| `just version <ver>` | 同步 package.json / Cargo.toml / tauri.conf.json 版本号 |
| `just release <tag>` | 更新版本 + CHANGELOG + commit + tag + push 触发云端构建 |

2026-08-18 本地真实门禁：MySQL 5/5、PostgreSQL 4/4 全绿；覆盖 ping、metadata、NULL/日期/数值/JSON、写确认和原生取消。PostgreSQL 15/18 双端点仍属于正式发布兼容矩阵，不由单一本地实例替代。

## CI（.github/workflows/ci.yml）

- 单 job，**macOS arm64**，Node 24 + pnpm + Rust stable（含 clippy）。
- 步骤：`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm test` → `cargo fmt --all --check` → `cargo clippy --workspace -- -D warnings` → `cargo test --workspace`。
- **CI 不跑 integration**（无外部数据库服务器）；MySQL 5.7 已在 dogfooding 期完成验证，后续正式版前保留人工双 driver 回归。
- `v0.1.0` Release workflow run `32110227419` 于 2026-08-18 成功并上传全平台安装包、签名产物与四平台 `latest.json`；tag 指向 `624b108`。

## 关键配置事实

| 项 | 值 |
|---|---|
| productName / identifier | `tiny-sql` / `com.kurisu.tiny-sql`（tauri.conf.json） |
| frontendDist | `../out`（Next 静态导出） |
| beforeDevCommand | `pnpm dev` |
| pnpm build script 批准 | `pnpm-workspace.yaml` 的 `allowBuilds: sharp: true`（否则 pnpm 11 的 verify-deps-before-run 会 exit 1） |
| 集成测试 env | `TINY_SQL_TEST_MYSQL_URL` / `TINY_SQL_TEST_POSTGRES_URL`（见 `.env.example`，`.env` 已忽略） |
| 加密 store 路径 | `~/Library/Application Support/tiny-sql/{connections.enc, master.key}`（AES-GCM，整体加密） |
| 连接 driver 持久化值 | `mysql` / `postgresql`；旧记录缺字段默认 `mysql`，兼容读取不主动重写密文 |
| known_hosts 路径 | `~/Library/Application Support/tiny-sql/known_hosts.json`（明文，自有库，不碰 `~/.ssh`，NFR-012） |

## 当前 command（src-tauri 实际）

- 连接：`connection_create/list/update/delete`（CRUD）、`connection_test(input, passphrase?)`（一次性完整链路测试，passphrase 不缓存）、`connection_open/close`（按 driver 建立持久连接，存 `ActiveDriver` 注册表）。
- 数据浏览：`db_list_databases/db_list_schemas/db_list_tables/db_list_columns/db_query/db_query_cancel/db_create_database`（基于已打开连接；table/column 接受可选 schema，CREATE DATABASE 当前仅 MySQL 支持）。
- TOFU：`ssh_tofu_decision(connectionId, hopIndex, accept)`。
- 事件（后端 emit → 前端 listen）：`ssh:tofu-request`（指纹确认）、`ssh:hop-status`（keepalive 断开）。

相关：[[systemPatterns]] · [[progress]]
