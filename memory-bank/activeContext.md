# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-08-22

## 当前状态

**本轮文档同步：ROADMAP 对齐 v0.3 事实（2026-08-22）**——`docs/ROADMAP.md` 版本头升至 `0.3.0-draft-1`，路线总览改为 v0.1/v0.2 已发布、v0.3 编码与验收完成待正式发布；v0.1 章节改标题为「已发布」、v0.2 章节补「发布事实」段并把 5 个挂在开发期「待验收」状态的单元格（FR-100/102/103/105/110）统一收口为完成态；v0.3 章节升级为「编码与验收完成，待正式发布」，补完整进度说明（Week 1-6 完成、T7.1 真实回归、rc1、T7.2 RC 一周试用关闭），功能表加状态列（五项 FR 全 ✅）；工程部分「下一步增加 PostgresDriver」改为双实现已落地，反馈通道由「v0.2 优先级投票」改为「v0.3 反馈与 v0.4 优先级投票」。

**里程碑：v0.3.0-rc1 已发布（2026-08-21）**——发布前 `just check` 与双 driver integration 20/20 全绿（本机 dmg 构建门禁前一日 T7.4 已过，中间仅文档变更）；`just release v0.3.0-rc1` 完成版本号更新（四文件 → `0.3.0-rc1`，预发布不切 CHANGELOG）、发布提交 `3e29e5a`、main 与 tag 推送成功。Release workflow run `32441320976` 四平台 bundle + Publish 全部成功；GitHub Release `v0.3.0-rc1` 为 prerelease、非草稿，含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows `.exe(.sig)`、Linux `.AppImage(.sig)`，**未生成 `latest.json`**（不会成为更新源）；Release notes 取 CHANGELOG `[Unreleased]` 段已核对。剩全平台下载安装实测与 V3-T7.2 一周试用。

**V3-T7.1 真实回归已通过（2026-08-21）**——用户实测 MySQL/PostgreSQL × 直连/1 跳/3 跳全功能（事务、筛选分页、多结果、对象搜索、SQL 文件）无问题；PLAN.md 已勾选，RELEASE_CHECKLIST v0.3 功能验收段已记录结果。**V3-T7.2 RC 一周试用已于 2026-08-22 关闭**（沿用 V2-T8.2 标准：0 数据丢失、0 凭据泄露、0 不可恢复 crash，无阻塞 P0/P1）；v0.3 剩余仅为 rc1 全平台下载安装验收与正式发布（V3-CP5）。

**本轮优化：结果表格序号列冻结（2026-08-20）**——用户要求 `#` 序号列不随横向滚动。ResultTable 改用 Virtuoso `customScrollParent` 复用外层统一横纵滚动容器（原生 Virtuoso scroller 会截获 sticky 上下文，直接 sticky 对行无效），表头 `sticky top-0 z-20`、表头序号 `sticky left-0 z-30`、行序号 `sticky left-0 z-10` + `bg-background`（hover 用 group 同步行色）。tsc、vitest 93/93、Next build 全绿，CHANGELOG `[Unreleased]` 已补录；待用户 dev 实测后发布 v0.2.0。

**里程碑：v0.3 全部编码与自动化门禁完成（2026-08-20）**——按 PLAN.md v0.3 开发计划完成 Week 1-6 全部五项 FR（提交 `5ad5ce2` 事务 / `7acc006` 浏览分页 / `8794ff8` 元数据树与搜索 / `5007cf6` 多语句与格式化 / `8477545` SQL 文件）+ V3-T7.3 文档 + V3-T7.4 门禁。门禁事实：`just check` 全绿（db-driver 单测 35、app_lib 46、ssh-multihop 8、前端 vitest 102、Next build）；双 driver integration 20/20（MySQL 11、PG 9，含事务同连接证明/回滚、浏览筛选分页、index/constraint metadata、多语句拆分执行）；本机 dmg + updater 签名产物构建成功。剩余仅为 V3-T7.1/T7.2 真实 dogfooding 与 RC/正式发布。

**V3-CP0 启动准入已关闭（2026-08-20）**——`REQUIREMENTS.md` 补 §3.3 v0.3 范围章节（FR-240~FR-244 五项锚点，含边界与固化的设计决策），文件头快照同步到 v0.2.0 已发布；Phase 0 三项全部勾选（v0.2.0 已发布、无 RC 反馈补丁需求、需求收口）。**v0.3 Week 1（V3-T1.1 Driver 契约扩展独占 session）可以开工**。

**里程碑：v0.2.0 正式版已发布（2026-08-20）**——用户实测序号列冻结无问题后执行 `just release v0.2.0`：版本号 → `0.2.0`（package.json / src-tauri/Cargo.toml / tauri.conf.json / Cargo.lock）、CHANGELOG 切出 `0.2.0 — 2026-08-20` 段、发布提交 `4f6b07f`、main 与 tag 推送成功。Release workflow run `32325101849` 四平台 bundle + Publish 全部成功；GitHub Release `v0.2.0` 为非草稿、非预发布且是 latest，含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows `.exe(.sig)`、Linux `.AppImage(.sig)` 与正式版 `latest.json`。`latest.json` 已核对：version `0.2.0`、notes 与 CHANGELOG `0.2.0` 段一致、四平台 URL 均指向 `v0.2.0` 资产。v0.1.0 用户将收到自动更新；应用内端到端更新实测由用户日常验证。

**v0.2 发布前置全部就绪（2026-08-20）**——用户当日连续确认：PostgreSQL 15.latest/18.latest 双端点 integration 回归完成、RC 全平台下载安装验收完成、V2-T8.2 提前关闭（RC 发布当日关闭，未执行满一周试用；实质验收依据为 08-19 T8.1 dogfooding 与 08-20 RC 安装验收，后续反馈走常规 P0/P1/P2 流程）。V2-CP5 三项标准全部满足，v0.2 仅剩 `just release v0.2.0` 正式发布。

**v0.3 开发计划已立项（2026-08-20）**——用户决定在 v0.2 RC 试用期并行启动 v0.3 规划（用户口径“v3.0”按 ROADMAP 版本线确认为 v0.3）。`docs/PLAN.md` 新增「v0.3 开发计划」章节：7 周约 84h，范围为 ROADMAP v0.3 五项 FR——FR-242 服务端筛选排序分页（P0）、FR-244 独占 session 可靠事务（P0，v0.4 前置）、FR-240 SQL 文件与最近文件（P1）、FR-241 index/constraint 树与对象搜索（P1）、FR-243 多结果与 SQL 格式化（P1）；排期 Week 1-2 事务后端+UI、Week 3 筛选分页、Week 4 元数据树/搜索、Week 5 多结果/格式化、Week 6 SQL 文件、Week 7 dogfooding 发布；含 V3-CP0~CP5 检查点、降级链（格式化→最近文件→对象搜索→多结果；P0 不降级）与 V3-R01~R06 风险表。功能代码待 v0.2.0 正式版发布后开工（V3-CP0 准入）。

**里程碑：v0.2.0-rc1 已发布（2026-08-20）**——用户选择按计划走 RC 路径（不跳过 T8.2 试用期）。发布前 `just check` 全绿；`just release v0.2.0-rc1` 完成版本号更新（package.json / src-tauri/Cargo.toml / tauri.conf.json / Cargo.lock → `0.2.0-rc1`，预发布不切 CHANGELOG）、发布提交 `64787d8`、main 与 tag 推送（本次 SSH push 未被代理阻断）。Release workflow run `32322049995` 四平台 bundle + Publish 全部成功；GitHub Release `v0.2.0-rc1` 为 prerelease、非草稿，含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows `.exe(.sig)`、Linux `.AppImage(.sig)`，**未生成 `latest.json`**（不会成为更新源）。RC 预期产物为全平台安装包 + updater `.sig`，notes 取 CHANGELOG `[Unreleased]` 段；剩下载安装实测。

**前一状态：v0.2 真实环境验收全部通过（2026-08-19）**——用户实测通过 PLAN.md「真实环境验收」全部四项：T3.4（PostgreSQL 直连、双 driver 切换/取消不串线、各自 1 跳 SSH）、T4.3（真实 TLS MySQL 四种模式正反例 + 双向证书）、T7.1/T7.2 真实链路（RTT/超时不阻塞主链路、断中间跳 lost → 重连闭环）、T8.1（双 driver × 直连/1 跳/3 跳 dogfooding）。V2-CP2/CP3/CP4 关闭，PLAN.md 仅余发布事项；CHANGELOG / ARCHITECTURE / REQUIREMENTS 的验收口径已同步。

**上一轮修复：点击表重复开 tab（2026-08-19）**——schema 树表名单击触发 `selectTable`，原实现每次无条件 `createTab`，双击一次会开出两个同名预览 tab。修复为去重复用：已存在 `selectedTable === table && initialSql === 生成的预览 SQL` 的 tab 时只激活不新建（initialSql 含命名空间引号，可区分不同 db/schema 同名表）。新增 session-store 去重测试，前端 vitest 36/36 与 tsc 全绿，CHANGELOG `[Unreleased]` 已补录。

**上轮新增：PostgreSQL 跨 database 浏览的「一键切换」引导**——`selectDb`/`refreshMetadata` 捕获 `error.driver.database_switch_required` 时记录 `pendingDbSwitch`，错误横幅出现「切换到 <db>」按钮；点击后以 session 级 `databaseOverride` 走标准重连（`connection_reconnect` 新增可选参数，不落盘），成功后自动选中目标库。关闭后重新打开仍是保存配置里的原 database。前端 tsc + vitest（session-store 35、schema-browser 3）与 cargo clippy/test（45）全绿。

**v0.2 全部代码事项与真实环境验收已完成：Week 4 主密码加密/TLS 代码、Week 6 查询工作台（历史/多 tab/导出/列宽）本周落地，加上此前的 Week 1-3 多 driver、Week 5 schema intelligence、Week 7 RTT/重连/状态决策，v0.2 自动化门禁全绿、真实验收通过。** 剩余仅为发布事项：PostgreSQL 15/18 双端点回归、V2-T8.2（双 driver RC 一周试用）、V2-T8.4（RC 全平台下载与发布）。

本轮门禁事实：`just check` 全绿（app_lib 45、db-driver 27、ssh-multihop 8、前端 90 项测试、TypeScript、Next.js 生产构建）；真实 MySQL 5/5 与 PostgreSQL 4/4 integration 全绿；本机 Tauri debug bundle + dmg + updater 签名产物构建成功。

### 本轮核对后的事实基线

- Git：`v0.2.0` tag 与 main 指向发布提交 `4f6b07f`；上一 RC tag 为 `v0.2.0-rc1`（`64787d8`）。
- 版本：`package.json`、`Cargo.lock`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 一致为 `0.2.0`。
- 本地门禁：`just check`、5 个真实 MySQL integration test 与本机 Tauri 生产构建均通过。
- Release：workflow run `32110227419` 的 macOS arm64/x64、Windows x64、Linux x64 与发布 job 全部成功；GitHub Release 为非草稿、非预发布且是 latest。
- 产物：四个平台安装包、updater artifact / `.sig` 与 `latest.json` 均已验证；manifest 的四个平台 URL 均指向 `v0.1.0` 资产。
- 自动更新：已在 `/Applications/tiny-sql.app` 从 v0.0.3 通过原生菜单 `Check for Updates...` 发现 v0.1.0，完成签名更新包下载、安装和重启；重启后 bundle 版本为 0.1.0，连接配置保留，更新菜单仍可用。
- 手动检查更新反馈：应用菜单触发检查后，有更新继续打开下载弹窗；无更新改为弹窗提示“当前已是最新版本”，失败也显示结果。后台每日自动检查保持静默。
- P0 SQL/SSH 修复：2026-07-13 已在真实 MySQL 上验证元数据语句、JOIN 重名列、顶层 LIMIT、截断止损和测试连接 host key 校验；当时 `just check` 与 4 个 integration test 通过。
- v0.2 当前验证（2026-08-19 本轮）：`just check` 全绿，覆盖 workspace fmt/clippy、`db-driver` 27 个单测、`ssh-multihop` 8 个单测、`app_lib` 45 个单测、前端 90 个测试、TypeScript 与 Next.js 生产构建。真实 MySQL 5/5 与 PostgreSQL 4/4 integration 本轮已重跑全绿；本机 Tauri debug bundle + dmg + updater 签名产物构建成功。PostgreSQL 15/18 双端点仍留正式版兼容矩阵，当前单一本地实例不能替代。

## 已实现能力

- 连接管理：CRUD、最近使用排序、复制、右键菜单、新建 / 编辑 Dialog、全局 AlertDialog 确认。
- 连接配置：已持久化显式 `mysql` / `postgresql` driver；旧密文缺字段时默认 MySQL 且读取不重写，失败保留原文件。常规页已提供数据库类型选择器，切换时按未编辑默认值联动 3306/root 或 5432/postgres；PostgreSQL 暂用 driver 默认 TLS 策略并禁用尚未接线的证书路径页。
- SSH：N 跳 russh 隧道、密码/私钥认证、per-connection passphrase 会话缓存、TOFU 与指纹变更硬拒绝；测试连接支持一次性 passphrase 且不保存/缓存；高级设置可控制 russh keepalive 启用状态、间隔与失败阈值，新建默认 60s / 3 次，只读监控 task 上报 `lost`。T7.1 已实现每 10 秒通过 SSH global-request 采样到各层 session 的累计 RTT，2 秒超时只更新拓扑指标、不改变节点连接状态。
- 连接恢复：顶部、断链提示和右键菜单均可手动重连；同 connection_id 生命周期串行，重连会取消旧查询并清理旧 pool/tunnel，session_id/query_id 双边界阻止迟到事件和结果写回。
- MySQL：database / table / column 后端查询、表前 1000 行、新建数据库、CodeMirror SQL 执行、10 万行硬上限、顶层安全追加 LIMIT、客户端截断 + `KILL QUERY` 止损、独立 control pool 取消。
- 多 driver 基础：对象安全的 `Driver` 契约已覆盖 kind、ping、database/schema/table/column metadata、query/取消与 close；`MetadataScope` 显式区分 database/schema，MySQL 的 Tauri 生产调用面保持兼容。
- PostgreSQL：独立 `postgres.rs` 已实现直连、四层 metadata、query/动态解码、DML `RETURNING`、10 万行上限与独立 control pool `pg_cancel_backend` 取消；`ActiveDriver`、通用 commands、连接表单和 schema 浏览树均已接线，真实 integration 全绿。
- SQL 分类：SELECT/WITH 为读；SHOW/EXPLAIN/DESC/DESCRIBE 为元数据；其余需 `allow_write`。前后端规则同构，`EXPLAIN ANALYZE` 写语句仍需确认。
- UI：纯 CSS 拓扑图、database/schema/table/column 树、按需列元信息、手动对象刷新、数据库折叠状态与当前选择分离、react-virtuoso 结果表格。
- Metadata cache：schema/table/column 使用 128 项、5 分钟 TTL 的进程内 LRU，按 connection/driver/database/schema/resource/table 完整隔离；重连、建库、成功 DDL 和手动刷新会失效。
- SQL completion：按 driver 使用 MySQL/PostgreSQL dialect；已加载列进入 CodeMirror schema，提供 column/alias 及保守的 JOIN + ON 片段候选。
- 凭据安全（FR-102）：可选主密码（Argon2id 19MiB/t=2/p=1 → AES-256-GCM v2 envelope），启动解锁/手动锁定/关闭/忘记密码重置；迁移 .bak + 原子替换 + 提交点，崩溃自动还原；解锁后可持久化 SSH passphrase（secrets.enc），删除连接同步清理。
- SQL 历史（FR-106）：最近 100 条加密落盘 history.enc，含 driver/连接/库/schema/时间/成功状态，支持回填与清空；锁定不可读写。
- 查询工作台（FR-109/107/111）：多 tab 独立 SQL/结果/query_id/取消/dirty；CSV/Excel 后端流式导出（NULL 与空串可区分）；列宽拖拽 + localStorage 持久化 + 恢复默认。
- 发布：`v*` tag 全平台构建；预发布不生成 `latest.json`，正式版生成 stable-only updater manifest；手动检查更新无新版本或失败时显示结果弹窗。

## 已知代码 / 承诺边界

- MySQL TLS 已接线 SSL 模式和证书路径，真实 TLS / 双向证书环境已验收通过（V2-T4.3）。
- SSH keepalive 使用 russh 内置机制 + 轻量只读监控 task；运行期会统一上报 `lost`，监控不会额外发包或改变配置间隔。
- SSH 运行期首跳 session、嵌套 transport channel 与 accept worker 故障均已接入 `lost` 事件；shutdown 与每跳原子标记分别抑制正常关闭误报和重复断链事件。
- `connection_test` 的 passphrase 仍为瞬时参数（不落盘、不进会话缓存）；正式连接的 passphrase 在启用主密码后可经 secrets.enc 持久化，否则仅会话缓存（Zeroizing）。
- Tauri query error 使用 `{ key, line? }` 安全载荷；db-driver 只从后端原始错误提取正整数行号，CodeMirror 继续从本地化文案标记 gutter，原始数据库错误与 SQL 片段不进入 IPC。
- PostgreSQL 同一连接只展开当前 database；浏览其他 database 时错误横幅提供一键切换（session 级 override 重连，不落盘，重开仍是原库），不做隐式重连。真实 Tauri 直连 / 1 跳 SSH 验收已通过（V2-T3.4）；证书路径尚未传给 PostgreSQL driver。

## 活跃文件

- `src-tauri/src/security.rs`：主密码状态机、v1↔v2 迁移回滚、secrets map（FR-102）。
- `src-tauri/src/config/{encryption,store,history,ssh_known_hosts}.rs`：v2 envelope/Argon2id KDF、连接配置与 SQL 历史加密存储、SSH 信任库。
- `src-tauri/src/commands/{connection,query,security,history,export}.rs`：连接生命周期、查询与取消、主密码命令、历史命令、流式导出。
- `src-tauri/src/state.rs`：`ActiveDriver::{MySql, PostgreSql}` 注册表 + security/history 注入。
- `crates/ssh-multihop/src/lib.rs`：N 跳隧道、session actor、keepalive、RTT/断链监控、host key verifier。
- `crates/db-driver/src/{lib,postgres}.rs`：Driver 契约、MySQL（含 TLS 错误分类）、PostgreSQL、SQL guard。
- `src/stores/{session-store,security-store}.ts`：多 tab 查询工作台、主密码前端状态。
- `src/components/{schema-browser,security-dialogs,history-panel,connection-dialogs,connection-form,topology-graph}.tsx`：tab 条与结果区、解锁/安全设置、历史面板、passphrase 记住选项、证书浏览、拓扑。
- `src/lib/column-widths.ts`、`src/hooks/use-column-widths.ts`：列宽拖拽与 localStorage 持久化。
- `.github/workflows/{ci,release}.yml`、`justfile`：质量检查、全平台发布、版本脚本。
- `README.md` / `README_EN.md` / `CONTRIBUTING.md`、`docs/*`、`memory-bank/*`：本轮对齐范围。

## 近期决策

- v0.3 工程落地教训：MySQL 事务/会话管理语句（START TRANSACTION/RESET CONNECTION）不支持 prepared 协议（1295），必须 `sqlx::raw_sql` + `Executor::execute` 规避装箱 Future HRTB 推导限制；PG 清理会话不能用 DISCARD ALL（会清掉 sqlx prepared statement cache），改用 ROLLBACK + `RESET ALL; CLOSE ALL; DISCARD TEMP`；PG 列级 NOT NULL 在 pg_constraint 里是 CHECK 类型，断言/展示需预期多条 CHECK。
- v0.3 前端确认复用模式：store 记录 `lastErrorKey`，UI 层按 key 补弹确认重试（多语句写确认回填）；browse/transaction 等 command 参数超 7 个时打包 input 结构体（clippy too_many_arguments）。
- V2-T8.2 于 RC 发布当日由用户确认提前关闭，未执行满一周试用；文档如实记录关闭依据，不写成“试用满一周通过”。
- v0.3 多语句执行保持「单语句直接执行」护栏：「执行全部」由后端按方言分号状态机拆分逐条执行，每条独立 guard 分类与写确认；边界不确定即拒绝执行，绝不尽力执行。首错/取消中止，后续标记 skipped；脚本含事务语句整体拒绝（tx_requires_session 引导去事务 tab）。
- v0.3 事务采用独占 session（独立于 pool，限额 + 空闲超时强制回收）；断链即事务消亡，禁止「重连续事务」隐式承诺；pool 与 session 路径并存，不重写 v0.2 已稳定 query 路径。
- v0.3 SQL 文件读写复用「dialog 选路径 + 后端读写」模式，不引入 `tauri-plugin-fs`；最近文件只持久化路径与时间，不进加密历史。
- 代码是事实源：把 SSL/TLS 描述为“已接线、默认禁用、真实环境未验收”，不再写成完全未实现，也不宣称生产验证完成。
- v0.1.0 直接按正式版发布，未额外补 RC；已知限制明确写入 CHANGELOG / Release notes，不伪装为已实现能力。
- `just release` 的发布提交信息已改成中文动词开头；发布提交为 `624b108`，tag 不包含后续文档状态对齐。
- 本地 SSH push 受代理端口异常阻断后，使用 GitHub CLI 配置的 HTTPS 凭据完成 `main` 与 tag 推送，未修改仓库 `origin`。
- Navicat 日常替代能力不新增突兀的 v2.0：剔除 v0.2 已规划的 SQL 历史、CSV/Excel 导出、column 树和多查询 tab 后，剩余能力按依赖拆到 v0.3（查询/浏览/事务）、v0.4（安全编辑/对象管理/导入）和 v0.5+（备份同步/权限/ER/BI/AI）。
- 原“图形化编辑、ER、备份永久不做”边界已收窄：v0.4 只允许主键单表安全编辑与有 SQL 预览的对象操作；v0.5+ 可做 ER 和备份，但 JOIN/聚合结果写回、应用 RBAC 与独立监控平台仍不做。
- v0.2 采用 8 周 / 约 98h 计划：先完成最小 Driver 契约与 PostgreSQL，再接多 driver 应用、安全/TLS、schema intelligence、查询工作台、RTT/重连，最后双 driver dogfooding 和发布；P2 超时整体降级到 v0.2.1。
- V2-T1.1 采用对象安全的装箱 Future 契约，不新增 `async-trait`；取消通过 `CancellationToken` 进入通用 query 契约，连接创建和方言专属对象操作不进入 trait。
- V2-T1.2 采用只读兼容迁移：旧记录缺 `driver` 时内存默认 MySQL，显式保存才升级密文；未知 driver 失败不覆盖文件。Week 3 已按该字段选择具体 driver，不允许未知值静默回退 MySQL。
- PostgreSQL 显式连接不读取 `~/.pgpass`；integration 拆为 MySQL/PostgreSQL 独立命令，显式执行任一门禁时缺对应 URL 必须失败，避免假绿。
- metadata 契约使用显式 `database + optional schema`；PostgreSQL 不能在同一连接切换 database，跨库请求返回稳定 key。跨库浏览通过横幅一键切换：`connection_reconnect` 接受 session 级 `databaseOverride`（不写回持久化配置，仍不做隐式重连），关闭重开后回到保存的原 database。
- PostgreSQL 取消使用独立 control pool 调 `pg_cancel_backend`；取消或无服务端 LIMIT 的客户端截断后关闭执行连接，避免协议残留回池。MySQL JSON 同步改用 sqlx `JsonValue`，真实测试不再返回 `<unsupported>`。
- SQL guard 按方言处理 PostgreSQL `TABLE`/`VALUES`、`OFFSET`/`FETCH` 与 dollar-quoted body；数据修改 CTE 仍需写确认，DML `RETURNING` 确认后返回结果行。
- V2-CP1 三项历史承诺均以代码关闭：测试连接 passphrase 仅作瞬时参数；SSH 运行期断链按首跳/channel/accept worker 分类并去重；查询错误 IPC 只含稳定 key 与可选正整数行号。
- V2-T5.2 cache 只保留 metadata，不持久化业务数据；手动刷新当前 database 的完整对象链，连接级 DDL 失效采用保守的整连接清理，避免解析 DDL 目标命名空间出错。
- V2-T5.3 JOIN 候选不解析 FOREIGN KEY：只对当前命名空间已加载列使用 `target_id → target.id`、反向或同名 key/id 启发式；关系证据不足时不建议。
- V2-T5.4 metadata 请求使用单调 epoch 防 ABA：快速 A→B→A 后，最早 A 即使名称重新匹配也不能写 UI/cache；大 schema 门禁覆盖 2000 表/16000 列和 5000 次 cache 写入。
- V2-T7.3 keepalive 配置默认启用 60s / 3 次；旧记录缺少失败阈值时补 3，已有显式启用状态和间隔不改写。后端统一把 0 归一化为 1，并按 russh `alive_timeouts > keepalive_max` 换算阈值。
- V2-T7.2 保持“用户触发重连”，不新增后台自动重试或 reconnecting 公共状态；open/reconnect 返回 session_id，reconnect/close 用 expected_session_id 防 ABA，同连接生命周期锁不阻塞其他连接。
- V2-T7.1 使用 russh `send_ping()` 的 SSH global-request 往返时间，语义是“本机到第 N 跳 SSH session 的累计 RTT”，不是 ICMP 或单段延迟；非 `Sync` 的 Handle 由 session actor 独占，探测等待期间优先处理 `direct-tcpip`，超时/不可用不改变四态连接状态。
- v0.2 开工前不重做 v0.1.0 发布验收；Phase 0 的应用内升级实测和 PostgreSQL 版本基线现已完成，只剩影响代码承诺的已知缺口。发布后的稳定时长和社区反馈只用于调整 P2 优先级。
- PostgreSQL v0.2 正式支持 15-18，最低版本为 15；必测 `15.latest` 与当前最新稳定大版本 `18.latest`。14 及以下仅 best-effort 且不主动阻止连接；若 RC 前 PostgreSQL 19 正式发布，则补一次最新 GA 发布回归。
- 更新检查反馈按触发来源区分：后台每日检查无更新或失败时保持静默；用户从应用菜单手动检查时必须显示“已是最新版本”或失败原因。
- `docs/PLAN.md` 只保留未完成事项；v0.1 已实现周计划、旧检查点和评审落地表从当前计划移除，历史继续由 `progress.md` 保存。
- 外部 dogfooding 完成状态以用户提交 `4f54f02` 为准；tag、应用版本和媒体资产继续以 Git / 文件系统事实为准，不能把 checklist 勾选当成已发布。
- `activeContext.md` 只保留当前状态；历史决策和已解决问题继续放 `progress.md`。
- ignored 的 `docs/dogfooding-log.md` 继续只保存脱敏环境细节；完成状态以用户提交 `4f54f02` 为准，本轮不读取或改写该文件。

- V2-T4.1 采用「集中 KDF 元信息 + 最小 envelope」：security.json 存 Argon2id 参数/盐/verifier，数据文件 envelope 只带 v/nonce/data；v1/v2 按文件嗅探，未启用主密码保持 v1 行为零变化。
- zeroize 精确约束 =1.8.1（1.9 起 MSRV 1.85 会破坏项目 1.77.2 承诺）；argon2 0.5 / rust_xlsxwriter 0.83 / tauri-plugin-dialog 2.7 的 MSRV 与 license（均 MIT/Apache）已审计。
- 多 tab 采用「表预览按表去重（已有同表预览 tab 只激活不新开）、重连/建库保留 SQL 只复位执行态」语义；query 迟到守卫从单 query_id 升级为 tab-local query_id。
- 导出重新执行当前 SQL 并在后端流式写文件（不经过前端序列化）；只允许只读 SQL；CSV NULL 字面量与加引号空串/"NULL" 文本严格区分。
- V2-T7.4 决策保留现有公共契约（不新增 KILL QUERY 四状态/统一状态机），重审触发条件已记录到 progress.md。

## 下一步（按优先级）

1. v0.3.0-rc1 全平台下载安装验收（V3-T7.4 遗留项，随 RC 发布执行）。
2. `just release v0.3.0` 正式发布（V3-CP5）。

## 阻塞 / 风险

- **高级设置仅部分生效**：连接超时与 SSH keepalive 已接线；读取/写入超时、压缩、自动连接仍只持久化，不能描述成已生效。
- **正式版未经历完整 RC 试用周期**：T8.2 提前关闭，若 v0.2.0 后出现 P0/P1 需随时准备 v0.2.1 补丁并优先于 v0.3 开发。
- **PG session 客户端截断/取消后事务大概率保不住**：协议残留低频路径，session 验证失败即 session_broken，前端引导重建；已如实写入 ARCHITECTURE 与 PLAN 风险。

相关：[[progress]] · [[systemPatterns]]
