# 当前任务（main）

**最后更新**：2026-09-10

## 目标

1. 收尾 `v0.8.0` 之后的 `[Unreleased]` 体验优化（三项均已在 `495fde2` 提交，等 GUI 验收）。
2. 完成 `v0.8.0` 功能验收 + SQLite 全链路 GUI 实测。

## 验收标准

| 项 | 验收方式 | 状态 |
|---|---|---|
| 连接列表拖拽排序 | 拖拽手感；重启后顺序保持；未拖过的连接仍按最近使用倒序 | ⏳ 待用户 GUI 实测 |
| 工作台工具栏合并 | 顶部一栏含视图切换 + 对象树操作；对象树操作只在浏览视图出现 | ⏳ 待用户 GUI 实测 |
| 测试连接延迟 | 主行显示总延迟，次行列隧道 / 建立连接 / 总计；分段数值合理 | ⏳ 待用户 GUI 实测 |
| SQLite 全链路 | 新建连接 → 选文件 → 库树 / 结构 / 浏览编辑 / SQL 编辑器 / CSV 导入 / dump 导出导入 | ⏳ 待用户 GUI 实测 |
| v0.8 功能 | 只读 / 环境色 / 复制表 / 检查器 / RENAME / EXPLAIN 提示 | ⏳ 待用户 GUI 实测 |

自动化门禁本轮全绿：`cargo fmt --check` / `clippy -D warnings` / `cargo test --workspace`；vitest 218（新增 hook 6 例 + store 3 例）；`tsc` 与 `pnpm build` 通过。

> 记忆银行已于 2026-09-10 迁到四层结构（旧 6 枢纽 → `00-project` / `1X-*` / `active/` / `journal/` / `archive/`），细节见 [[journal/kurisu]] 与 [[README]]。

## 本轮决策

- **手动排序取代 `last_used_at` 自动排序**。原 FR-003 是「按 `last_used_at` 倒序」，双击连接后会自动跳顶，与手动排序直接冲突。已与用户确认：`StoredConnection` 新增 `sort_order: Option<i64>`，`connection_list` 先按序号升序，`None`（旧记录 / 新建 / 分享导入）排在其后并保留最近使用倒序作兜底，因此升级后首屏顺序与升级前一致，用户第一次拖动就把全量顺序写实。
- **拖拽不引 dnd 依赖、不用 HTML5 draggable**。理由见 [[20-frontend]]。
- **`connection_test` 返回 `ConnectionTestReport`**（`tunnelMs?` / `connectMs` / `pingMs` / `totalMs`，f64 毫秒）。分段是准的——sqlx 的 `connect_with` 是 eager 建池，握手确实发生在 connect 阶段，随后的 `Driver::ping` 走热连接，测到的才是纯往返延迟。

## 活跃文件

### 本轮改动

- `src-tauri/src/commands/connection.rs`：`connection_reorder` + `ConnectionTestReport`（原先返回 `Result<(), String>`）。
- `src-tauri/src/config/store.rs`：`sort_order` 落盘与 `ConnectionStore::reorder`（未出现的 id 保持原值，未知 id 忽略）。
- `src/hooks/use-drag-sort.ts`：拖拽 hook 本体（+ `.test.tsx`）。
- `src/components/schema-browser.tsx`、`src/app/page.tsx`：工具栏合并与对象树操作搬家；`dumpMsg` 提示状态保留在原位置（aside 顶部 sticky 条整块删除）。
- `src/lib/tauri-api.ts`、`src/stores/connection-store.ts`：类型与乐观更新。
- `docs/{ARCHITECTURE,REQUIREMENTS}.md`、`CHANGELOG.md`、`memory-bank/`：已同步。
- `crates/db-driver/src/lib.rs`：`MySqlDriver::list_constraints` 两条等值查询（结构页卡死修复）。
- `crates/db-driver/tests/integration.rs`：结构页 MySQL 元数据 3s 超时回归。

### 长期活跃（常被引用的入口）

- `crates/ssh-multihop/src/lib.rs`：N 跳隧道、session actor、keepalive、RTT / 断链监控、host key verifier。
- `crates/db-driver/src/{lib,postgres}.rs`：Driver 契约、MySQL（含 TLS 错误分类）、PostgreSQL、SQL guard；SQLite 在 `src/sqlite.rs`。
- `src-tauri/src/state.rs`：`ActiveDriver::{MySql, PostgreSql, Sqlite}` 注册表 + security / history 注入。
- `src-tauri/src/security.rs`：主密码状态机、v1↔v2 迁移回滚、secrets map（FR-102）。
- `src-tauri/src/config/{encryption,store,history,ssh_known_hosts}.rs`：v2 envelope / Argon2id KDF、连接配置与 SQL 历史加密存储、SSH 信任库。
- `src-tauri/src/commands/{connection,query,security,history,export}.rs`：连接生命周期、查询与取消、主密码命令、历史命令、流式导出。
- `src/stores/{session-store,security-store}.ts`：多 tab 查询工作台、主密码前端状态。
- `src/components/{schema-browser,security-dialogs,history-panel,connection-dialogs,connection-form,topology-graph}.tsx`：tab 条与结果区、解锁 / 安全设置、历史面板、passphrase 记住选项、证书浏览、拓扑。
- `.github/workflows/{ci,release}.yml`、`justfile`：质量检查、全平台发布、版本脚本。
- `docs/{ARCHITECTURE,REQUIREMENTS,ROADMAP}.md`、`README.md` / `README_EN.md`、`CHANGELOG.md`、`memory-bank/*`：以代码为准对齐 56 个 command、三 driver 与已落地能力。

### 其他备忘

- SQLite 备份 / 恢复走 `sqlite3 <file> ".dump"`；结构页不列 CHECK 约束（只有 `sqlite_master.sql` 原文有，不做 DDL 解析）。
- 只改文档时也会扫 `docs/*`，但历史里程碑已归档到 `archive/`，不要再往 `progress-legacy` 里追加流水。

## 下一步（按优先级）

1. GUI 验收 v0.8（只读 / 环境色 / 复制表 / 检查器 / RENAME / EXPLAIN 提示）+ SQLite 全链路实测。
2. 验收通过后由用户决定 `[Unreleased]` 三项的发布版本（预计并入下一个小版本）。
3. 之后才谈双向同步 / BI / AI（挂 v0.9+）。

## 阻塞 / 风险

- **高级设置仅部分生效**：连接超时与 SSH keepalive 已接线；读取 / 写入超时、压缩、自动连接仍只持久化，**不能描述成已生效**。
- **正式版未经历完整 RC 试用周期**：T8.2 提前关闭，若 `v0.8.0` 后出现 P0/P1 需随时准备补丁版本并优先于下一个 minor。
- **PG session 客户端截断 / 取消后事务大概率保不住**：协议残留低频路径，session 验证失败即 `session_broken`，前端引导重建；已如实写入 `ARCHITECTURE` 与 `PLAN` 风险。
- **SQLite 备份 / 恢复**依赖用户机器上有 `sqlite3` 命令行。
- **CP-4 / GUI dogfooding**：用户提交 `4f54f02` 已标记完成；真实记录在 ignored `docs/dogfooding-log.md`。
- **CP-2** Week 2/3 累计工时未正式记录；该历史检查点不再进入当前待办计划。
- **CP-3** MySQL 5.7 兼容已由用户提交 `4f54f02` 标记完成；不进入 CI 的策略不变。
- **R-001** Tauri + workspace 摩擦：已规避（CP-1 通过）。
- **R-002** caching_sha2 握手：MySQL 5.7 兼容已验证完成。
- **R-keepalive** keepalive 在某些 server 不响应 / drop 后 task leak：60s + 3 次阈值留缓冲；`Drop` 已 abort 全部 keepalive task。
- **R-ssh-runtime-errors 已关闭**：首跳掉线、嵌套 channel 断开与 accept worker 异常均有运行路径、去重和正常关闭抑制测试。
- **R-passphrase-test** `connection_test` 不接收 passphrase，带口令私钥只能在正式打开连接时验证完整链路。
- **R-query-error-contract 已关闭**：前端仅接收稳定 key 与可选正整数行号。
- **R-updater-release 已关闭**：云端全平台 artifact、正式版 `latest.json` 及应用内发现 / 下载 / 安装 / 重启全链路均已验证。

相关：[[00-project]] · [[12-tauri-shell]] · [[20-frontend]]
