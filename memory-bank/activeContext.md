# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-08-19

## 当前状态

**本轮新增：PostgreSQL 跨 database 浏览的「一键切换」引导**——`selectDb`/`refreshMetadata` 捕获 `error.driver.database_switch_required` 时记录 `pendingDbSwitch`，错误横幅出现「切换到 <db>」按钮；点击后以 session 级 `databaseOverride` 走标准重连（`connection_reconnect` 新增可选参数，不落盘），成功后自动选中目标库。关闭后重新打开仍是保存配置里的原 database。前端 tsc + vitest（session-store 35、schema-browser 3）与 cargo clippy/test（45）全绿。

**v0.2 全部代码事项已完成：Week 4 主密码加密/TLS 代码、Week 6 查询工作台（历史/多 tab/导出/列宽）本周落地，加上此前的 Week 1-3 多 driver、Week 5 schema intelligence、Week 7 RTT/重连/状态决策，v0.2 自动化门禁全绿。** 剩余均为真实环境/人工验收：V2-T3.4（PostgreSQL Tauri 直连/切换/取消/1 跳 SSH）、V2-T4.3（真实 TLS 正反例）、V2-T8.1/T8.2（双 driver dogfooding）、V2-T8.4（RC 全平台下载与发布）。

本轮门禁事实：`just check` 全绿（app_lib 45、db-driver 27、ssh-multihop 8、前端 90 项测试、TypeScript、Next.js 生产构建）；真实 MySQL 5/5 与 PostgreSQL 4/4 integration 全绿；本机 Tauri debug bundle + dmg + updater 签名产物构建成功。

### 本轮核对后的事实基线

- Git：`v0.1.0` tag 指向发布提交 `624b108`；发布后的文档对齐提交将继续落在 `main`，不移动 tag。
- 版本：`package.json`、`Cargo.lock`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 一致为 `0.1.0`。
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

- MySQL TLS 已接线 SSL 模式和证书路径，但真实 TLS / 双向证书环境尚未验收。
- SSH keepalive 使用 russh 内置机制 + 轻量只读监控 task；运行期会统一上报 `lost`，监控不会额外发包或改变配置间隔。
- SSH 运行期首跳 session、嵌套 transport channel 与 accept worker 故障均已接入 `lost` 事件；shutdown 与每跳原子标记分别抑制正常关闭误报和重复断链事件。
- `connection_test` 的 passphrase 仍为瞬时参数（不落盘、不进会话缓存）；正式连接的 passphrase 在启用主密码后可经 secrets.enc 持久化，否则仅会话缓存（Zeroizing）。
- Tauri query error 使用 `{ key, line? }` 安全载荷；db-driver 只从后端原始错误提取正整数行号，CodeMirror 继续从本地化文案标记 gutter，原始数据库错误与 SQL 片段不进入 IPC。
- PostgreSQL 同一连接只展开当前 database；浏览其他 database 时错误横幅提供一键切换（session 级 override 重连，不落盘，重开仍是原库），不做隐式重连。证书路径尚未传给 PostgreSQL driver，真实 Tauri 直连/1 跳 SSH 仍待 V2-T3.4 验收。

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
- 多 tab 采用「表预览新开 tab、重连/建库保留 SQL 只复位执行态」语义；query 迟到守卫从单 query_id 升级为 tab-local query_id。
- 导出重新执行当前 SQL 并在后端流式写文件（不经过前端序列化）；只允许只读 SQL；CSV NULL 字面量与加引号空串/"NULL" 文本严格区分。
- V2-T7.4 决策保留现有公共契约（不新增 KILL QUERY 四状态/统一状态机），重审触发条件已记录到 progress.md。

## 下一步（按优先级）

1. V2-T3.4 人工验收：用 `target/debug/bundle` 的调试包补验 PostgreSQL 直连、双 driver 切换/取消不串线、各自 1 跳 SSH，通过后关闭 V2-CP2。
2. V2-T4.3 人工验收：准备真实 TLS MySQL（含自签 CA 与双向证书），跑 Preferred/Required/Verify CA/Verify Identity 正反例。
3. 真实多跳环境验收 T7.1 RTT 数值/超时与 T7.2 中间跳断链 lost → 重连闭环。
4. Week 8：双 driver 0/1/3 跳 dogfooding（T8.1）→ ≥2 位试用者 1 周 RC（T8.2）→ `just release v0.2.0-rc1` 全平台下载验收（T8.4）→ P0/P1 清零后发布 v0.2.0。
5. RC 前补 PostgreSQL 15.latest / 18.latest 双端点兼容回归。

## 阻塞 / 风险

- **MySQL TLS 真实验收仍缺环境**：错误分类 key 与证书选择 UX 已就绪，正反例需真实 TLS MySQL（V2-T8.1）。
- **高级设置仅部分生效**：连接超时与 SSH keepalive 已接线；读取/写入超时、压缩、自动连接仍只持久化，不能描述成已生效。
- **v0.2 范围约 98h**：必须执行 Week 6 降级规则，禁止为了完整 P2 挤压 driver、凭据和 TLS 安全门槛。
- **PostgreSQL 版本矩阵未完成**：当前真实本地实例已通过后端契约，但 PostgreSQL 15.latest / 18.latest 双端点仍需在 RC 前分别回归。
- **PostgreSQL 应用验收未完成**：自动门禁已覆盖 driver、AppState、commands 与前端状态，但真实 Tauri 直连/1 跳 SSH、切换和取消仍需人工验证。
- **重连真实链路未验收**：自动门禁已覆盖资源清理边界、旧查询结果与旧 SSH 事件隔离；仍需真实中间跳断链后确认 lost → 重连 → connected 且无旧 task/event 泄漏。
- **SSH RTT 真实链路未验收**：代码、事件/UI 回归与全量门禁已完成，但当前环境没有可控的真实多跳端点；累计 RTT 数值、2 秒超时和 direct-tcpip 并发仍需 RC 人工验收。

相关：[[progress]] · [[systemPatterns]]
