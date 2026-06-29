# 进度（progress）

> 面向历史回溯：发生了什么、为什么变。重大架构变更记日期。

## 版本发布历史

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.1.0 | 🚧 开发中（Week 5 dogfooding 已启动） | MySQL + 3 跳 SSH + 拓扑图 + macOS only，预期 2026-08 月初发布 |
| v0.2 | 规划 | PG driver + 自动更新 + passphrase 加密 + TLS + Schema-aware 联想 |
| v0.3+ | 规划 | Win/Linux + crate 独立 publish + 多集群 diff |

CHANGELOG 当前全部在 `[Unreleased]` 段（Week 1-4：脚手架 + 加密 store + 多跳 SSH（keepalive/错误模型/TOFU）/ MySQL driver / 连接管理 / 数据浏览 / SQL 执行与取消 / 拓扑图 / .dmg 打包 + 测试基建 + 应用图标更新）。

## 开发阶段完成度（5-6 周计划）

| 周 | 内容 | 状态 |
|---|---|---|
| Week 1 | vertical slice（workspace + 单跳 SSH + sqlx SELECT 1 + hello 页） | ✅ 静态验证完成，CP-1b 待用户 GUI smoke |
| Week 2 | 测试基础设施 + `MySqlDriver` struct + 加密 store + 连接管理 UI | ✅ 静态验证完成（playwright E2E 推迟；CP-2 工时未记录） |
| Week 3 | 多跳 SSH + keepalive + 错误模型三变体 + TOFU + 表浏览 | ✅ 静态验证完成（CP-1b 待 GUI smoke：3 跳/TOFU/180s lost） |
| Week 4 | SQL 执行（子查询包装 + KILL QUERY）+ 拓扑图 + .dmg | ✅ 静态验证完成（真实 SSH/MySQL dogfooding 待 Week 5） |
| Week 5 | dogfooding + 修 bug + README/GIF + tag v0.1.0 | 🚧 已启动（README/日志模板/自动化验证完成；真实环境待测） |
| Week 6 / 7 | 缓冲 / launch（V2EX + 掘金） | ⬜ |

## Git 提交历史

| commit | 内容 |
|---|---|
| `8a902c6` | docs: v0.1 工程文档（需求/计划/架构/路线图） |
| `a1cc3ef` | feat: Week 1 vertical slice — 单跳 SSH + sqlx SELECT 1 |
| `0fe1a5c` / `2494cf5` | docs: README/CHANGELOG/AGENTS、memory-bank 初始化 |
| `d0973ef` | docs: 添加 MIT LICENSE |
| `525e769` | feat(db-driver): MySqlDriver 与元数据/结果集查询 |
| `6395092` | feat(config): 加密 store 与连接配置 CRUD |
| `ac6cef6` | feat(commands): connection CRUD/测试连接命令与 AppState |
| `0f758aa` | feat(ui): 连接管理列表与编辑表单 |
| `97711dd` | tests(db-driver): integration 测试连本地 MySQL |
| `0bbd9b5` | tests(web): vitest 前端单测与 CI/justfile 接入 |
| `4bcd298` | docs: 更新 CHANGELOG 与 memory-bank 反映 Week 2 |
| `d855e2c` | feat(icon): 更新 tiny-sql 应用图标 |
| `321ce0a` | feat(ssh): 错误模型补 hop_index/三 mid-session 变体 + keepalive |
| `a8cddc4` | feat(conn): 持久连接注册表 + TOFU 校验 + schema/query 命令 |
| `43706a3` | feat(ui): SSH 多跳表单 + TOFU/passphrase 弹窗 + schema 浏览 |
| `4e32edd` | feat: 完成 Week 4 SQL 执行与拓扑图 |
| `d6a625f` | fix: 修复 MySQL TLS 与拓扑图布局 |
| `HEAD` | docs: 启动 Week 5 dogfooding |

> 注：`d0973ef`（含）之前已 push 到远端 `git@github.com:kurisu994/tiny-sql.git`；
> 当前本地 `main` 较本地跟踪的 `origin/main` ahead 1（本轮提交尚未 push）；未执行 `git fetch`，远端实时状态以 GitHub 为准。

## 重大决策与架构变更记录

- **2026-06-26 选 Approach B（Clean Workspace）**：放弃 fork redis-desktop-client，改独立 workspace + 独立 crate。理由：长期维护 + `ssh-multihop` 未来独立 publish。
- **2026-06-26 plan-eng-review 9 个 binding 决策**：keepalive 30s→60s+3 次阈值 / SQL 取消用独立 control conn KILL QUERY / `SshTunnelError` 加 TunnelLost+ChannelDropped+AcceptLoopDied / trait Driver 推 v0.2 / 测试无 Docker 连本地 MySQL / LIMIT 用子查询包装 / **Week 1 改 vertical slice** / read-only best-effort / Codex tension 记 v0.2。
- **2026-06-26 文档全量改 draft-2**：4 篇 docs 落地上述 9 决策，PLAN.md 重写（Week 1 = vertical slice）。
- **2026-06-27 Week 2 整体文件加密**：连接配置用整个 `connections.enc` 文件 AES-GCM 加密（强于 redis-desktop-client 的逐字段加密），满足 FR-001（host/user 也不明文）。
- **2026-06-27 playwright E2E 推迟**：Tauri WebDriver 不支持 macOS（CI 是 macOS arm64）。Week 2 测试基建改用 vitest（前端单测）+ db-driver integration（连本地 MySQL）进 CI，E2E 留将来 Linux CI / dogfooding。
- **2026-06-27 应用图标专属化**：原图标来自其他项目，不适配 tiny-sql；按 `tauri-icon` 流程生成数据库 + 多跳连接主题图标，更新 `src-tauri/icons/` 全平台资源，并在 `CHANGELOG.md` 记录用户可见变化。
- **2026-06-27 Week 3 ssh-multihop 不依赖 Tauri**：ARCHITECTURE 原设计 `SshTunnelContext { app_handle: tauri::AppHandle }` 与「ssh-multihop 可独立 publish」不变量冲突；改为 `TunnelContext` 注入回调闭包（`HostKeyVerifier` + `HopStatusCallback`），Tauri 事件总线接线全留在 src-tauri。指纹经预计算字符串跨边界，src-tauri 无需依赖 russh/ssh_key。
- **2026-06-27 Week 3 keepalive 用 russh 内置机制**：`Config.keepalive_interval=60s` + `keepalive_max=2`（russh 判据 `alive_timeouts > max`，故第 3 次未响应即 180s 断），每跳监控 task 仅在 session 已死时 `send_keepalive` 返回 Err 后上报 `ssh:hop-status`，持锁短不卡末跳 accept loop。
- **2026-06-27 Week 3 1000 行普通表格**：react-virtuoso 虚拟滚动留 Week 4 的 10w 行硬上限再引入，Week 3 1000 行用普通滚动表格即可（避免提前加依赖）。
- **2026-06-27 Week 4 SQL 执行收口在后端**：`db_query` 增加 `rowLimit/queryId/allowWrite`，`db-driver` 负责拒多语句、子查询包装、10w 截断、写操作确认和 `KILL QUERY`；前端只做二次确认提示。
- **2026-06-27 Week 4 拓扑图四态事件**：`ssh:hop-status` 扩展为 `pending/connected/failed/lost`，连接阶段由 Tauri command 补事件，运行期 lost 仍由 `ssh-multihop` 回调上报，保持 crate 不依赖 Tauri。
- **2026-06-27 Week 4 本地 .dmg 产出**：`pnpm tauri build` 已生成 `target/release/bundle/dmg/tiny-sql_0.1.0_aarch64.dmg`；CI release workflow 使用 GitHub 官方 `macos-15` arm64 runner。
- **2026-06-29 Week 5 dogfooding 启动**：README 更新到发布前试用口径，新增脱敏 `docs/dogfooding-log.template.md`，本地忽略的 `docs/dogfooding-log.md` 记录验证；`just check`、沙箱外 `just test-integration`、沙箱外 `just build` 均通过。

## 已解决的阻碍

| 问题 | 根因 | 解决 |
|---|---|---|
| sqlx feature 报错 | 写成 `rustls`，sqlx 0.8 无此 feature | 改 `runtime-tokio-rustls` |
| `pnpm build` exit 1 | pnpm 11 `verify-deps-before-run` 因 sharp 构建脚本未批准而 exit | `pnpm-workspace.yaml` 加 `allowBuilds: sharp: true`（pnpm 11 读 workspace.yaml 而非 package.json） |
| `tauri::Manager` unused 警告 | `app.handle()` 是 inherent 方法 | 删除 import |
| CP-1（Tauri+workspace 摩擦，Week 1 最大风险） | — | 已验证通过，`cargo check --workspace` 正常引用 crate |
| Turbopack 在沙箱内 build 失败 | Next/Turbopack 处理 CSS 时需创建子进程并绑定本地端口，沙箱返回 `Operation not permitted` | `just check` / `pnpm tauri build` 在沙箱外重跑通过；代码无改动 workaround |
| 普通浏览器预览报 Tauri IPC 错 | `@tauri-apps/api` 在无 Tauri runtime 时调用 `invoke/listen` | 增加 `isTauriRuntime()` guard：Web 预览为空列表、跳过事件监听；Tauri/Vitest 不受影响 |

## 待验证 / 风险跟踪

- **CP-4 / GUI dogfooding**：待真实环境 `pnpm tauri dev` 或安装 `.dmg`。Week 4 后需验收：配 3 跳 SSH 连真实 MySQL、TOFU 首次弹窗/已信任静默/指纹变更硬拒绝、passphrase 首次弹窗本会话静默、左侧树点表看前 1000 行、SQL 编辑器 SELECT/JOIN/聚合、`SELECT SLEEP(60)` 取消后 `SHOW PROCESSLIST` 消失、故意 kill 中间跳 sshd 验证 180s 内 hop 变 lost。
- **CP-2** Week 2/3 累计工时检查（PLAN §3.3）：未正式记录工时，下次同步补。
- **CP-3** MySQL 5.7 `caching_sha2`/`native_password` 兼容：推到 Week 5 dogfooding（不进 CI）。
- **R-001** Tauri+workspace 摩擦：已规避（CP-1 通过）。
- **R-002** caching_sha2 握手：Week 5 验证。
- **R-keepalive** keepalive 在某些 server 不响应 / drop 后 task leak：60s+3 次阈值留缓冲；Drop 已 abort 全部 keepalive task（PLAN §4.3 风险）。

相关：[[activeContext]] · [[projectbrief]]
