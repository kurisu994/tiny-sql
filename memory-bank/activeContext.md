# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-08-18

## 当前状态

**v0.1.0 已于 2026-08-18 正式发布，v0.2 Week 1/2 后端、Week 3 多 driver 应用接线与 V2-T5.1-T5.3 schema intelligence 主链已完成。** PostgreSQL 已接入 `AppState`、Tauri commands、连接表单和 database → schema → table → column 浏览树；MySQL/PostgreSQL 真实 driver integration 共 9 项全绿。带口令私钥测试、SSH 三类运行故障上报和安全 SQL 行号三项历史代码承诺均已关闭，V2-CP1 已通过；Tauri 调试包已验证 MySQL 直连、元数据树与 `SELECT 1`，V2-T3.4 仍缺 PostgreSQL、切换/取消与 1 跳 SSH 验收，因此 CP2 保持未完成。

### 本轮核对后的事实基线

- Git：`v0.1.0` tag 指向发布提交 `624b108`；发布后的文档对齐提交将继续落在 `main`，不移动 tag。
- 版本：`package.json`、`Cargo.lock`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 一致为 `0.1.0`。
- 本地门禁：`just check`、5 个真实 MySQL integration test 与本机 Tauri 生产构建均通过。
- Release：workflow run `32110227419` 的 macOS arm64/x64、Windows x64、Linux x64 与发布 job 全部成功；GitHub Release 为非草稿、非预发布且是 latest。
- 产物：四个平台安装包、updater artifact / `.sig` 与 `latest.json` 均已验证；manifest 的四个平台 URL 均指向 `v0.1.0` 资产。
- 自动更新：已在 `/Applications/tiny-sql.app` 从 v0.0.3 通过原生菜单 `Check for Updates...` 发现 v0.1.0，完成签名更新包下载、安装和重启；重启后 bundle 版本为 0.1.0，连接配置保留，更新菜单仍可用。
- 手动检查更新反馈：应用菜单触发检查后，有更新继续打开下载弹窗；无更新改为弹窗提示“当前已是最新版本”，失败也显示结果。后台每日自动检查保持静默。
- P0 SQL/SSH 修复：2026-07-13 已在真实 MySQL 上验证元数据语句、JOIN 重名列、顶层 LIMIT、截断止损和测试连接 host key 校验；当时 `just check` 与 4 个 integration test 通过。
- v0.2 当前验证：`db-driver` 26 个单测、`ssh-multihop` 5 个单测、`app_lib` 18 个单测、前端 59 个测试及 workspace Clippy/TypeScript/Next.js build 均通过；5 个真实 MySQL integration 与 4 个真实 PostgreSQL integration 全绿。PostgreSQL 15/18 双端点仍留正式版兼容矩阵，当前单一本地实例不能替代。

## 已实现能力

- 连接管理：CRUD、最近使用排序、复制、右键菜单、新建 / 编辑 Dialog、全局 AlertDialog 确认。
- 连接配置：已持久化显式 `mysql` / `postgresql` driver；旧密文缺字段时默认 MySQL 且读取不重写，失败保留原文件。常规页已提供数据库类型选择器，切换时按未编辑默认值联动 3306/root 或 5432/postgres；PostgreSQL 暂用 driver 默认 TLS 策略并禁用尚未接线的证书路径页。
- SSH：N 跳 russh 隧道、密码/私钥认证、per-connection passphrase 会话缓存、TOFU 与指纹变更硬拒绝；测试连接支持一次性 passphrase 且不保存/缓存；russh 内置 60s keepalive / 3 次阈值，监控 task 上报 `lost`。
- MySQL：database / table / column 后端查询、表前 1000 行、新建数据库、CodeMirror SQL 执行、10 万行硬上限、顶层安全追加 LIMIT、客户端截断 + `KILL QUERY` 止损、独立 control pool 取消。
- 多 driver 基础：对象安全的 `Driver` 契约已覆盖 kind、ping、database/schema/table/column metadata、query/取消与 close；`MetadataScope` 显式区分 database/schema，MySQL 的 Tauri 生产调用面保持兼容。
- PostgreSQL：独立 `postgres.rs` 已实现直连、四层 metadata、query/动态解码、DML `RETURNING`、10 万行上限与独立 control pool `pg_cancel_backend` 取消；`ActiveDriver`、通用 commands、连接表单和 schema 浏览树均已接线，真实 integration 全绿。
- SQL 分类：SELECT/WITH 为读；SHOW/EXPLAIN/DESC/DESCRIBE 为元数据；其余需 `allow_write`。前后端规则同构，`EXPLAIN ANALYZE` 写语句仍需确认。
- UI：纯 CSS 拓扑图、database/schema/table/column 树、按需列元信息、手动对象刷新、数据库折叠状态与当前选择分离、react-virtuoso 结果表格。
- Metadata cache：schema/table/column 使用 128 项、5 分钟 TTL 的进程内 LRU，按 connection/driver/database/schema/resource/table 完整隔离；重连、建库、成功 DDL 和手动刷新会失效。
- SQL completion：按 driver 使用 MySQL/PostgreSQL dialect；已加载列进入 CodeMirror schema，提供 column/alias 及保守的 JOIN + ON 片段候选。
- 发布：`v*` tag 全平台构建；预发布不生成 `latest.json`，正式版生成 stable-only updater manifest；手动检查更新无新版本或失败时显示结果弹窗。

## 已知代码 / 承诺边界

- MySQL TLS 已接线 SSL 模式和证书路径，但真实 TLS / 双向证书环境尚未验收。
- SSH keepalive 使用 russh 内置机制 + 轻量监控 task；运行期会统一上报 `lost`。
- SSH 运行期首跳 session、嵌套 transport channel 与 accept worker 故障均已接入 `lost` 事件；shutdown 与每跳原子标记分别抑制正常关闭误报和重复断链事件。
- `connection_test` 已支持瞬时私钥 passphrase，但不会复用或写入正式连接的会话缓存；持久化 passphrase 仍留 Week 4 用户主密码方案。
- Tauri query error 使用 `{ key, line? }` 安全载荷；db-driver 只从后端原始错误提取正整数行号，CodeMirror 继续从本地化文案标记 gutter，原始数据库错误与 SQL 片段不进入 IPC。
- PostgreSQL 当前只展开连接实际所在的 database；浏览其他 database 需新建目标连接。证书路径尚未传给 PostgreSQL driver，真实 Tauri 直连/1 跳 SSH 仍待 V2-T3.4 验收。

## 活跃文件

- `crates/ssh-multihop/src/lib.rs`：N 跳隧道、russh keepalive、监控 task、host key verifier、公共错误模型。
- `crates/db-driver/src/lib.rs`：公共 Driver/metadata 契约、MySQL 实现、共享 SQL guard、动态结果解码。
- `crates/db-driver/src/postgres.rs`：PostgreSQL connect、metadata、query/RETURNING、control pool 取消。
- `src-tauri/src/state.rs`：`ActiveDriver::{MySql, PostgreSql}` 与活跃连接/隧道生命周期注册表。
- `src-tauri/src/commands/{connection,query}.rs`：连接打开/测试、passphrase、TOFU、查询与取消命令。
- `src-tauri/src/config/{store,encryption,ssh_known_hosts}.rs`：加密连接配置与信任库。
- `src/components/{connection-form,schema-browser,topology-graph}.tsx`：连接表单、SQL/结果区和拓扑。
- `src/components/update-check-result-dialog.tsx`、`src/hooks/use-update-checker.ts`：手动检查更新结果弹窗与状态管理。
- `.github/workflows/{ci,release}.yml`、`justfile`：质量检查、全平台发布、版本脚本。
- `README.md`、`docs/{REQUIREMENTS,PLAN,ARCHITECTURE,ROADMAP,RELEASE_CHECKLIST}.md`、`memory-bank/*`：本轮对齐范围。

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
- metadata 契约使用显式 `database + optional schema`；PostgreSQL 不能在同一连接切换 database，跨库请求返回稳定 key。当前 UI 只展开连接所在 database，跨库浏览需新建对应连接，不做隐式重连。
- PostgreSQL 取消使用独立 control pool 调 `pg_cancel_backend`；取消或无服务端 LIMIT 的客户端截断后关闭执行连接，避免协议残留回池。MySQL JSON 同步改用 sqlx `JsonValue`，真实测试不再返回 `<unsupported>`。
- SQL guard 按方言处理 PostgreSQL `TABLE`/`VALUES`、`OFFSET`/`FETCH` 与 dollar-quoted body；数据修改 CTE 仍需写确认，DML `RETURNING` 确认后返回结果行。
- V2-CP1 三项历史承诺均以代码关闭：测试连接 passphrase 仅作瞬时参数；SSH 运行期断链按首跳/channel/accept worker 分类并去重；查询错误 IPC 只含稳定 key 与可选正整数行号。
- V2-T5.2 cache 只保留 metadata，不持久化业务数据；手动刷新当前 database 的完整对象链，连接级 DDL 失效采用保守的整连接清理，避免解析 DDL 目标命名空间出错。
- V2-T5.3 JOIN 候选不解析 FOREIGN KEY：只对当前命名空间已加载列使用 `target_id → target.id`、反向或同名 key/id 启发式；关系证据不足时不建议。
- v0.2 开工前不重做 v0.1.0 发布验收；Phase 0 的应用内升级实测和 PostgreSQL 版本基线现已完成，只剩影响代码承诺的已知缺口。发布后的稳定时长和社区反馈只用于调整 P2 优先级。
- PostgreSQL v0.2 正式支持 15-18，最低版本为 15；必测 `15.latest` 与当前最新稳定大版本 `18.latest`。14 及以下仅 best-effort 且不主动阻止连接；若 RC 前 PostgreSQL 19 正式发布，则补一次最新 GA 发布回归。
- 更新检查反馈按触发来源区分：后台每日检查无更新或失败时保持静默；用户从应用菜单手动检查时必须显示“已是最新版本”或失败原因。
- `docs/PLAN.md` 只保留未完成事项；v0.1 已实现周计划、旧检查点和评审落地表从当前计划移除，历史继续由 `progress.md` 保存。
- 外部 dogfooding 完成状态以用户提交 `4f54f02` 为准；tag、应用版本和媒体资产继续以 Git / 文件系统事实为准，不能把 checklist 勾选当成已发布。
- `activeContext.md` 只保留当前状态；历史决策和已解决问题继续放 `progress.md`。
- ignored 的 `docs/dogfooding-log.md` 继续只保存脱敏环境细节；完成状态以用户提交 `4f54f02` 为准，本轮不读取或改写该文件。

## 下一步（按优先级）

1. 完成 V2-T3.4：在真实 Tauri 应用中补验 PostgreSQL 直连、MySQL/PostgreSQL 各自 1 跳 SSH、连接切换与取消不串线，通过后关闭 V2-CP2。
2. 确认 Week 4 安全方案：Argon2id v19（19 MiB / t=2 / p=1）派生 32 字节 key、AES-256-GCM v2 envelope、后端独立 secrets map 与可回滚原子迁移；确认后再改存储协议。
3. 完成 V2-T5.4：回归大 schema 性能、并发 metadata 请求和快速切换 schema，证明旧请求不会覆盖新选择。
4. 准备真实 MySQL TLS 正反例环境，验收 CA、hostname 与客户端证书路径。

## 阻塞 / 风险

- **MySQL TLS 只完成接线**：真实 TLS/双向证书与错误 UX 未验收。
- **高级设置部分仅持久化**：读取/写入超时、keepalive 间隔、压缩、自动连接不能描述成已生效。
- **v0.2 范围约 98h**：必须执行 Week 6 降级规则，禁止为了完整 P2 挤压 driver、凭据和 TLS 安全门槛。
- **PostgreSQL 版本矩阵未完成**：当前真实本地实例已通过后端契约，但 PostgreSQL 15.latest / 18.latest 双端点仍需在 RC 前分别回归。
- **PostgreSQL 应用验收未完成**：自动门禁已覆盖 driver、AppState、commands 与前端状态，但真实 Tauri 直连/1 跳 SSH、切换和取消仍需人工验证。
- **Week 4 安全存储方案待确认**：候选 `argon2 0.5.3` 已在锁文件且官方 MSRV 为 Rust 1.65；`zeroize 1.9.0` 虽已是传递依赖，但官方 MSRV 为 1.85，高于项目声明 1.77.2，直接依赖时拟精确约束到兼容的 1.8.x 并重新验证依赖树。

相关：[[progress]] · [[systemPatterns]]
