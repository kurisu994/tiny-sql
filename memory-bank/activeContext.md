# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-08-18

## 当前状态

**v0.1.0 已于 2026-08-18 正式发布，v0.2 Week 1 正在推进。** V2-T1.1 Driver 契约、V2-T1.2 连接类型/无损迁移与 V2-T1.4 MySQL 回归已完成；V2-T1.3 PostgreSQL vertical slice 代码已实现，但缺少本地测试 URL，真实 `SELECT 1` 通过前不标记完成。三项 v0.1 代码承诺缺口仍按事实保留。

### 本轮核对后的事实基线

- Git：`v0.1.0` tag 指向发布提交 `624b108`；发布后的文档对齐提交将继续落在 `main`，不移动 tag。
- 版本：`package.json`、`Cargo.lock`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 一致为 `0.1.0`。
- 本地门禁：`just check`、5 个真实 MySQL integration test 与本机 Tauri 生产构建均通过。
- Release：workflow run `32110227419` 的 macOS arm64/x64、Windows x64、Linux x64 与发布 job 全部成功；GitHub Release 为非草稿、非预发布且是 latest。
- 产物：四个平台安装包、updater artifact / `.sig` 与 `latest.json` 均已验证；manifest 的四个平台 URL 均指向 `v0.1.0` 资产。
- 自动更新：已在 `/Applications/tiny-sql.app` 从 v0.0.3 通过原生菜单 `Check for Updates...` 发现 v0.1.0，完成签名更新包下载、安装和重启；重启后 bundle 版本为 0.1.0，连接配置保留，更新菜单仍可用。
- 手动检查更新反馈：应用菜单触发检查后，有更新继续打开下载弹窗；无更新改为弹窗提示“当前已是最新版本”，失败也显示结果。后台每日自动检查保持静默。
- P0 SQL/SSH 修复：2026-07-13 已在真实 MySQL 上验证元数据语句、JOIN 重名列、顶层 LIMIT、截断止损和测试连接 host key 校验；当时 `just check` 与 4 个 integration test 通过。
- v0.2 当前验证：`db-driver` 18 个单测、7 个连接加密存储测试、9 个前端针对性测试和 5 个真实 MySQL integration 通过；PostgreSQL integration 因缺少 `TINY_SQL_TEST_POSTGRES_URL` 明确失败，未记为通过。

## 已实现能力

- 连接管理：CRUD、最近使用排序、复制、右键菜单、新建 / 编辑 Dialog、全局 AlertDialog 确认。
- 连接配置：已持久化显式 `mysql` / `postgresql` driver；旧密文缺字段时默认 MySQL 且读取不重写，失败保留原文件。常规 / SSH / SSL / 高级四标签页保持不变，数据库类型选择器留 Week 3。
- SSH：N 跳 russh 隧道、密码/私钥认证、per-connection passphrase 会话缓存、TOFU 与指纹变更硬拒绝；russh 内置 60s keepalive / 3 次阈值，监控 task 上报 `lost`。
- MySQL：database / table / column 后端查询、表前 1000 行、新建数据库、CodeMirror SQL 执行、10 万行硬上限、顶层安全追加 LIMIT、客户端截断 + `KILL QUERY` 止损、独立 control pool 取消。
- 多 driver 基础：对象安全的 `Driver` 契约已覆盖 ping、metadata、query/取消与 close；MySQL 的 Tauri 生产调用面已通过契约接线，连接创建与方言专属操作仍留在具体实现。
- PostgreSQL vertical slice：已实现 `PostgresDriver` 直连、`SELECT 1::BIGINT` 与 close，启用 sqlx `postgres` feature；尚未接入完整 Driver/AppState，也未完成真实数据库验证。
- SQL 分类：SELECT/WITH 为读；SHOW/EXPLAIN/DESC/DESCRIBE 为元数据；其余需 `allow_write`。前后端规则同构，`EXPLAIN ANALYZE` 写语句仍需确认。
- UI：纯 CSS 拓扑图、数据库 / 表图标、数据库折叠状态与当前选择分离、react-virtuoso 结果表格。
- 发布：`v*` tag 全平台构建；预发布不生成 `latest.json`，正式版生成 stable-only updater manifest；手动检查更新无新版本或失败时显示结果弹窗。

## 已知代码 / 承诺边界

- MySQL TLS 已接线 SSL 模式和证书路径，但真实 TLS / 双向证书环境尚未验收。
- SSH keepalive 使用 russh 内置机制 + 轻量监控 task；运行期会统一上报 `lost`。
- `SshTunnelError::ChannelDropped` / `AcceptLoopDied` 目前只定义并测试 i18n key，没有运行路径主动构造；运行期实际只通过 `HopStatus::Lost` 上报 keepalive 断开。
- `connection_test` 不接收私钥 passphrase，也不使用会话缓存；带口令私钥的“测试连接”不能覆盖完整链路，正式 `connection_open` 才支持 passphrase 弹窗/缓存。
- CodeMirror 有 `extractSqlErrorLine` 与 server-line gutter 接线，但 Tauri query command 只返回 `error.driver.query_failed`，不会透传 MySQL 原文；因此服务端 `line N` 标识当前实际不会出现。

## 活跃文件

- `crates/ssh-multihop/src/lib.rs`：N 跳隧道、russh keepalive、监控 task、host key verifier、公共错误模型。
- `crates/db-driver/src/lib.rs`：对象安全 Driver 契约、MySQL 实现、SSL settings、SQL 分类 / LIMIT / 截断 / control pool、CREATE DATABASE。
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
- V2-T1.2 采用只读兼容迁移：旧记录缺 `driver` 时内存默认 MySQL，显式保存才升级密文；未知 driver 失败不覆盖文件。PostgreSQL 尚未接入运行路径时明确拒绝，不静默回退 MySQL。
- PostgreSQL 显式连接不读取 `~/.pgpass`；integration 拆为 MySQL/PostgreSQL 独立命令，显式执行 PostgreSQL 门禁时缺 URL 必须失败，避免假绿。
- v0.2 开工前不重做 v0.1.0 发布验收；Phase 0 的应用内升级实测和 PostgreSQL 版本基线现已完成，只剩影响代码承诺的已知缺口。发布后的稳定时长和社区反馈只用于调整 P2 优先级。
- PostgreSQL v0.2 正式支持 15-18，最低版本为 15；必测 `15.latest` 与当前最新稳定大版本 `18.latest`。14 及以下仅 best-effort 且不主动阻止连接；若 RC 前 PostgreSQL 19 正式发布，则补一次最新 GA 发布回归。
- 更新检查反馈按触发来源区分：后台每日检查无更新或失败时保持静默；用户从应用菜单手动检查时必须显示“已是最新版本”或失败原因。
- `docs/PLAN.md` 只保留未完成事项；v0.1 已实现周计划、旧检查点和评审落地表从当前计划移除，历史继续由 `progress.md` 保存。
- 外部 dogfooding 完成状态以用户提交 `4f54f02` 为准；tag、应用版本和媒体资产继续以 Git / 文件系统事实为准，不能把 checklist 勾选当成已发布。
- `activeContext.md` 只保留当前状态；历史决策和已解决问题继续放 `progress.md`。
- ignored 的 `docs/dogfooding-log.md` 继续只保存脱敏环境细节；完成状态以用户提交 `4f54f02` 为准，本轮不读取或改写该文件。

## 下一步（按优先级）

1. 用户配置 `TINY_SQL_TEST_POSTGRES_URL` 后运行 `just test-postgres-integration`，取得真实 `SELECT 1` 证据并完成 V2-T1.3 / CP1 技术主链。
2. 在不伪造 PostgreSQL 实测的前提下推进 Week 2 metadata/query 代码与测试夹具。
3. 并行决定并补齐三类 v0.1 代码承诺缺口：passphrase 测试连接、SSH 运行时错误上报、MySQL 行号结构化错误契约。

## 阻塞 / 风险

- **两类 SSH 承诺与运行实现不完全一致**：passphrase 测试连接、ChannelDropped / AcceptLoopDied 检测需决定是补代码还是降级 v0.1 需求。
- **MySQL 服务端错误行标识未真正接通**：前端解析逻辑存在，但后端只返回稳定 key；需设计结构化错误 payload，不能直接泄露原始 Rust 错误。
- **MySQL TLS 只完成接线**：真实 TLS/双向证书与错误 UX 未验收。
- **高级设置部分仅持久化**：读取/写入超时、keepalive 间隔、压缩、自动连接不能描述成已生效。
- **v0.2 范围约 98h**：必须执行 Week 6 降级规则，禁止为了完整 P2 挤压 driver、凭据和 TLS 安全门槛。
- **PostgreSQL 真实环境未配置**：代码和门禁已就绪，但没有 `TINY_SQL_TEST_POSTGRES_URL`，不能宣称 T1.3 或 CP1 通过。

相关：[[progress]] · [[systemPatterns]]
