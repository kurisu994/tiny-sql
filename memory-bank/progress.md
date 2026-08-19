# 进度（progress）

> 面向历史回溯：发生了什么、为什么变。重大架构变更记日期。

## 版本发布历史

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.0.3 | ✅ 预览版已发布 | 2026-07-03 全平台 Release 成功，含 updater 签名产物与 `latest.json` |
| v0.1.0 | ✅ 正式版已发布 | 2026-08-18 全平台 Release 成功，含安装包、签名更新产物与四平台 `latest.json` |
| v0.2 | 🚧 开发中 | Week 1-3（多 driver）、Week 4（主密码/TLS 代码）、Week 5（schema intelligence）、Week 6（查询工作台）、Week 7（RTT/重连/状态决策）自动化门禁均已完成；剩 T3.4/T4.3/T8.1/T8.2/T8.4 真实环境验收与发布 |
| v0.3 | 规划 | 保存/打开 SQL、index/constraint 树、对象搜索、服务端筛选分页、多结果与可靠事务 |
| v0.4 | 规划 | 主键单表安全编辑、Table/View 对象管理、CSV 导入与 SQL dump |
| v0.5+ | 规划 | 备份同步、MySQL 用户权限、ER/BI/AI，并穿插平台与 crate 长期演进 |

CHANGELOG 已切出 `0.1.0` 版本段，`[Unreleased]` 已开始记录后续体验变化。v0.1.0 Release notes 与该版本段一致，并明确记录三项已知限制。

## 开发阶段完成度（5-6 周计划）

| 周 | 内容 | 状态 |
|---|---|---|
| Week 1 | vertical slice（workspace + 单跳 SSH + sqlx SELECT 1 + hello 页） | ✅ CP-1 / CP-1b 已验收 |
| Week 2 | 测试基础设施 + `MySqlDriver` struct + 加密 store + 连接管理 UI | ✅ 静态验证完成（playwright E2E 推迟；CP-2 工时未记录） |
| Week 3 | 多跳 SSH + keepalive + 错误模型三变体 + TOFU + 表浏览 | ✅ 实现完成，真实环境状态由 CP-4 验收覆盖 |
| Week 4 | SQL 执行（顶层安全追加 LIMIT + KILL QUERY）+ 拓扑图 + 全平台 Release | ✅ 代码、云端流水线与 CP-4 已完成 |
| Week 5 | dogfooding + 修 bug + README + tag v0.1.0 | ✅ 正式版已发布；README 已提供文字说明，不要求 GIF |
| Week 6 / 7 | 缓冲 / launch（V2EX + 掘金） | ✅ 用户提交 `4f54f02` 标记完成 |

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
| `67a1d70` | docs: 启动 Week 5 dogfooding |
| `b5a137d` | docs: 完善 Week 5 发布准备 |
| `705ef8e` | feat(ui): 连接列表改用右键菜单与 shadcn 弹窗 |
| `d91dd43` | refactor(ui): 右键菜单改用 shadcn ContextMenu |
| `03ee5be` | docs: 同步连接列表右键菜单与 shadcn 接入 |
| `43b3b7b` | feat: 接入正式版自动更新 |
| `7bcc0cf` | ci(release): 配置 CI 忽略发布提交，完善发布流程 |
| `b02eac2` / `248a11c` | fix(ci): 修复 release 产物上传路径并升级 Actions Node runtime |
| `e1e10ae` | feat(ci, docs, build): 为 v0.1 添加全平台桌面打包支持 |
| `ffece92` | fix(ci): 修复 Linux updater manifest 产物匹配 |
| `d80d05b` | docs(changelog): 调整 CHANGELOG 为面向使用者的高层级概览 |
| `bf0d427` | feat(conn): 拆分连接设置标签页 |
| `36bc02a` | feat(updater): 菜单栏检查更新 |
| `d73f195` | feat(db): 支持右键新建数据库 |
| `9679fc7` | release: v0.0.2 |
| `9452a70` | feat(ui): 为数据库和表树添加图标（origin/main） |
| `3228efd` | feat(sql): 接入 CodeMirror 编辑器 |
| `02cf40a` | fix(schema): 支持收起数据库节点 |
| `15b0613` | style(schema): 移除数据库展开箭头 |
| `582efe2` | fix(schema): 调整数据库树打开交互 |
| `f9e5fb6` | release: v0.0.3（全平台 Release 成功） |
| `b5a2a3b` / `9c5f9fd` | fix: 修复 SQL 查询链路与测试连接 host key 校验 |
| `f12fa45` | docs: 记录 P0 修复到 CHANGELOG 与活跃上下文 |
| `0b13a76` | chore: 更新 Cargo.lock 依赖 |
| `7f566ae` | docs: 同步文档与当前代码实现 |
| `354ec35` | docs: 对齐代码与项目进度 |
| `a1c7fef` | docs(roadmap): 规划后续管理能力 |
| `4f54f02` | docs(PLAN): 更新任务状态以反映当前进度（HEAD / origin/main） |
| `365b51f` | docs(plan): 精简开发计划待办 |
| `fff24ed` | fix(release): 使用中文发布提交信息 |
| `624b108` | release: 发布 v0.1.0（`v0.1.0` tag） |
| `2e8ed52` | feat(driver): 建立多数据库驱动基础（v0.2 Week 1） |

> 注：`v0.1.0` tag 固定指向 `624b108`；后续发布状态文档提交只推进 `main`，不移动已发布 tag。

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
- **2026-06-29 Week 5 release workflow 收口**：`release.yml` 从单 arm64 job 改为 `macos-15` Apple Silicon + `macos-15-intel` Intel 矩阵构建，上传 artifact 后由单独 release job 创建 GitHub Release；新增 `docs/RELEASE_CHECKLIST.md` 固化 RC、dogfooding、正式发布和延期规则。
- **2026-06-30 release workflow 扩到全平台**：`release.yml` 继续沿用“多构建 + 单发布”结构，把矩阵扩到 macOS arm64/x64、Windows x64、Linux x64；Windows 产 NSIS `.exe`，Linux 产 `.AppImage` 和 `.AppImage.sig`，正式版 `latest.json` 同时生成 `darwin-*` / `windows-x86_64` / `linux-x86_64` 平台入口。README、CHANGELOG、发布清单、需求和路线图同步从原 macOS 发布范围改成全平台先行。
- **2026-06-30 release workflow Linux manifest 修复**：正式版 tag workflow 在 `Generate updater manifest` 步骤失败，错误为 `missing updater artifact for linux-x86_64`；实际可用文件只有 `tiny-sql_0.0.1_amd64.AppImage` 与 `.sig`。根因是脚本误找 `*.AppImage.tar.gz`，已改为匹配 `.AppImage` 本体并读取同名 `.sig`。
- **2026-06-30 release notes 自动化补齐**：publish job checkout 仓库后从 `CHANGELOG.md` 生成 GitHub Release notes；正式版取当前 tag 版本段，预发布 tag 找不到独立版本段时取 `[Unreleased]`。`v*-rc*` / beta / alpha tag 自动加 `--prerelease --latest=false`，正式版继续作为普通 Release。`just release` 也改为 RC 不切 CHANGELOG，避免 `v0.1.0` 正式版 notes 变空。
- **2026-06-29 连接管理 UI 接入 shadcn/ui**：连接列表去掉行内「连接」按钮改 Navicat 式右键菜单（shadcn `ContextMenu`）；新建/编辑改 `Dialog` 弹窗；二次确认用 `AlertDialog` + 全局 `confirm-store` 替代 `window.confirm`。`shadcn init` 选 radix-nova / radix；暗色改回 `prefers-color-scheme` 跟随系统（不切 `.dark` class，现有 `dark:` 零迁移），并还原 system 中文字体栈（移除 init 引入的 Geist）。提交 `705ef8e` + `d91dd43`，`tsc` / `next build` 通过；后续 `03ee5be` 已把相关文档同步到 `origin/main`。
- **2026-06-30 正式版发布准备复盘**：对照 `redis-desktop-client` 的 release-prep 经验后，tiny-sql v0.1 曾先按 macOS `.dmg` / 无 Apple Developer 代码签名收口；随后发布策略调整为全平台先行。正式版前必须先完成 `v0.1.0-rc1` 全平台产物验证、真实 3 跳 GUI dogfooding、MySQL 5.7 验证、作者 + 2 同事 1 周试用、README 与 `CHANGELOG.md` 切版。
- **2026-06-30 正式版自动更新接入**：提前把 `tauri-plugin-updater` / `tauri-plugin-process` 纳入 v0.1。Tauri config 启用 `bundle.createUpdaterArtifacts=true`，内置 updater 公钥和 GitHub latest `latest.json` endpoint；前端新增每日自动检查、手动检查、下载进度和安装后重启提示。Release workflow 使用 `TAURI_SIGNING_PRIVATE_KEY` 生成 `.app.tar.gz.sig`，正式版生成 `latest.json`，RC / beta / alpha 只作为手动下载预发布，不作为自动更新源。Tauri updater minisign 签名不等于 Apple Developer 代码签名，首次打开摩擦仍按 README 处理。
- **2026-06-30 release 与 CI 触发分流**：`ci.yml` 在 `push.main` 下对 `CHANGELOG.md`、`Cargo.lock`、`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 设置 `paths-ignore`，让 `just release` 产生的 release-only 版本提交不重复触发 CI；PR 仍完整跑 CI。`just version` 定向刷新 `Cargo.lock` 中 `tiny-sql` 本地 package 版本，`just release` 暂存范围补入 `Cargo.lock`，tag push 继续触发 `release.yml` 全平台打包。
- **2026-06-30 CHANGELOG 写法收敛**：按用户要求把 `CHANGELOG.md` 从模块/实现细节清单改为功能大项概览；后续发布说明应继续面向使用者，只写主要功能、体验变化、安全稳定性、发布准备和待验证事项。
- **2026-07-01 连接表单标签页与 SSL/高级配置契约**：新建 / 编辑连接弹窗拆成常规、SSH、SSL、高级四个标签页，新增本地 radix `Tabs` 组件；`StoredConnection` 增加 `ssl` / `advanced` 并用 `serde(default)` 兼容旧连接文件；`db-driver` 新增 `MySqlConnectSettings`，已接线 SSL mode、CA / client cert / client key path 和连接超时。读取超时、写入超时、保持连接间隔、压缩、自动连接先随连接保存，后续再按 driver/SSH 行为逐项实现。
- **2026-07-03 SQL 编辑器与 schema 树交互收口**：SQL 输入从裸 textarea 升级到 CodeMirror 6，提供 MySQL 高亮、行号、基础 database/table 补全、本地结构错误 gutter 和 `Cmd/Ctrl+Enter`；前端虽有 MySQL `line N` 解析逻辑，但后端只返回稳定 i18n key，服务端错误行标识尚未真正接通。schema 树改成数据库双击打开 / 切换、单击折叠已打开库，并通过独立 `expandedDb` 保留当前表和结果。
- **2026-08-08 文档与代码全面对齐**：全量核对 README / REQUIREMENTS / ARCHITECTURE / PLAN / ROADMAP / memory-bank 与当前代码的偏差并同步。要点：(1) SQL 执行描述从「子查询包装」统一改为「顶层安全追加 LIMIT + 客户端截断兜底」（derived table 包装在多表 JOIN 重名列触发 1060，已弃用）；(2) 写操作二次确认从「黑名单正则」改为「首 token 白名单分类」（SELECT/WITH 读、SHOW/EXPLAIN/DESC/DESCRIBE 元数据免确认、其余一律需 allow_write），前后端同构；(3) 状态机收敛为 4 态（pending/connected/failed/lost），ARCHITECTURE 与代码及 FR-015 对齐，移除不存在的 connecting/reconnecting/latency_ms；(4) passphrase 流程改为 `connection_open(id, passphrase?)` 参数直传 + per-connection 会话缓存，无 `ssh_set_passphrase` command；(5) master key 从「内置固定 key」改为「首次随机生成落盘 master.key（0600）」；(6) keepalive 机制改为 russh 内置配置 + 每跳监控 task，非自建 interval 循环；(7) control pool 与主 pool 同一连接参数（非独立本地端口）；(8) 加密文件结构改为扁平 `Vec<StoredConnection>`（无 version 包装 / mysql 嵌套），schema 补充 ssl / advanced；(9) 明确标注 v0.1 已知 UI 缺口：列清单展示、列宽拖拽、重连按钮、语言下拉框均未实现，已登记到 ROADMAP v0.2（FR-110~112）与 ARCHITECTURE §10.3；(10) playwright E2E 推迟状态补齐到 PLAN / ARCHITECTURE，integration 命令修正为 `cargo test -p db-driver -- --include-ignored`。
- **2026-08-18 进度与事实基线再对齐**：刷新 `origin` 并核对 GitHub Release / Actions。确认 `main == origin/main == 7f566ae`、当前应用版本为 `0.0.3`、最新 main CI 成功、v0.0.3 全平台 Release 与 `latest.json` 已成功；同时发现 MySQL TLS 已接线但未真实验收、passphrase 测试连接未覆盖、ChannelDropped / AcceptLoopDied 尚无运行时构造路径，并据此修正文档口径。
- **2026-08-18 后续版本吸收 Navicat 能力缺口**：不新增 v2.0，也不重复 v0.2 已有的 SQL 历史、CSV/Excel 导出、column 树和多查询 tab；把其余能力按依赖拆入 v0.3（查询工作台、元数据检索、服务端筛选分页、可靠事务）、v0.4（主键单表安全编辑、Table/View 对象管理、CSV/SQL dump 导入）和 v0.5+（备份同步、用户权限、ER/BI/AI）。同时撤销“图形化编辑、ER、备份永久不做”的旧边界，保留单表主键定位、SQL 预览确认和不建设独立监控平台等安全约束。
- **2026-08-18 v0.2 可执行计划落地**：`docs/PLAN.md` 新增 8 周 / 约 98h 计划，以 Driver/PG → 多 driver 应用 → passphrase/TLS → schema intelligence → 查询工作台 → RTT/重连 → 双 driver dogfooding/发布为依赖顺序；定义 V2-CP0~5、双数据库/隧道/安全/并发测试矩阵，并规定 P2 超时降级到 v0.2.1。
- **2026-08-18 v0.2 启动前置收窄**：用户确认 §2.2 vertical slice 全部通过；v0.2 前增加不计入 8 周的 Phase 0，只补发 v0.1.0、验收安装/更新链路并固化 PostgreSQL 版本基线。发布后的稳定时长与社区反馈只影响 P2 排序，不再阻塞 Week 1。
- **2026-08-18 PLAN 转为纯待办文档**：`docs/PLAN.md` 从 633 行历史型计划精简为约 170 行，只保留 v0.1 发布收口和 v0.2 未完成任务；已实现周计划、旧检查点、评审落地表继续保存在本文件的历史记录中。
- **2026-08-18 v0.1 状态冲突收口**：用户提交 `4f54f02` 将 CP-3/4/5/6、试用与 launch 标记完成，项目记忆据此接受外部验收状态；但刷新远端 tag 后最高仍为 `v0.0.3`、版本文件仍为 `0.0.3`，因此 tag/正式发布当时继续按未完成记录。GIF 后续从交付要求中移除。
- **2026-08-18 v0.1.0 正式发布**：本地 `just check`、4 个真实 MySQL integration test 和 Tauri 生产构建通过；`624b108` 统一版本并切出 CHANGELOG 0.1.0，`v0.1.0` tag 触发 Release run `32110227419`。macOS arm64/x64、Windows x64、Linux x64 与发布 job 全绿，Release 安装包、签名更新产物和四平台 `latest.json` 均已验证。发布后仍保留应用内升级端到端实测与三个已知能力缺口；GIF 不再要求。
- **2026-08-18 PostgreSQL v0.2 版本基线固化**：正式支持 PostgreSQL 15-18，最低支持 15；日常 integration 必测 `15.latest` 与当前最新稳定大版本 `18.latest`，本地实例继续不依赖 Docker。14 及以下仅 best-effort 且不主动阻止连接；若 v0.2 RC 前 PostgreSQL 19 GA，则增加发布回归但不抬高最低版本。
- **2026-08-18 自动更新端到端验收**：在 `/Applications/tiny-sql.app` 以 v0.0.3 打开原生应用菜单，确认 `Check for Updates...` 位于 About 后；手动发现 v0.1.0 后完成 6.8 MB 签名更新包下载、安装和重启。重启后 bundle 版本为 0.1.0，连接配置保留，更新菜单仍存在；`pnpm test` 34 项与 `just lint` 通过。
- **2026-08-18 v0.2 正式开工（V2-T1.1）**：从 `MySqlDriver` 现有调用面提取对象安全的最小 `Driver` 契约，使用装箱 Future 避免新增 `async-trait` 依赖；契约只包含 ping、metadata、query/`CancellationToken` cancel 与 close，连接创建和 MySQL 专属 `CREATE DATABASE` 保留在具体实现。Tauri 的实际 metadata/query/连接关闭路径已通过契约调用；`db-driver` 17 个单测与 workspace 编译通过。
- **2026-08-18 连接 driver 类型与无损迁移（V2-T1.2）**：新增跨 Rust/TypeScript 的 `mysql` / `postgresql` 稳定类型，旧 `connections.enc` 缺字段时在内存中默认 MySQL，启动读取不重写密文；未知 driver 或反序列化失败直接返回错误并保留原文件。新建、编辑与复制连接会携带 driver；PostgreSQL 尚未接入时明确拒绝，避免误走 MySQL 发送凭据。7 个真实加密存储测试、前端针对性测试与 TypeScript 检查通过。
- **2026-08-18 PostgreSQL vertical slice 代码与 MySQL 回归（V2-T1.3/T1.4）**：启用锁文件已有的 `sqlx-postgres 0.8.6`（MIT OR Apache-2.0），实现显式直连、`SELECT 1::BIGINT`、close 与稳定连接错误 key；显式参数不读取 `~/.pgpass`。新增独立 PostgreSQL integration 门禁，缺少 URL 时明确失败而非假绿。MySQL 18 个单测与 5 个真实 integration 通过，新增长查询取消回归；该节点尚无 PostgreSQL 实测，随后已在 Week 2 后端闭环中补齐。
- **2026-08-18 v0.2 Week 1/2 后端闭环**：真实 PostgreSQL `SELECT 1` 已通过，V2-T1.3 完成；公共 metadata 契约新增 `MetadataScope` 与独立 schema 层，PostgreSQL 完成四层 metadata、方言化 query/动态解码、DML `RETURNING` 与独立 control pool `pg_cancel_backend`。真实门禁 MySQL 5/5、PostgreSQL 4/4 全绿；对称回归发现并修复 MySQL JSON 误显示 `<unsupported>`。PostgreSQL 主实现按架构约定拆到 `crates/db-driver/src/postgres.rs`，AppState/UI 接线进入 Week 3。
- **2026-08-18 v0.2 Week 3 多 driver 应用接线**：`OpenConnection` 改为 `ActiveDriver::{MySql, PostgreSql}` 并统一转发 `Driver` 契约；connection/metadata/query commands 按 driver 泛化，新增 schema command 与可选 schema scope。连接表单可选数据库类型，PostgreSQL 使用 database → schema → table 树和双引号预览 SQL；自动门禁与真实 integration 9/9 全绿，Tauri 调试包已验证 MySQL 直连、元数据树与 `SELECT 1`。PostgreSQL 直连、双 driver 切换/取消及各自 1 跳 SSH 仍留 V2-T3.4；PostgreSQL 当前只展开连接所在 database，证书路径尚未接线。
- **2026-08-18 带口令私钥测试连接缺口关闭**：`connection_test` 新增瞬时 `passphrase?` 参数，连接表单只在存在 privateKey hop 时显示“仅测试”密码框；该值不进入 `ConnectionInput`、加密文件或正式连接会话缓存。后端运行时 hop 转换和前端 IPC 调用链均有回归测试，V2-CP1 剩余 `ChannelDropped` / `AcceptLoopDied` 运行检测与安全 SQL 行号两项缺口。
- **2026-08-18 V2-CP1 历史代码承诺全部关闭**：`TunnelHandler::disconnected` 与 keepalive fallback 区分首跳 `tunnel_lost` / 嵌套跳 `channel_dropped` 并原子去重，accept worker 由独立 monitor 捕获 panic/意外退出；正常 drop 先置 shutdown 防误报。`db_query` 改用 `{ key, line? }` 安全错误载荷，后端只解析 MySQL 正整数行号，原始数据库错误和 SQL 片段不跨 IPC。加上已完成的瞬时 passphrase 测试连接，V2-CP1 通过。
- **2026-08-18 V2-T5.1 column 树**：前端 session state 接入现有 `db_list_columns`，MySQL/PostgreSQL 表节点以独立控件按需展开，展示类型、nullable、key、default 与 comment；收起、切库或切 schema 后异步旧响应不会覆盖当前树。暂不缓存列元数据，分区 LRU、刷新和失效统一留 V2-T5.2；前端 46 项测试与 TypeScript 检查通过。
- **2026-08-18 V2-T5.2 metadata cache**：新增纯内存 128 项 / 5 分钟 TTL LRU，key 包含 connection/driver/database/schema/resource/table；schema/table/column 加载均先查 cache。树顶部支持手动刷新，重连、关闭、建库及成功 DDL 会清理对应连接 cache；异步返回继续核对当前命名空间。前端 54 项测试、TypeScript 与 Next.js 生产构建通过。
- **2026-08-18 V2-T5.3 schema-aware completion**：CodeMirror 按连接使用 MySQL/PostgreSQL dialect；对象树加载过的列按表累积到当前 session，原生 schema source 提供 column/alias completion。独立 completion 模块按真实列的 `target_id → target.id`、反向或同名 key/id 关系生成 JOIN + ON 候选，支持双方言引号和 schema-qualified table，不新增传递依赖。前端 59 项测试、TypeScript 与 Next.js 生产构建通过。
- **2026-08-19 V2-T5.4 大 schema 与并发回归**：metadata 请求新增单调 epoch，database/schema/table 的 A→B→A 乱序返回均不能覆盖最新状态或 cache，关闭/DDL 也会使旧请求失效。性能门禁验证 5000 次 cache 写入仍限制为 128 项、2000 表/16000 列 SQL namespace 在 250ms 内构建；双方言补全隔离回归通过。前端测试增至 65 项，Week 5 完成。
- **2026-08-19 V2-T7.3 keepalive 配置落地**：高级设置新增连续失败阈值，启用状态、间隔和阈值均接入 `ssh-multihop`；新建连接默认 60s / 3 次，旧记录缺阈值时兼容补 3，运行时对 0 值兜底为 1。监控 task 从主动 `send_keepalive` 改为只读 `Handle::is_closed()`，避免固定 20s 探测改变用户设置的真实发包间隔；`just check` 全绿，含前端 66 项、ssh-multihop 8 项、app_lib 21 项测试。
- **2026-08-19 V2-T7.2 手动幂等重连**：顶部、断链 banner 与连接右键菜单新增重连入口；后端按 connection_id 独立串行生命周期操作，重连前取消该连接查询并先关闭 pool 后 drop tunnel。open/reconnect 返回新 session_id，expected_session_id 防迟到命令关闭新会话，SSH 事件和查询结果分别用 session_id/query_id 拒绝旧写回；`just check` 全绿，前端测试增至 71 项、app_lib 增至 24 项。
- **2026-08-19 V2-T7.1 SSH RTT 代码闭环**：每跳 session actor 独占 russh Handle，10 秒低频调用 SSH global-request 探测累计 RTT，2 秒超时；等待 ping 时优先处理 direct-tcpip，指标不阻塞数据库新连接。`ssh:hop-rtt` 以 connection_id/session_id 隔离旧采样，拓扑明确显示 SSH 毫秒/超时/不可用且不改变节点四态；`just check` 全绿（db-driver 26、ssh-multihop 8、app_lib 25、前端 74），真实多跳链路仍留 RC 人工验收。

- **2026-08-19 v0.2 Week 4 主密码加密存储（V2-T4.1/T4.2/T4.4）**：新直接依赖 argon2 0.5（MSRV 1.65）与 zeroize =1.8.1（精确约束规避 1.9 的 MSRV 1.85，保持项目 1.77.2 承诺；均 MIT/Apache-2.0）。v2 envelope 为自描述 JSON（`{v,nonce,data}`），KDF 参数与盐集中在明文 `security.json`，verifier 区分错误密码与数据损坏；派生 key 用 `Zeroizing` 仅驻留内存。迁移用 `.bak` 备份 + tmp + rename + security.json 提交点，失败回滚、崩溃后启动自动还原；篡改 KDF 参数直接拒绝解锁。passphrase 仅在主密码解锁后可经 `secrets.enc` 持久化（连接删除同步清理）；关闭主密码迁回 v1 并删除 secrets；忘记密码重置删除全部加密数据且前端强警告。锁定状态一切加密读写返回 `error.security.locked`。
- **2026-08-19 MySQL TLS 错误诊断与证书 UX（V2-T4.3 代码部分）**：连接失败在用户显式启用 TLS 时按错误文本分类为 `error.driver.tls_handshake_failed` / `error.driver.tls_verify_failed`，Disabled 模式永不误报；前端 SSL 页三个证书路径接入 tauri-plugin-dialog 文件选择器。真实 TLS 环境正反例验收仍留 V2-T8.1。
- **2026-08-19 v0.2 Week 6 查询工作台（V2-T6.1~T6.5）**：SQL 历史 `history.enc` 由 `db_query` 自动记录（最新在前、100 条上限、SQL 截断 4000 字符、锁定不可读写、可显式清空）。session-store 重构为多 tab：每 tab 独立 SQL/结果/query_id/取消/dirty，双击表预览新开 tab，重连/建库保留 SQL 只复位执行态；并发取消隔离与关闭执行中 tab 先取消均有前端回归（T6.5）。导出 `db_export_query` 后端重新执行只读 SQL 并流式写文件：CSV 带 BOM、NULL 无引号字面量、空串与 "NULL" 文本强制加引号；XLSX 用 rust_xlsxwriter constant_memory 流式写出。列宽拖拽 64-640px clamp、按连接+列签名 localStorage 持久化、可恢复默认（FR-111）。
- **2026-08-19 V2-T7.4 状态模型决策**：保留现有公共契约，不实施 KILL QUERY 四状态与 SSH 统一状态机。依据：取消令牌 + query_id/session_id 双守卫已覆盖取消、重连与并发串线场景且自动化门禁无反例；新增公共状态会扩大 IPC 契约面而无对应用户反馈。重审触发条件：真实 dogfooding 出现取消状态误报或连接状态混淆反馈。
- **2026-08-19 V2-T8.3 文档与 T8.4 本地门禁**：ARCHITECTURE 双时代加密格式/目录结构、REQUIREMENTS FR 状态、RELEASE_CHECKLIST v0.2 段已更新；新增 `README_EN.md` 与 `CONTRIBUTING.md`。`just check` 全绿（app_lib 45、db-driver 27、ssh-multihop 8、前端 90），双 driver integration 9/9，本机 debug bundle + dmg + updater 签名产物构建成功。

## 已解决的阻碍

| 问题 | 根因 | 解决 |
|---|---|---|
| sqlx feature 报错 | 写成 `rustls`，sqlx 0.8 无此 feature | 改 `runtime-tokio-rustls` |
| `pnpm build` exit 1 | pnpm 11 `verify-deps-before-run` 因 sharp 构建脚本未批准而 exit | `pnpm-workspace.yaml` 加 `allowBuilds: sharp: true`（pnpm 11 读 workspace.yaml 而非 package.json） |
| `tauri::Manager` unused 警告 | `app.handle()` 是 inherent 方法 | 删除 import |
| CP-1（Tauri+workspace 摩擦，Week 1 最大风险） | — | 已验证通过，`cargo check --workspace` 正常引用 crate |
| Turbopack 在沙箱内 build 失败 | Next/Turbopack 处理 CSS 时需创建子进程并绑定本地端口，沙箱返回 `Operation not permitted` | `just check` / `pnpm tauri build` 在沙箱外重跑通过；代码无改动 workaround |
| 普通浏览器预览报 Tauri IPC 错 | `@tauri-apps/api` 在无 Tauri runtime 时调用 `invoke/listen` | 增加 `isTauriRuntime()` guard：Web 预览为空列表、跳过事件监听；Tauri/Vitest 不受影响 |
| 正式版 `latest.json` 生成失败 | Linux updater artifact 实际是 `.AppImage` + `.AppImage.sig`，workflow 误按 `.AppImage.tar.gz` 查找 | 修正 artifact 匹配；v0.0.3 Release 已真实生成全平台 `latest.json` |
| 文档与最新实现漂移 | README/docs/memory-bank 曾保留旧编辑器、拓扑、版本、发布风险与 TLS 口径 | 2026-08-18 再次按代码、Git 和 GitHub Release/Actions 状态同步 |

## 待验证 / 风险跟踪

- **CP-4 / GUI dogfooding**：用户提交 `4f54f02` 已标记完成；真实记录在 ignored `docs/dogfooding-log.md`，本轮未读取其中环境细节。
- **CP-2** Week 2/3 累计工时未正式记录；该历史检查点不再进入当前待办计划。
- **CP-3** MySQL 5.7 兼容已由用户提交 `4f54f02` 标记完成；不进入 CI 的策略不变。
- **v0.1.0 产物验证**：全平台 Release workflow、安装包、签名更新产物和四平台 `latest.json` 已验证；从 v0.0.3 应用内发现、下载、安装并重启到 v0.1.0 也已实测。
- **发布脚本暂存范围**：`just version` 已会同步 `Cargo.lock` 本地 package 版本，`just release` 已收窄到版本/CHANGELOG/Cargo.lock 相关文件；正式发版前仍必须确认工作区没有无关改动。
- **自动更新 GitHub Secrets**：release workflow 依赖 `TAURI_SIGNING_PRIVATE_KEY`；无密码私钥时 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可留空。本地按 Redis 项目方式把真实私钥写入 ignored `.env`，`just build` 会加载；直接 `pnpm tauri build` 不经 justfile 注入 `.env`，仍需手动 export，且无密码私钥要显式保留 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`。
- **连接 tab 表单 GUI 验证**：常规 / SSH / SSL / 高级标签页、新建数据库、schema 树和更新菜单已由用户确认完成验收；环境细节不写入公开仓库。
- **R-001** Tauri+workspace 摩擦：已规避（CP-1 通过）。
- **R-002** caching_sha2 握手：MySQL 5.7 兼容已由用户提交 `4f54f02` 标记验证完成。
- **R-keepalive** keepalive 在某些 server 不响应 / drop 后 task leak：60s+3 次阈值留缓冲；Drop 已 abort 全部 keepalive task。
- **R-updater-release** 已关闭：云端全平台 artifact、正式版 `latest.json` 及 v0.0.3 → v0.1.0 应用内发现、下载、安装、重启全链路均已验证。
- **R-ssh-runtime-errors 已关闭**：首跳掉线、嵌套 channel 断开与 accept worker 异常均有运行路径、去重和正常关闭抑制测试。
- **R-passphrase-test** `connection_test` 不接收 passphrase，带口令私钥只能在正式打开连接时验证完整链路。
- **R-query-error-contract 已关闭**：前端仅接收稳定 key 与可选正整数行号，原始 Rust/sqlx/MySQL 错误不跨 IPC。

相关：[[activeContext]] · [[projectbrief]]
