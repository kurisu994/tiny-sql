# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-08-29（连接列表拖拽排序）

## 当前状态

**本轮：连接列表拖拽排序（2026-08-29，v0.8.0 之后的 Unreleased）**——用户要给左侧连接列表加拖动排序。

关键取舍：原 FR-003 是「按 `last_used_at` 倒序」，双击连接后它会自动跳顶，和手动排序直接冲突。已向用户确认，选定**手动顺序取代自动排序**：`StoredConnection` 新增 `sort_order: Option<i64>`，`connection_list` 先按序号升序，`None`（旧记录 / 新建 / 分享导入）排在其后并保留最近使用倒序作兜底，因此升级后首屏顺序与升级前一致，用户第一次拖动就把全量顺序写实。新增 `connection_reorder(ids)` 命令 + `ConnectionStore::reorder`（未出现的 id 保持原值，未知 id 忽略）。FR-003 / ARCHITECTURE 命令表与连接模型 / productContext 已同步改写。

前端不引 dnd 依赖：新增 `src/hooks/use-drag-sort.ts`，pointer 事件 + `data-drag-id` 读 rect 算插入位，指示线由调用方画。**故意不用 HTML5 draggable**——Tauri 窗口默认接管文件拖放，WebView 里 dragstart/drop 不可靠。位移超 4px 才算拖拽（不抢单击选中 / 双击连接），只接左键（右键留给上下文菜单），拖完吞掉补发的那次 click，指针贴容器上下边缘 28px 时 rAF 自动滚动。store 的 `reorder` 做乐观更新：本地先落位避免松手回弹，后端失败回滚并报错。

顺带按用户要求把工作台顶部两栏并成一栏：视图切换（浏览 / 关系图 / 对比 / 权限）后面接一条竖分隔线，再接原本挂在对象树 aside 里 sticky 的五个操作按钮（新建表 / 复制表 / 导入 SQL / 官方备份 / 刷新），并只在 `workspace === "browse"` 时渲染——这些操作都作用于左侧树，别的视图有自己的工具栏。aside 顶部的 sticky 条整块删掉，`dumpMsg` 提示保留在原位。

再按用户要求给「测试连接」加延迟展示：`connection_test` 从 `Result<(), String>` 改成返回 `ConnectionTestReport`（`tunnelMs?` / `connectMs` / `pingMs` / `totalMs`，f64 毫秒）。分段是准的——sqlx 的 `connect_with` 是 eager 建池，握手确实发生在 connect 阶段，随后的 `Driver::ping` 走热连接，测到的才是纯往返延迟。UI 主行「✓ 连接成功 · 延迟 13 ms」，次行小字列隧道 / 建立连接 / 总计；`formatMs` 对 <10ms 保留一位小数，否则内网库统统显示 0 ms。

门禁：cargo fmt --check / clippy -D warnings / cargo test --workspace 全绿，vitest 218（新增 hook 6 例 + store 3 例），tsc 与 `pnpm build` 通过。**待用户 GUI 实测**：拖拽手感、重启后顺序是否保持。尚未提交。

### SQLite 待办 / 阻塞

- **待用户 GUI 实测**：新建 SQLite 连接 → 选文件 → 库树 / 结构 / 浏览编辑 / SQL 编辑器 / CSV 导入 / dump 导出导入 全链路。自动化门禁（`just check` + 23 条 SQLite integration）已全绿，但没跑过真实 GUI。
- **有意不做**：SQLite 无账号体系，`db_list_accounts` 返回 `error.privilege.unsupported`；`ALTER TABLE` 改类型 / 空性 / 默认值在 `validateAlterTable` 阶段拒绝（SQLite 要重建表）；结构页不列 CHECK 约束（只有 `sqlite_master.sql` 原文有，不做 DDL 解析）；复制表不带索引（索引名库级唯一会撞名）。
- **备份 / 恢复**依赖用户机器上有 `sqlite3` 命令行（导出 `sqlite3 <file> ".dump"`，恢复 stdin 灌入），与 mysqldump / pg_dump 同一套外部工具链路。

## 活跃文件

- `docs/PLAN.md`：只留 v0.4–v0.7 用户验收。
- `docs/{ARCHITECTURE,REQUIREMENTS,ROADMAP}.md`、`README.md` / `README_EN.md`、`CHANGELOG.md`、`memory-bank/*`：以代码为准对齐 56 个 command、三 driver 与 v0.8/SQLite 已落地能力。
- `crates/db-driver/src/lib.rs`：`MySqlDriver::list_constraints` 改为两条 information_schema 等值查询，避免结构页卡死。
- `crates/db-driver/tests/integration.rs`：结构页 MySQL 元数据 3s 超时回归。
- `src-tauri/src/security.rs`：主密码状态机、v1↔v2 迁移回滚、secrets map（FR-102）。
- `src-tauri/src/config/{encryption,store,history,ssh_known_hosts}.rs`：v2 envelope/Argon2id KDF、连接配置与 SQL 历史加密存储、SSH 信任库。
- `src-tauri/src/commands/{connection,query,security,history,export}.rs`：连接生命周期、查询与取消、主密码命令、历史命令、流式导出。
- `src-tauri/src/state.rs`：`ActiveDriver::{MySql, PostgreSql, Sqlite}` 注册表 + security/history 注入。
- `crates/ssh-multihop/src/lib.rs`：N 跳隧道、session actor、keepalive、RTT/断链监控、host key verifier。
- `crates/db-driver/src/{lib,postgres}.rs`：Driver 契约、MySQL（含 TLS 错误分类）、PostgreSQL、SQL guard。
- `src/stores/{session-store,security-store}.ts`：多 tab 查询工作台、主密码前端状态。
- `src/components/{schema-browser,security-dialogs,history-panel,connection-dialogs,connection-form,topology-graph}.tsx`：tab 条与结果区、解锁/安全设置、历史面板、passphrase 记住选项、证书浏览、拓扑。
- `src/lib/column-widths.ts`、`src/hooks/use-column-widths.ts`：列宽拖拽与 localStorage 持久化。
- `.github/workflows/{ci,release}.yml`、`justfile`：质量检查、全平台发布、版本脚本。
- `README.md` / `README_EN.md` / `CONTRIBUTING.md`、`docs/*`、`memory-bank/*`：本轮对齐范围。

## 下一步（按优先级）

1. GUI 验收 v0.8（只读 / 环境色 / 复制表 / 检查器 / RENAME / EXPLAIN 提示）+ SQLite 全链路实测。
2. 正式切 `v0.8.0` 仍由用户发。

## 阻塞 / 风险

- **高级设置仅部分生效**：连接超时与 SSH keepalive 已接线；读取/写入超时、压缩、自动连接仍只持久化，不能描述成已生效。
- **正式版未经历完整 RC 试用周期**：T8.2 提前关闭，若 v0.2.0 后出现 P0/P1 需随时准备 v0.2.1 补丁并优先于 v0.3 开发。
- **PG session 客户端截断/取消后事务大概率保不住**：协议残留低频路径，session 验证失败即 session_broken，前端引导重建；已如实写入 ARCHITECTURE 与 PLAN 风险。

相关：[[progress]] · [[systemPatterns]]

## 归档
- [2026-08](./archive/activeContext-2026-08.md) — v0.1~v0.8 历史轮次 / 已实现能力 / 近期决策 / 代码承诺边界
