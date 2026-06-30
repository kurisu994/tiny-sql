# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-06-30

## 当前状态

**Week 5 进行中（正式版发布准备 + 自动更新已接入，dogfooding 待完成）**。Week 1-4 的 SQL 执行、拓扑图、虚拟滚动和 macOS 打包已落地；连接管理交互已改成 Navicat 风格并接入 shadcn/ui。本轮在确认“自动更新只跟随正式版、RC 不作为更新源”后，把 `tauri-plugin-updater` 接入 v0.1：应用启动后每日检查一次 GitHub latest 正式版，左侧工具区可手动检查，release workflow 生成 signed updater artifact 和正式版 `latest.json`。随后收敛发布触发链路：`just release` 推送版本提交时不再重复触发 `ci.yml`，后续由 tag push 触发 `release.yml` 打包发布。

- ✅ 连接列表交互重做：去掉行内「连接」按钮，改右键菜单（连接 / 断开 / 进入命令列界面 / 编辑 / 复制 / 删除）+ 单击选中 + 双击连接；新建/编辑改 shadcn `Dialog` 弹窗；删除与写操作确认从 `window.confirm` 换成 shadcn `AlertDialog`（全局 `confirm-store`）。
- ✅ 接入 shadcn/ui（radix-nova、radix 基库）：`components.json` + `src/lib/utils.ts` + `src/components/ui/*`；暗色保持 `prefers-color-scheme` 跟随系统（不切 `.dark` class），还原 system 中文字体栈（移除 init 引入的 Geist Google 字体）。
- ✅ 自动更新：后端注册 `tauri-plugin-updater` / `tauri-plugin-process`；前端新增 `updateApi`、`useUpdateChecker` 和 `UpdateDialog`；release workflow 用 `TAURI_SIGNING_PRIVATE_KEY` 签名 `.app.tar.gz`，正式版生成 `latest.json`，RC / beta / alpha 跳过。
- ✅ 发布触发分流：`ci.yml` 对 `just release` 产生的版本号 / CHANGELOG 提交启用 `paths-ignore`，`just release` 同步暂存 `Cargo.lock`；tag push 仍由 `release.yml` 执行双架构打包和 GitHub Release。
- ✅ 验证：`just check` 全绿；`just build` 在沙箱外从本地 `.env` 加载 updater 私钥通过，产出 `.dmg`、`.app.tar.gz` 和 `.sig`；`.github/workflows/release.yml` YAML 解析通过；未把私钥内容写入仓库。
- ✅ GitHub Release workflow 首次云端上传失败已修复：Tauri workspace 构建产物在根目录 `target/release/bundle/...`，`release.yml` 的重命名和 `upload-artifact` 已改为读取该路径；下一步重跑失败的 tag workflow 验证。
- ✅ GitHub Actions Node 20 deprecation warning 已处理：`ci.yml` / `release.yml` 中的 `checkout`、`setup-node`、`pnpm/action-setup`、`upload-artifact`、`download-artifact` 已升级到声明 `runs.using: node24` 的版本。

此前 Week 5 dogfooding 准备同样完成（保留）：

- ✅ SQL 执行护栏：拒空 SQL / 多语句；`SELECT` / `WITH` 后端子查询包装；表浏览 `rowLimit=1000`，SQL 编辑器 `rowLimit=100000`。
- ✅ SQL 取消：每次执行取 MySQL `CONNECTION_ID()`；`MySqlDriver` 主 pool 外新增 max=1 control pool，取消时发 `KILL QUERY <id>`。
- ✅ 写操作 best-effort 二次确认：前端 `needsWriteConfirmation` 忽略字符串/注释/反引号标识符，后端仍强制 `allowWrite=true` 才执行非 SELECT。
- ✅ 拓扑图：纯 CSS 线性布局画本机 → N 跳 → MySQL；Tauri 连接阶段补 `pending/connected/failed`，运行期 keepalive 继续上报 `lost`。
- ✅ 拓扑图视觉修正：移除 React Flow 画布，避免缩放/拖拽状态、默认控制点、attribution 和自动放大；只保留固定尺寸节点与直线连接。
- ✅ MySQL 连接默认禁用 TLS：修复 sqlx 默认 `ssl-mode=PREFERRED` 在内网 MySQL 上触发 rustls `HandshakeFailure` 的问题；真实 `TINY_SQL_TEST_MYSQL_URL` integration 全部通过。
- ✅ 结果表格：`react-virtuoso` 虚拟滚动，表浏览与 SQL 编辑器复用。
- ✅ 品牌区：首屏左上角 `tiny-sql` 文本已替换为简化像素风 `public/logo.svg`（数据库方块 + 多跳节点）。
- ✅ 打包：`pnpm tauri build` 产出 `target/release/bundle/dmg/tiny-sql_0.1.0_aarch64.dmg`。
- ✅ 验证：`just check` 全绿（fmt-check + clippy + cargo test + vitest 17 + Next build）；浏览器首屏目检通过（普通 Web 下 Tauri runtime guard 无 IPC 错误）。
- ✅ 代码状态：本地 `main` 干净，Week 5 dogfooding、发布准备和连接管理 UI 文档同步均已纳入本地提交；未执行 `git fetch`，远端实时状态仍需发版前刷新。
- ✅ Week 5 启动文档：README 已更新到 dogfooding 口径，新增 `docs/dogfooding-log.template.md`；本地实际记录 `docs/dogfooding-log.md` 被 `.gitignore` 忽略，不进入公开仓库。
- ✅ Week 5 自动化验证：`just check` 通过；`just test-integration` 在沙箱外连接 `.env` MySQL 后 4 个 integration 全部通过；`just build` 在沙箱外成功产出 `.app` 和 `.dmg`。
- ✅ Week 5 发布准备：release workflow 已改为 macOS Apple Silicon + Intel 双构建；GitHub Release notes 会从 `CHANGELOG.md` 提取（正式版取对应版本段，RC 可复用 `[Unreleased]`）；`v*-rc*` tag 会标记为 prerelease 且不设为 latest；正式版额外发布 updater `latest.json`；新增 `docs/RELEASE_CHECKLIST.md` 约束 RC、同事试用、正式发布和延期规则。
- ✅ Week 5 发布准备提交范围：`.github/workflows/release.yml`、`docs/RELEASE_CHECKLIST.md`、`CHANGELOG.md`、`README.md`、`memory-bank/*`。

## 活跃文件

- `crates/db-driver/src/lib.rs` — SQL 分析/包装、10w 上限、control pool + `KILL QUERY`、写操作确认。
- `src-tauri/src/{state.rs,commands/query.rs,commands/connection.rs}` — query token 注册表、`db_query_cancel`、hop status 四态事件。
- `src/components/{schema-browser,topology-graph,connection-dialogs}.tsx` — SQL 面板、虚拟滚动表格、拓扑图、事件监听 runtime guard。
- `public/logo.svg` + `src/app/page.tsx` — 左上角品牌 logo。
- `src/stores/{session-store,connection-store}.ts` + `src/lib/{tauri-api,sql-guard}.ts` — 会话状态、SQL guard、Tauri API 参数与 Web 预览降级。
- `.github/workflows/{ci.yml,release.yml}` — `ci.yml` 忽略 release-only 版本提交，两个 workflow 的官方 actions 已升级到 Node 24 runtime；`release.yml` 监听 `v0.1.*` tag 构建 macOS Apple Silicon + Intel `.dmg` / `.app.tar.gz` / `.sig`，再统一创建 GitHub Release；正式版生成 `latest.json`，RC 不生成自动更新源。
- `justfile` — `release` 版本提交暂存 `Cargo.lock`，避免 tag 对应版本与 lockfile 状态不一致。
- `README.md` + `docs/dogfooding-log.template.md` — Week 5 dogfooding 说明、macOS 首次打开说明与脱敏记录模板。
- `docs/RELEASE_CHECKLIST.md` + `CHANGELOG.md` — v0.1 RC/正式发布检查、双架构 release、updater 签名与 stable-only 自动更新说明。
- `.env`（ignored）+ `.env.example` — 本地 updater 签名变量；`.env` 已按 Redis 项目格式写入真实私钥，`.env.example` 只保留空占位。
- `src-tauri/{Cargo.toml,tauri.conf.json,capabilities/default.json,src/lib.rs}` — Tauri updater/process 插件、updater 公钥、GitHub latest endpoint、权限配置。
- `src/lib/tauri-api.ts` + `src/hooks/use-update-checker.ts` + `src/components/update-dialog.tsx` — 前端 updater API、每日/手动检查逻辑、下载安装弹窗。
- `src/components/ui/{dialog,alert-dialog,context-menu,button}.tsx` + `src/lib/utils.ts` — shadcn/ui 组件与 `cn`。
- `src/components/confirm-dialog.tsx` + `src/stores/confirm-store.ts` — 全局命令式确认弹窗（替代 `window.confirm`）。
- `src/app/{page.tsx,globals.css,layout.tsx}` — 连接列表右键菜单 + 表单弹窗、shadcn 主题变量（暗色跟随系统）、字体还原。
- `src/components/{schema-browser,connection-form}.tsx` — 写操作 / 删除确认改用全局 confirm。

## 近期已做决策

- **ssh-multihop 保持不依赖 Tauri**：ARCHITECTURE 原设计 `SshTunnelContext { app_handle }` 会耦合 Tauri，改用 `TunnelContext` 注入闭包（HostKeyVerifier + 状态回调），由 src-tauri 接事件总线——honor「可独立 publish」不变量。
- **keepalive 用 russh 内置机制**：`keepalive_interval=60s`+`keepalive_max=2`（第 3 次未响应即 180s 断），监控 task 仅探测 session 死亡后上报，持锁短不卡末跳 accept loop。
- **指纹拒绝区分 mismatch/reject**：`HostKeyDecision::Reject{mismatch}` + handler `reject_slot` 在握手失败后还原精确错误。
- **passphrase 单值应用到全部私钥跳**（v0.1 简化），按 connection_id 会话缓存（NFR-011）。
- **表浏览和 SQL 编辑器共用 `db_query`**：通过 `rowLimit` 区分 1000 行预览与 10w SQL 编辑器硬上限，不再由前端拼临时 `LIMIT 1000`。
- **control pool 不从主 pool 借连接**：v0.1 用同一 host/port（SSH 时同一本地 listener）开独立 max=1 pool，满足 pool 满时仍可发 KILL；“独立本地端口”留后续按 dogfooding 反馈再强化。
- **v0.1 不启用 MySQL TLS**：`db-driver` 默认把 sqlx `ssl-mode` 设为 `Disabled`；`connect_url` 在 URL 显式传 `ssl-mode` 时仍尊重配置，避免内网 MySQL 声明 SSL 能力但 rustls 握手失败。
- **普通 Web 预览不报 Tauri IPC 错误**：无 `window.__TAURI_INTERNALS__` 时连接列表降级为空，Tauri 事件监听跳过；Vitest 仍走 mock invoke。
- **release workflow 拆成双构建 + 单发布**：`macos-15` 产 Apple Silicon `.dmg`，`macos-15-intel` 产 Intel `.dmg`，最后由单独 `release` job 等两个 artifact 都下载后再创建 GitHub Release，避免并发创建同一个 release。
- **Release notes 以 CHANGELOG 为准**：publish job checkout 后优先从 `CHANGELOG.md` 的 `## [${version}]` 段提取 notes；预发布 tag 找不到独立版本段时改用 `[Unreleased]`，最后才降级为 `tiny-sql ${GITHUB_REF_NAME}`；RC tag 自动带 `--prerelease --latest=false`。
- **自动更新只跟随正式版**：updater endpoint 固定 GitHub latest release 的 `latest.json`；workflow 对 `v*-rc*` / beta / alpha 只上传构建产物，不生成 `latest.json`，避免旧正式版升级到 RC。
- **Tauri updater 签名不等于 Apple Developer 代码签名**：v0.1 仍无 notarization，README 继续保留右键打开 / `xattr -cr`；updater minisign 只用于校验更新包完整性。
- **CI 重命名 updater artifact**：Tauri 默认产物名为 `tiny-sql.app.tar.gz`，双架构会同名；release workflow 按 `matrix.arch` 重命名为 `*_arm64.app.tar.gz` / `*_x64.app.tar.gz` 后再生成平台清单。
- **release-only push 不跑 CI**：`just release` 会先 push 版本提交再 push tag；`ci.yml` 只在该分支 push 全部改动都属于版本号 / CHANGELOG / lockfile 时跳过，避免发布流程同时跑 CI 和 Release。普通 PR 仍不启用 `paths-ignore`，继续跑完整 CI。
- **本地 Tauri build 也需要 signing env**：`bundle.createUpdaterArtifacts=true` 后，本地构建必须提供 `TAURI_SIGNING_PRIVATE_KEY`；按 Redis 项目方式把真实私钥放入 ignored `.env`，通过 `just build` 由 justfile 自动加载。直接跑 `pnpm tauri build` 不会经 just 注入 `.env`，需先手动 export；无密码私钥也要保留 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`。
- **接入 shadcn/ui（radix-nova）而非自研弹窗**：确认框用 `AlertDialog`、表单用 `Dialog`、右键菜单用 `ContextMenu`，统一交互与无障碍；保留命令式 `confirm-store` 包一层，让多处 `await confirm()` 调用最省事。
- **暗色保持 `prefers-color-scheme` 跟随系统**：shadcn init 默认把暗色切到 `.dark` class，会让现有满屏 `dark:` 失效；改回 media 策略并把 shadcn 变量塞进 `@media`，现有 `dark:` 零迁移、无需 JS、无闪烁。
- **还原 system 中文字体栈**：移除 init 引入的 Geist（`next/font/google`），避免 Tauri 构建期联网拉字体且更适配中文。
- 沿用：整体文件加密、playwright 推迟、移除 test_select_1。

## 下一步（Week 5）

1. 重跑失败的 tag workflow，确认 GitHub Release 里 Apple Silicon + Intel 两个 `.dmg` / `.app.tar.gz` / `.sig` 都存在，RC 标记为 prerelease 且没有 `latest.json`。
2. RC 前：把 `.env` 中的 updater 私钥内容配置到 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`；无密码私钥时 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可留空。刷新远端状态，确认工作区只含发布相关改动；跑 `just check`、`just test-integration`、`just build`，并用本地 `.dmg` 做 GUI smoke。
3. 后续 RC：若需要新 RC tag，先发 `v0.1.0-rcN`，验证版本提交没有重复触发 `ci.yml`，并确认双架构产物齐全。
4. Dogfooding：安装 RC，用真实 3 跳 SSH + MySQL 验证连接、TOFU、passphrase、表浏览、SQL 执行、取消和拓扑状态；应用稳定运行 ≥30 分钟，至少 10 条 SQL，故意断中间跳验证 180s 内 lost。
5. 同事试用：作者 + 2 位同事各试用 1 周，每人至少 5 条反馈；至少 1 位同事覆盖 MySQL 5.7 连接与 SELECT 验证。
6. 正式发布：修完 P0/P1 后把 `CHANGELOG.md` 从 `[Unreleased]` 切出 `0.1.0`，README 明确下载/右键打开/无 Apple Developer 代码签名/真实 GIF 状态，再打 `v0.1.0`；发布后从旧版本手动检查更新，验证能发现正式版并安装重启。

## 阻塞 / 待确认

- **连接列表新交互待真实 GUI 验证**：右键菜单 → 编辑/删除弹窗的焦点、以及「表单弹窗内再叠确认弹窗」的层叠手感只过了 `tsc` / `next build` 静态验证，未在 Tauri 实机点过。
- **自动更新端到端待云端验证**：本地已生成 updater tar/signature，但尚未通过 GitHub Actions 双架构 release 生成真实 `latest.json`，也尚未从旧版本验证应用内更新。
- **CP-4 GUI/dogfooding 仍待真实环境**：本轮只做静态验证、浏览器首屏目检和本地 .dmg 打包；未连真实 3 跳 SSH/MySQL，也未验证 `SHOW PROCESSLIST` 中 KILL 后 query 消失。
- **CP-3** MySQL 5.7 兼容仍留 Week 5 dogfooding。
- README 中仍缺真实 GIF；当前仅补了文字说明和试用 checklist。
- 尚未发 `v0.1.0-rc1`，也尚未验证云端 release workflow 的双架构产物。
- GitHub Release workflow bundle 路径已修复，仍需通过真实 GitHub Actions 重跑验证双架构产物上传。
- GitHub Actions Node 24 action 升级已做本地 YAML 校验，仍需通过真实 GitHub Actions run 验证 marketplace action 版本可用性与 artifact 兼容性。
- `just release` 已收窄暂存范围；发版前仍需确认 dirty worktree 中没有无关文件，避免把非发布改动留到 release commit 前后造成混淆。
- 未执行 `git fetch`，远端实时状态未刷新；发 RC/正式版前需要刷新并确认 tag 不冲突。

相关：[[progress]] · [[systemPatterns]]
