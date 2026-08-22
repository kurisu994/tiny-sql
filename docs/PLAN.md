---
title: tiny-sql 待办开发计划
version: 0.4.0-draft-1
status: draft
last_updated: 2026-08-22
---

# tiny-sql 待办开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> 本文件只保留尚未完成的工作。已发布版本的实现细节与检查点历史见 [progress.md](../memory-bank/progress.md)；用户可见变化见 [CHANGELOG.md](../CHANGELOG.md)。

当前稳定版为 `v0.3.0`（2026-08-22 发布）：在 v0.2 多 driver 基础上新增可靠事务（独占 session）、表数据服务端筛选排序分页、index/constraint 元数据树与对象搜索、多语句执行与 SQL 格式化、SQL 文件工作流。V3 全部检查点已关闭，v0.3 开发计划已随发布移出本文件，历史见 [progress.md](../memory-bank/progress.md)。

---

# v0.4 开发计划

> 本节于 2026-08-22 生效（V4-CP0 已收口）。

**周期与预算**：8 周，约 96-100h，按作者业余时间 12-13h/周。

**定位**：v0.4 的主题是「安全数据维护与对象管理」。在 v0.3 已稳定的独占 session（FR-244）与服务端浏览（FR-242）之上做安全表格编辑（FR-250，P0），再补对象管理的查看侧与新建表（FR-251，P1）和 CSV / SQL dump 导入导出工作流（FR-252，P1）。完整范围以 [ROADMAP v0.4](./ROADMAP.md#v04--安全数据维护与对象管理) 与 [REQUIREMENTS §3.4](./REQUIREMENTS.md#34-v04-范围安全数据维护与对象管理) 为准。

| ID | 功能 | 优先级 | 版本内地位 |
|---|---|---|---|
| FR-250 | 仅带主键单表的安全表格编辑 | P0 | 不降级 |
| FR-251 | 结构查看 + DDL 预览 + 新建表表单 | P1 | 可降级新建表表单 |
| FR-252 | CSV 导入与 SQL dump 导入 / 导出 | P1 | 可降级 dump 导入 |

## V4.1 Phase 0：启动准入（不计入 8 周预算）

- [x] v0.3.0 正式版已发布（2026-08-22）：Release run `32546492367` 四平台全部成功，Release 非草稿非预发布，四平台资产与 `latest.json`（version 0.3.0）已核对。
- [x] RC/正式反馈产生的 v0.3.x 补丁：发布前无阻塞 P0/P1；后续真实用户反馈按常规流程走 v0.3.x 补丁，不混入 v0.4 承诺。
- [x] `REQUIREMENTS.md` 已补 v0.4 范围章节（2026-08-22，§3.4）。

**V4-CP0 已于 2026-08-22 全部收口，v0.4 Week 1 开工。**

RC/发布等待期间可以提前做 v0.4 契约设计（文档级工作）；真实用户反馈的 P0/P1 修复始终优先于 v0.4 任何任务。

## V4.2 时间线与依赖顺序

```text
Phase 0  前置  v0.3.0 正式发布 + v0.4 需求收口（不计入 8 周）
Week 1  13h  编辑内核后端：主键检测、DML 生成与批量事务执行（FR-250 后端）
Week 2  13h  编辑模式 UI 与 dirty state 管理（FR-250 前端）
Week 3  12h  提交/放弃闭环与断链/取消/并发路径（FR-250 收口）
Week 4  12h  结构查看与 DDL 预览（FR-251 前半）
Week 5  12h  新建表结构化表单 + SQL 预览确认执行（FR-251 后半）
Week 6  13h  CSV 导入：列映射、批量插入、错误策略、进度取消（FR-252 前半）
Week 7  12h  SQL dump 导出/导入：流式执行、进度、失败定位（FR-252 后半）
Week 8  12h  双 driver dogfooding + 文档 + RC / 正式发布

合计约 99h；P0（FR-250）目标 Week 1-3 完成，P1 穿插，第 8 周稳定性与发布。
```

关键依赖链：

1. FR-244 独占 session（v0.3 已交付）→ 编辑提交事务；FR-242 浏览 tab（v0.3 已交付）→ 编辑模式入口。v0.4 不重写这两条路径。
2. 主键/唯一性元数据 → index/constraint 契约（v0.3 FR-241 已交付）直接复用，不新增 metadata 面。
3. 「dialog 选路径 + 后端读写」模式（v0.2 导出、v0.3 SQL 文件已建）→ CSV 导入与 dump 文件读写；不引入 `tauri-plugin-fs`。
4. 多语句分号状态机（v0.3 FR-243 已建）→ dump 导入拆分；大文件需新增流式读取，禁止整文件载入。

## V4.3 分周任务与验收

### v0.4 Week 1 — 编辑内核后端（13h）✅ 已完成（2026-08-22）

- **V4-T1.1 [3h]** ✅ Driver 契约最小扩展：`apply_table_edits(scope, table, pk_columns, edits, cancel)`——后端权威校验主键（不一致/无主键返回 `NoPrimaryKey`），`BEGIN → 逐条参数化 DML → COMMIT`，任一失败整体 `ROLLBACK`；新增 `EditApplyFailed { index }`（定位失败语句）与 `EditConflict { index }`（影响行数 ≠ 1）稳定错误 key；`TableEdit`（Insert / Update / Delete）+ `EditCell`（None = NULL）类型。复用 FR-241 constraint metadata，不新增主键查询契约面。
- **V4-T1.2 [4h]** ✅ MySQL 实现：短事务独占连接（`START TRANSACTION` text protocol），逐条参数化 INSERT/UPDATE/DELETE，`KILL QUERY` 取消 + 失败路径 `ROLLBACK` 失败则 `close_on_drop` 防脏连接回池；COMMIT 失败同样销毁连接杜绝「以为已提交」中间态。
- **V4-T1.3 [4h]** ✅ PostgreSQL 实现：同语义（schema 限定、双引号标识符、`$N` 占位）；取消后连接协议不可信，直接 `close_on_drop` 由服务端兜底回滚（session 教训）。
- **V4-T1.4 [2h]** ✅ 测试：单测 6 个（DML 生成 / 标识符转义 / NULL 与空串区分 / 占位符编号 / noop 跳过 / 错误 key 与 index）+ integration 7 个（MySQL 5：混合批提交、中途失败回滚、冲突回滚、无主键/主键不符拒绝、复合主键；PG 2：混合批 + 回滚/拒绝/复合主键）。真实双 driver integration 27/27 全绿（MySQL 16、PG 11），db-driver 单测 47/47，clippy 干净。

验收：MySQL 现有测试全绿（零回归）；双 driver 编辑原语可用；**V4-CP1 已通过（2026-08-22）**，进入 Week 2。

### v0.4 Week 2 — 编辑模式 UI 与 dirty state（13h）✅ 已完成（2026-08-22）

- **V4-T2.1 [5h]** ✅ 浏览 tab 编辑模式：工具栏「编辑」按钮（仅显式主键表可用，无主键表显示提示）；`EditableTable` 组件复用 Virtuoso + sticky 布局，双击单元格本地编辑（Enter 保存 / Shift+Enter 置 NULL / Esc 取消）；已有行编辑记 update dirty（amber 高亮）、删除标记（红色划线 + 撤销）、新增草稿行（emerald 高亮）追加表尾；主键列禁止修改（新增行除外）；dirty 计数实时显示。
- **V4-T2.2 [4h]** ✅ 类型感知与 NULL 语义：单元格编辑文本输入 + Shift+Enter 显式置 NULL，NULL / 空串严格区分（沿用 FR-107 语义）；自增 / 生成列只读由后端主键列限制 + 主键列禁止编辑兜底；dirty 状态在虚拟滚动与分页下不丢（Virtuoso 行级渲染 + store 状态分离）。
- **V4-T2.3 [4h]** ✅ 虚拟滚动 / 筛选 / 排序 / 翻页护栏：编辑 dirty 时执行这些操作需确认「丢弃未提交变更」，确认后丢弃 dirty 再刷新，杜绝 dirty 悬空对不上数据；关闭 tab 有未提交编辑同样确认（`isTabDirty` 扩展至 browse 编辑 dirty）。

验收：编辑全流程不发出 SQL（单测 mock 验证）；dirty 状态正确合并 / 覆盖 / 撤销；**V4-CP2 前半通过**。

### v0.4 Week 3 — 提交/放弃闭环与异常路径（12h）✅ 已完成（2026-08-22）

- **V4-T3.1 [4h]** ✅ 提交：确认对话框展示变更摘要（增/改/删条数 + 目标表 + 事务语义说明）→ `db_apply_table_edits` 后端短事务执行 → 成功清空 dirty 并刷新当前页数据；失败保留 dirty 并展示定位错误（`editIndex` →「第 N 条变更」）。
- **V4-T3.2 [3h]** ✅ 放弃 / 关闭 / 断链：放弃确认后整体丢弃；关闭 tab 有未提交编辑时确认丢失；断链后 dirty 保留在 UI（后端已断，提交时返回错误明示），不向新 session 隐式重放。
- **V4-T3.3 [3h]** ✅ 并发与护栏：编辑 tab 与查询 / 事务 tab 并行互不串 session；编辑提交走独立 cancel token 注册 / 注销；后端列白名单复用 `db_browse_table` 同策略。
- **V4-T3.4 [2h]** ✅ 测试：session-store 编辑 actions 单测 7 个（主键探测 editable / 单元格编辑合并 / 新增草稿 / 删除撤销 / isTabDirty / 提交成功刷新 / 提交失败保留 dirty），前端 109/109 全绿。

验收：增/删/改提交与回滚双 driver 可从前端证明（store 单测 + Week 1 integration）；关闭 / 断链路径终态确定；**V4-CP2 编辑闭环已通过（2026-08-22）**。

### v0.4 Week 4 — 结构查看与 DDL 预览（12h）✅ 已完成（2026-08-22）

- **V4-T4.1 [4h]** ✅ 表结构详情视图：浏览 tab 新增「数据 / 结构」子视图切换；结构页整合展示列定义（类型 / 可空 / 默认值 / 注释 / PK 标记）、索引（名称 / 列 / 类型 / 唯一性）、约束（类型 / 列 / 引用定义），复用 FR-241 metadata 命令不新增契约面。
- **V4-T4.2 [4h]** ✅ MySQL DDL 预览：复用 `db_query` 执行 `SHOW CREATE TABLE`（元数据语句免写确认，全限定 `db`.`table` 不依赖当前库），展示服务端原文。
- **V4-T4.3 [3h]** ✅ PostgreSQL DDL 预览：`src/lib/ddl.ts` 由已加载列 / 约束 / 索引拼装 CREATE TABLE + CREATE INDEX（主键 / 唯一 / CHECK / 外键按 pg_constraint 定义文本重建），明确标注「重建预览，非服务端原文」；单测 4 个（拼装 / 约束 / 索引 / 转义 / 无主键）。
- **V4-T4.4 [1h]** ✅ cache 失效链：结构数据直读 `dbApi`（不经前端 LRU），DDL 执行 / 手动刷新 / 重连后自然反映最新元数据。

验收：双方言结构查看与 DDL 预览可用；**V4-CP3 前半通过**。

### v0.4 Week 5 — 新建表表单（12h）✅ 已完成（2026-08-22）

- **V4-T5.1 [5h]** ✅ 新建表结构化表单：schema 树顶「新建表」入口（需已选中 database/schema）；对话框列编辑表格（列名 / 类型 / 可空 / 默认值 / 主键 / MySQL 自增），类型下拉预选双方言常用类型 + 白名单格式校验（拒绝注入字符），勾选主键 / 自增强制 NOT NULL，重复列名与空表名校验；不含索引 / 约束设计器（顺延）。
- **V4-T5.2 [4h]** ✅ SQL 预览生成：`buildCreateTableSql` 双方言生成（MySQL 全限定反引号 + AUTO_INCREMENT + 表注释；PG schema 限定双引号），表单实时预览 + 执行前确认对话框展示完整 SQL（V4-R06）；单测 5 个（MySQL / PG / 复合主键 / 校验拒绝 / 类型白名单）。
- **V4-T5.3 [3h]** ✅ 执行与失效：DDL 走 `dbApi.query` 写确认护栏；成功后 `refreshMetadata` 失效 metadata cache 并刷新 schema 树，新表即时可见。

验收：双方言新建表全链路（表单 → SQL 预览 → 确认 → 执行 → 树刷新）；**V4-CP3 对象管理已通过（2026-08-22）**。

### v0.4 Week 6 — CSV 导入（13h）✅ 已完成（2026-08-22）

- **V4-T6.1 [4h]** ✅ CSV 解析与预览：手写 RFC 4180 状态机（引号转义 / 内嵌换行 / CRLF / UTF-8 BOM），不引入新 crate；空值语义与导出闭环（无引号 NULL → SQL NULL，`""` → 空串）；`csv_import_preview` 返回表头 + 前 100 行 + 数据行总数；解析器单测 6 个。
- **V4-T6.2 [4h]** ✅ 列映射 UI：导入对话框展示 CSV 列 / 示例值 / 表列下拉（同名列大小写不敏感自动匹配，可跳过）；表头开关切换实时重载预览。
- **V4-T6.3 [3h]** ✅ 批量执行：db-driver 新增 `bulk_insert_rows` 契约（不要求主键，与 apply_table_edits 区分）+ 双实现；值不做类型推断统一文本隐式转换（V4-R04）；分批 ≤ 1000 行，中止模式批内单事务失败整体回滚并定位批内行号，跳过模式逐行 autocommit 收集失败行号（数据行号，1 起不含表头）。
- **V4-T6.4 [2h]** ✅ 进度与取消：导入经 `state.queries` 注册 cancel token，复用现有取消链路；中止模式取消当前批回滚、跳过模式停止于当前行（批间不回滚为明示语义）；integration 3 个（MySQL 无主键表导入 + 中止/跳过模式；PG 双模式 + 空值语义）。

验收：双 driver CSV 导入正确；**V4-CP4 前半通过**。

### v0.4 Week 7 — SQL dump 导出/导入（12h）

- **V4-T7.1 [4h]** 表/库级 dump 导出：后端流式写文件（结构 DDL + 数据 INSERT 批），不经过前端序列化；进度与取消。
- **V4-T7.2 [5h]** dump 导入：大 SQL 文件流式读取 + 分号状态机逐条执行（复用 FR-243 拆分），进度、失败语句定位（语句序号 + 字节偏移），失败后可选中止/继续。
- **V4-T7.3 [3h]** 边界回归：含注释/字符串/dollar-quoted body 的 dump 不误判；超大文件不整读内存；写确认一次性覆盖整个文件而非逐条确认。

验收：双 driver dump 导出→导入闭环；**V4-CP4** 导入导出通过。

### v0.4 Week 8 — 双 driver dogfooding 与发布（12h）

- **V4-T8.1 [4h]** 双 driver × 直连/1 跳/3 跳全功能真实回归：编辑提交/回滚、无主键拒绝、结构查看/DDL 预览、新建表、CSV 导入、dump 闭环。
- **V4-T8.2 [3h]** 作者 + 至少 2 位试用者使用 v0.4 RC ≥ 1 周：0 数据丢失、0 凭据泄露、0 不可恢复 crash。
- **V4-T8.3 [3h]** 文档：REQUIREMENTS §3.4 收口、ARCHITECTURE 编辑/导入导出章节、RELEASE_CHECKLIST v0.4 节、CHANGELOG 持续维护。
- **V4-T8.4 [2h]** 门禁：`just check` 全绿、双 driver integration 全绿、本机安装包 + updater 签名产物构建成功；全平台 RC 下载验收随 RC 发布执行。

验收：**V4-CP5** 发布门槛全部通过；未完成 P1 降级项明确移入 v0.4.1 或 v0.5，不在 Release notes 虚假承诺。

## V4.4 v0.4 检查点与降级规则

| 检查点 | 时机 | 通过标准 | 不通过的应对 |
|---|---|---|---|
| **V4-CP0** 启动准入 | 开工前 | §V4.1 全部完成 | 继续收 v0.3.x，不创建 v0.4 功能分支 |
| **V4-CP1** 编辑内核 | Week 1 末 | 双 driver 批量 DML 事务可用 + 零回归 | 收窄契约；不得继续铺编辑 UI |
| **V4-CP2** 编辑闭环 | Week 3 末 | 提交/放弃/断链/关闭终态确定 | FR-250 整体降级，v0.4 顺延；其余两项继续 |
| **V4-CP3** 对象管理 | Week 5 末 | 结构查看 + DDL 预览双方言可用 | 新建表表单降级，保查看与预览 |
| **V4-CP4** 导入导出 | Week 7 末 | CSV 导入 + dump 导出闭环 | dump 导入降级，保导出与 CSV |
| **V4-CP5** 发布 | Week 8 末 | 双 driver dogfood + P0/P1 清零 + RC 安装通过 | 延后正式版，不降低数据安全标准 |

范围超时时按以下顺序降级：新建表表单（保结构查看 + DDL 预览）→ dump 导入（保 dump 导出 + CSV 导入）→ CSV 列映射（保同名列直接导入）→ FR-251 / FR-252 整体顺延。FR-250 不降级；它未完成则版本继续延期。

## V4.5 测试矩阵

沿用 v0.3 全部矩阵，新增：

- **编辑矩阵**：双 driver × 增/删/改混合批量 × 提交/放弃 × 取消/断链/关闭；无主键拒绝、复合主键、自增/生成列只读、NULL 与空串区分、0 影响行冲突。
- **导入矩阵**：UTF-8 BOM/引号/内嵌换行 CSV；大文件分批边界；类型转换失败的中止/跳过报告；取消后已提交批次语义。
- **dump 矩阵**：大文件流式不整读；注释/字符串/dollar-quoted 内分号；失败定位到语句序号；导出→导入数据一致。

## V4.6 主要风险

| 风险 ID | 描述 | 影响 | 缓解 |
|---|---|---|---|
| V4-R01 | 表格编辑 UI 复杂度高（虚拟滚动 + 单元格编辑 + dirty） | 高 | 基于现有浏览 tab 增量改造，不新造网格组件；Week 2 先保 dirty 正确再打磨交互 |
| V4-R02 | 无主键/复合主键/生成列边界情况多 | 高 | 仅显式主键表开放编辑；生成列与自增列只读；其余引导回 SQL |
| V4-R03 | 编辑期间他端修改同一行导致误更新 | 中 | UPDATE/DELETE 影响行数校验，0 行即冲突提示；v0.4 不做原值全比对乐观锁 |
| V4-R04 | CSV 类型推断错误造成脏数据 | 高 | 不做推断，统一文本由数据库隐式转换；失败行报告 + 可选跳过 |
| V4-R05 | 大 dump 文件内存溢出 | 高 | 流式读取逐批执行，禁止整文件载入；门禁含大文件用例 |
| V4-R06 | DDL 二次确认流于形式 | 中 | 确认框必须展示完整 SQL 预览，不允许无预览执行 |
| V4-R07 | v0.5+ 备份/ER 欲望导致范围膨胀 | 中 | 明确不做；Week 7 后不加新 FR |

明确不进入 v0.4：修改表 / 索引约束设计器（FR-251 顺延项）、备份与恢复（FR-260）、数据/结构同步（FR-261）、用户权限（FR-262）、ER/BI/AI（FR-263~265）；CSV/Excel 结果导出仍属 FR-107，JOIN/聚合结果写回继续禁止（见 [ROADMAP](./ROADMAP.md)「不做的事」）。
