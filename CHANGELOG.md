# Changelog

本文件记录 tiny-sql 的所有版本变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/)，遵循[语义化版本](https://semver.org/)。

---

## [Unreleased]

### 🎨 体验调整

- 首页连接列表去掉行内「连接」按钮，改为 Navicat 式右键菜单（连接 / 断开连接 / 进入命令列界面 / 编辑连接 / 复制连接 / 删除连接）：单击选中、双击连接、右键唤出更多操作。
- 新建 / 编辑连接由右侧内联表单改为居中弹窗（shadcn `Dialog`）。
- 删除连接、SQL 写操作的二次确认从系统 `window.confirm` 统一换成 shadcn `AlertDialog`（全局命令式 confirm）。
- 更新 tiny-sql 专属应用图标，以数据库与多跳连接为主体，并重新生成 Tauri 桌面与平台图标资源。
- 左上角品牌区从文本 `tiny-sql` 替换为简化像素风 SVG logo（数据库方块 + 多跳节点）。
- 拓扑图改为纯 CSS 只读紧凑样式：无画布缩放/拖拽状态，避免连线穿节点和节点被自动放大。

### 🏗️ 工程脚手架

- 初始化 Cargo workspace：`ssh-multihop`（隧道）/ `db-driver`（MySQL）/ `src-tauri`（Tauri 壳）三成员；`src-tauri` 引用 workspace crate 编译通过，无需退回扁平 mod。
- 前端：Next.js 16 (Turbopack) + React 19 + Tailwind CSS 4 静态导出（`output: export` → `out/`）。
- 接入 shadcn/ui（radix-nova 预设、radix 基库）：新增 `components.json`、`src/lib/utils.ts`（`cn`）与 `src/components/ui/*`（dialog / alert-dialog / context-menu / button），依赖新增 `radix-ui` / `lucide-react` / `class-variance-authority` / `clsx` / `tailwind-merge` / `tw-animate-css`；暗色保持跟随系统（`prefers-color-scheme`，不切 `.dark` class），现有 `dark:` 工具类零迁移。
- 命令入口 `justfile`：`dev` / `build` / `check` / `lint` / `fmt` / `test` / `version` / `release` 等。
- 连接配置加密：复用 AES-256-GCM + master key（0600），tiny-sql 对**整个 `connections.enc` 文件**加密（满足 FR-001：明文 host/user/password 不落盘）。
- 测试基础设施：前端 `vitest` + `@testing-library/react`；`db-driver` integration 测试连本地 MySQL（`TINY_SQL_TEST_MYSQL_URL`，默认 `#[ignore]`）。
- GitHub Actions CI（macOS arm64）：`cargo fmt --check` + `clippy` + `cargo test` + `vitest` + 前端 build。
- GitHub Actions release job：`v0.1.*` tag 触发 macOS Apple Silicon + Intel、Windows x64、Linux x64 Tauri build，并在全平台产物都上传后创建 GitHub Release。
- GitHub Actions CI 对 `just release` 产生的版本号 / CHANGELOG 提交启用路径忽略，发布时只由 tag 触发 `release.yml` 打包，避免同一发布流程重复跑 `ci.yml`。
- GitHub Release notes 改为从 `CHANGELOG.md` 提取；正式版取对应版本段，RC 可直接复用 `[Unreleased]`，且 `v*-rc*` tag 自动标记为 prerelease、不设为 latest。
- GitHub Actions release job 接入 Tauri updater 签名：构建 macOS `.dmg` / `.app.tar.gz`、Windows `.exe`、Linux `.AppImage` / `.AppImage.tar.gz` 与对应 `.sig`，正式版发布时额外生成 `latest.json`；RC / beta / alpha 不生成自动更新源。
- 修复 GitHub Actions release job 上传路径：Tauri workspace 构建产物位于根目录 `target/release/bundle`，避免 `upload-artifact` 继续读取 `src-tauri/target/...` 后报 `No files were found`。
- 升级 GitHub Actions 中的 `checkout` / `setup-node` / `pnpm/action-setup` / artifact actions 到 Node 24 runtime 版本，消除 Node.js 20 deprecation warning。
- `just version` 同步刷新 `Cargo.lock` 中 `tiny-sql` 本地 package 的版本号，避免 release 提交遗漏 lockfile 版本变更。
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
- MySQL 连接默认禁用 `ssl-mode`（v0.1 不启用 MySQL TLS），避免 sqlx 默认 `PREFERRED` 在部分内网 MySQL 上触发 rustls `HandshakeFailure`；URL 显式传 `ssl-mode` 时仍尊重该配置。
- SQL 执行护栏：拒绝空 SQL / 多语句；`SELECT` / `WITH` 统一后端子查询包装并外层注入 LIMIT；表浏览传 1000 行上限，SQL 编辑器传 10w 行硬上限。
- SQL 取消：每次执行记录 MySQL `CONNECTION_ID()`，主 pool 外维护 max=1 control pool，取消时发 `KILL QUERY <id>`，不从主 pool 借连接。
- 写操作 best-effort 二次确认：非 `SELECT` / `WITH` 语句需前端传 `allowWrite=true`，否则后端返回稳定 i18n key `error.driver.write_requires_confirmation`。

#### 连接管理（src-tauri + 前端）

- 命令 `connection_create` / `connection_list` / `connection_update` / `connection_delete` / `connection_test`；配置整体加密落盘，`connection_test` 走完整链路（可选多跳 SSH + `SELECT 1`），错误以稳定 i18n key 回传。
- **持久连接**：`connection_open` / `connection_close` 把（可选）SSH 隧道 + MySQL 连接池存入 `AppState` 活跃注册表，生命周期绑定（先关 pool 后关隧道）；私钥 passphrase 首次输入后**会话内缓存**（NFR-011），下次打开静默。
- 前端：左侧连接列表 + 右侧编辑表单（`zustand`），SSH 跳板折叠区可配 N 跳（增删 / 调序）；TOFU 指纹确认、passphrase、隧道断开提示弹窗。
- 拓扑图：按“本机 → hop[0..N-1] → MySQL”绘制纯 CSS 静态链路，节点状态支持 `pending` / `connected` / `failed` / `lost`；运行期 lost 继续来自 `ssh:hop-status`，连接阶段 pending/connected/failed 由 Tauri command 补齐。
- **自动更新**：接入 `tauri-plugin-updater` + `tauri-plugin-process`，启动后每日检查一次 GitHub Release 正式版，也可手动检查；发现更新后展示版本说明、下载进度，并在安装完成后提示重启。

#### 数据浏览（src-tauri + 前端）

- 命令 `db_list_databases` / `db_list_tables` / `db_list_columns` / `db_query`（基于已打开连接）。
- 前端：左侧 database/table 树，点表以 `rowLimit=1000` 走后端子查询包装；右侧 SQL textarea 可直接执行 SQL，并显示截断提示。
- 结果表格改为 `react-virtuoso` 虚拟滚动，复用表浏览与 SQL 编辑器结果展示。
- TOFU 信任库 `known_hosts.json`（自有 store，**不碰** `~/.ssh/known_hosts`，NFR-012）。

#### 桌面打包

- 本地 `pnpm tauri build` 已产出 `/target/release/bundle/dmg/tiny-sql_0.1.0_aarch64.dmg`。

---
