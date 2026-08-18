# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-08-18

## 当前状态

**v0.1.0 已于 2026-08-18 正式发布。** v0.1 实现、dogfooding、MySQL 5.7、作者与同事试用、全平台构建、签名更新产物和 `latest.json` 均已闭环。v0.2 已形成 8 周实施计划；开工前只需处理影响代码承诺的已知缺口、完成应用内升级实测并固化 PostgreSQL 版本基线，README 真实 GIF 可随 v0.1.1 补充。

### 本轮核对后的事实基线

- Git：`v0.1.0` tag 指向发布提交 `624b108`；发布后的文档对齐提交将继续落在 `main`，不移动 tag。
- 版本：`package.json`、`Cargo.lock`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 一致为 `0.1.0`。
- 本地门禁：`just check`、4 个真实 MySQL integration test 与本机 Tauri 生产构建均通过。
- Release：workflow run `32110227419` 的 macOS arm64/x64、Windows x64、Linux x64 与发布 job 全部成功；GitHub Release 为非草稿、非预发布且是 latest。
- 产物：四个平台安装包、updater artifact / `.sig` 与 `latest.json` 均已验证；manifest 的四个平台 URL 均指向 `v0.1.0` 资产。
- 自动更新：“旧正式版发现新正式版 → 下载 → 安装 → 重启”的应用内端到端流程仍未实测。
- P0 SQL/SSH 修复：2026-07-13 已在真实 MySQL 上验证元数据语句、JOIN 重名列、顶层 LIMIT、截断止损和测试连接 host key 校验；当时 `just check` 与 4 个 integration test 通过。
- 本轮文档对齐：已按代码、Git 与 GitHub Release / Actions 事实修正 README、核心 docs、memory-bank 及两处过时代码/CI 注释；`just lint` 与 `git diff --check` 通过。没有用户可见行为变化，因此不改 `CHANGELOG.md`。

## 已实现能力

- 连接管理：CRUD、最近使用排序、复制、右键菜单、新建 / 编辑 Dialog、全局 AlertDialog 确认。
- 连接配置：常规 / SSH / SSL / 高级四标签页；SSL 模式和证书路径、连接超时会传给 driver；读取 / 写入超时、keepalive 间隔、压缩、自动连接当前仅持久化，尚未影响运行行为。
- SSH：N 跳 russh 隧道、密码/私钥认证、per-connection passphrase 会话缓存、TOFU 与指纹变更硬拒绝；russh 内置 60s keepalive / 3 次阈值，监控 task 上报 `lost`。
- MySQL：database / table / column 后端查询、表前 1000 行、新建数据库、CodeMirror SQL 执行、10 万行硬上限、顶层安全追加 LIMIT、客户端截断 + `KILL QUERY` 止损、独立 control pool 取消。
- SQL 分类：SELECT/WITH 为读；SHOW/EXPLAIN/DESC/DESCRIBE 为元数据；其余需 `allow_write`。前后端规则同构，`EXPLAIN ANALYZE` 写语句仍需确认。
- UI：纯 CSS 拓扑图、数据库 / 表图标、数据库折叠状态与当前选择分离、react-virtuoso 结果表格。
- 发布：`v*` tag 全平台构建；预发布不生成 `latest.json`，正式版生成 stable-only updater manifest。

## 已知代码 / 承诺边界

- MySQL TLS 已接线 SSL 模式和证书路径，但真实 TLS / 双向证书环境尚未验收。
- SSH keepalive 使用 russh 内置机制 + 轻量监控 task；运行期会统一上报 `lost`。
- `SshTunnelError::ChannelDropped` / `AcceptLoopDied` 目前只定义并测试 i18n key，没有运行路径主动构造；运行期实际只通过 `HopStatus::Lost` 上报 keepalive 断开。
- `connection_test` 不接收私钥 passphrase，也不使用会话缓存；带口令私钥的“测试连接”不能覆盖完整链路，正式 `connection_open` 才支持 passphrase 弹窗/缓存。
- CodeMirror 有 `extractSqlErrorLine` 与 server-line gutter 接线，但 Tauri query command 只返回 `error.driver.query_failed`，不会透传 MySQL 原文；因此服务端 `line N` 标识当前实际不会出现。

## 活跃文件

- `crates/ssh-multihop/src/lib.rs`：N 跳隧道、russh keepalive、监控 task、host key verifier、公共错误模型。
- `crates/db-driver/src/lib.rs`：SSL settings、SQL 分类 / LIMIT / 截断 / control pool、CREATE DATABASE。
- `src-tauri/src/commands/{connection,query}.rs`：连接打开/测试、passphrase、TOFU、查询与取消命令。
- `src-tauri/src/config/{store,encryption,ssh_known_hosts}.rs`：加密连接配置与信任库。
- `src/components/{connection-form,schema-browser,topology-graph}.tsx`：连接表单、SQL/结果区和拓扑。
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
- v0.2 开工前不重做 v0.1.0 发布验收；只处理影响代码承诺的已知缺口、应用内升级实测和 PostgreSQL 版本基线。发布后的稳定时长和社区反馈只用于调整 P2 优先级。
- `docs/PLAN.md` 只保留未完成事项；v0.1 已实现周计划、旧检查点和评审落地表从当前计划移除，历史继续由 `progress.md` 保存。
- 外部 dogfooding 完成状态以用户提交 `4f54f02` 为准；tag、应用版本和媒体资产继续以 Git / 文件系统事实为准，不能把 checklist 勾选当成已发布。
- `activeContext.md` 只保留当前状态；历史决策和已解决问题继续放 `progress.md`。
- ignored 的 `docs/dogfooding-log.md` 继续只保存脱敏环境细节；完成状态以用户提交 `4f54f02` 为准，本轮不读取或改写该文件。

## 下一步（按优先级）

1. 从 v0.0.3 验证应用内发现、下载、安装并重启到 v0.1.0。
2. 决定并补齐三类代码缺口：带 passphrase 私钥的 `connection_test`；`ChannelDropped` / `AcceptLoopDied` 的运行时检测与上报；安全传递 MySQL 行号的结构化错误契约。
3. 在 `techContext.md` 固化 PostgreSQL 最低支持版本与测试版本，通过 V2-CP0 后启动 v0.2 Week 1。
4. 补 README “右键打开”与多跳拓扑真实 GIF，可随 v0.1.1 发布。

## 阻塞 / 风险

- **两类 SSH 承诺与运行实现不完全一致**：passphrase 测试连接、ChannelDropped / AcceptLoopDied 检测需决定是补代码还是降级 v0.1 需求。
- **MySQL 服务端错误行标识未真正接通**：前端解析逻辑存在，但后端只返回稳定 key；需设计结构化错误 payload，不能直接泄露原始 Rust 错误。
- **MySQL TLS 只完成接线**：真实 TLS/双向证书与错误 UX 未验收。
- **高级设置部分仅持久化**：读取/写入超时、keepalive 间隔、压缩、自动连接不能描述成已生效。
- **应用内升级仍缺端到端实测**：`latest.json` 与下载 URL 已验证，但尚未从 v0.0.3 真实执行安装并重启到 v0.1.0。
- **README GIF 缺失**：不影响 v0.1.0 已发布事实，留作 v0.1.1 候选文档改进。
- **v0.2 范围约 98h**：必须执行 Week 6 降级规则，禁止为了完整 P2 挤压 driver、凭据和 TLS 安全门槛。

相关：[[progress]] · [[systemPatterns]]
