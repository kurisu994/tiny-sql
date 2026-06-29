# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-06-29

## 当前状态

**Week 5 已启动（发布前 dogfooding 准备中）**。Week 1-4 的 SQL 执行、拓扑图、虚拟滚动和 macOS 打包已落地，本轮完成了 dogfooding 入口文档与自动化验证：

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
- ✅ 代码状态：本地 `main` 有未 push 提交；本轮 Week 5 dogfooding 与发布准备均已纳入本地提交。
- ✅ Week 5 启动文档：README 已更新到 dogfooding 口径，新增 `docs/dogfooding-log.template.md`；本地实际记录 `docs/dogfooding-log.md` 被 `.gitignore` 忽略，不进入公开仓库。
- ✅ Week 5 自动化验证：`just check` 通过；`just test-integration` 在沙箱外连接 `.env` MySQL 后 4 个 integration 全部通过；`just build` 在沙箱外成功产出 `.app` 和 `.dmg`。
- ✅ Week 5 发布准备：release workflow 已改为 macOS Apple Silicon + Intel 双构建；新增 `docs/RELEASE_CHECKLIST.md` 约束 RC、同事试用、正式发布和延期规则。
- ✅ Week 5 发布准备提交范围：`.github/workflows/release.yml`、`docs/RELEASE_CHECKLIST.md`、`CHANGELOG.md`、`README.md`、`memory-bank/*`。

## 活跃文件

- `crates/db-driver/src/lib.rs` — SQL 分析/包装、10w 上限、control pool + `KILL QUERY`、写操作确认。
- `src-tauri/src/{state.rs,commands/query.rs,commands/connection.rs}` — query token 注册表、`db_query_cancel`、hop status 四态事件。
- `src/components/{schema-browser,topology-graph,connection-dialogs}.tsx` — SQL 面板、虚拟滚动表格、拓扑图、事件监听 runtime guard。
- `public/logo.svg` + `src/app/page.tsx` — 左上角品牌 logo。
- `src/stores/{session-store,connection-store}.ts` + `src/lib/{tauri-api,sql-guard}.ts` — 会话状态、SQL guard、Tauri API 参数与 Web 预览降级。
- `.github/workflows/release.yml` — `v0.1.*` tag 构建 macOS Apple Silicon + Intel `.dmg`，再统一创建 GitHub Release。
- `README.md` + `docs/dogfooding-log.template.md` — Week 5 dogfooding 说明、macOS 首次打开说明与脱敏记录模板。
- `docs/RELEASE_CHECKLIST.md` + `CHANGELOG.md` — v0.1 RC/正式发布检查、双架构 release 说明。

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
- 沿用：整体文件加密、playwright 推迟、移除 test_select_1。

## 下一步（Week 5）

1. Dogfooding：安装/运行最新本地 `.dmg`，用真实 3 跳 SSH + MySQL 验证连接、TOFU、passphrase、表浏览、SQL 执行、取消和拓扑状态。
2. CP-4：应用稳定运行 ≥30 分钟；至少 10 条 SQL（SELECT/JOIN/聚合/长查询取消）；故意断中间跳验证 180s 内 lost。
3. README/GIF 与发布准备：补真实右键打开 GIF、3 跳拓扑 GIF；tag `v0.1.0-rc1` 后验证 GitHub Release 的 Apple Silicon + Intel 两个 `.dmg`。
4. CP-3：找 MySQL 5.7 环境完成连接与 SELECT 验证。

## 阻塞 / 待确认

- **CP-4 GUI/dogfooding 仍待真实环境**：本轮只做静态验证、浏览器首屏目检和本地 .dmg 打包；未连真实 3 跳 SSH/MySQL，也未验证 `SHOW PROCESSLIST` 中 KILL 后 query 消失。
- **CP-3** MySQL 5.7 兼容仍留 Week 5 dogfooding。
- README 中仍缺真实 GIF；当前仅补了文字说明和试用 checklist。
- 未执行 `git fetch`，远端实时状态未刷新；按当前本地跟踪分支看本地提交尚未 push。

相关：[[progress]] · [[systemPatterns]]
