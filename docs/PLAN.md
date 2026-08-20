---
title: tiny-sql 待办开发计划
version: 0.2.0-draft-3
status: draft
last_updated: 2026-08-19
---

# tiny-sql 待办开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> 本文件只保留尚未完成的工作。v0.2 各 Week 已完成任务的实现细节与检查点历史见 [progress.md](../memory-bank/progress.md)；用户可见变化见 [CHANGELOG.md](../CHANGELOG.md) 的 `[Unreleased]` 段。

当前稳定版为 `v0.1.0`（2026-08-18 发布），`v0.2.0-rc1` 已于 2026-08-20 发布进入试用期。**v0.2 的全部开发任务已完成**：Driver 契约、PostgreSQL 后端与应用接线、主密码加密与 TLS 错误诊断、schema intelligence、查询工作台（历史/多 tab/导出/列宽）、SSH RTT/重连/keepalive、文档与英文 README。自动化门禁全绿：`just check`、双 driver integration 9/9、本机 Tauri 调试包构建成功。

**v0.2 真实环境验收已于 2026-08-19 全部通过**（T3.4 双 driver Tauri 验收、T4.3 真实 TLS、T7.1/T7.2 真实链路、T8.1 双 driver dogfooding），V2-CP2 / V2-CP3 / V2-CP4 均已关闭。**PostgreSQL 15.latest / 18.latest 双端点 integration 回归与 RC 全平台下载安装验收已于 2026-08-20 由用户完成；V2-T8.2 同日由用户确认提前关闭**（RC 发布当日关闭，未执行满一周试用等待；实质验收依据为 08-19 T8.1 双 driver dogfooding 与 08-20 RC 安装验收，后续真实用户反馈按 P0/P1/P2 常规流程处理）。v0.2 剩余事项仅为正式发布（见下节）；**v0.3 开发计划已立项（见本文「v0.3 开发计划」节），v0.2.0 正式版发布后即可开工**。

## v0.2 剩余待办

### 发布

- [ ] **正式发布 v0.2.0**：`just release v0.2.0`，切出 CHANGELOG `0.2.0` 段并验收四平台 `latest.json`，通过 **V2-CP5**。所有前置（双 driver dogfooding、PG 15/18 双端点回归、RC 安装验收、T8.2 关闭）均已完成。

### 发布检查点

| 检查点 | 通过标准 | 不通过的应对 |
|---|---|---|
| **V2-CP2** 双 driver 闭环 | ✅ 已通过（2026-08-19 T3.4 真实验收） | — |
| **V2-CP3** 安全与 TLS | ✅ 已通过（2026-08-19 T4.3 真实 TLS 正反例） | — |
| **V2-CP4** 查询工作台 | ✅ 已通过（2026-08-19 T8.1 dogfooding） | — |
| **V2-CP5** 发布 | 双 driver dogfooding（✅ 2026-08-19）+ RC 安装通过（✅ 2026-08-20）+ P0/P1 清零（✅ 2026-08-20 用户关闭 T8.2） | 延后正式版，不降低凭据与数据安全标准 |

明确不进入 v0.2：安全表格编辑、对象设计、CSV 导入、SQL dump、备份同步、用户权限和 ER/BI/AI；这些分别留在 v0.3-v0.5+（见 [ROADMAP](./ROADMAP.md)）。

---

# v0.3 开发计划

**周期与预算**：7 周，约 82-86h（当前拆分约 84h），按作者业余时间 12-13h/周。

**定位**：v0.3 的主题是「查询与浏览效率 + 可靠事务」。不做 v0.2 那样的地基级重构，而是在已稳定的多 driver 架构上做两处契约扩展（独占 session、数据浏览查询）和三处工作台能力（多结果、SQL 文件、对象搜索）。完整范围以 [ROADMAP v0.3](./ROADMAP.md#v03--查询与浏览效率) 为准。

| ID | 功能 | 优先级 | 版本内地位 |
|---|---|---|---|
| FR-242 | 表数据服务端筛选、排序和分页 | P0 | 不降级 |
| FR-244 | 连接绑定的独占 session 与可靠事务 | P0 | 不降级；v0.4 安全编辑前置 |
| FR-240 | 保存 / 打开 SQL 文件与最近文件 | P1 | 可降级最近文件部分 |
| FR-241 | index / constraint 元数据树与对象搜索 | P1 | 可降级对象搜索部分 |
| FR-243 | 多结果 tab 与 SQL 格式化 | P1 | 可降级格式化部分 |

## V3.1 Phase 0：启动准入（不计入 7 周预算）

- [ ] v0.2.0 正式版已发布：T8.2 双 driver RC 试用完成、P0/P1 清零、CHANGELOG 切出 `0.2.0` 段、全平台 `latest.json` 验收通过。
- [ ] RC 反馈产生的 v0.2.1 补丁（如有）已发布并稳定；剩余 P2 明确移入 v0.2.x 或 v0.4，不混入 v0.3 承诺。
- [ ] `REQUIREMENTS.md` 已补 v0.3 范围章节（Week 1 前收口，作为 V3-CP0 的一部分）。

RC 试用等待期间可以提前做 v0.3 规划与契约设计（文档级工作，本节即由此产生），功能代码在正式版发布后开工；RC 反馈的 P0/P1 修复始终优先于 v0.3 任何任务。

## V3.2 时间线与依赖顺序

```text
Phase 0  前置  v0.2.0 正式发布 + v0.3 需求收口（不计入 7 周）
Week 1  12h  Driver 契约扩展：独占 session 与事务原语（FR-244 后端）
Week 2  13h  事务工作台 UI 与断链/取消闭环（FR-244 前端）
Week 3  13h  表数据服务端筛选、排序与分页（FR-242）
Week 4  12h  index/constraint 元数据树与对象搜索（FR-241）
Week 5  12h  多结果 tab 与 SQL 格式化（FR-243）
Week 6  10h  SQL 文件保存/打开与最近文件（FR-240）
Week 7  12h  双 driver dogfooding + 文档 + RC / 正式发布

合计约 84h；P0（FR-242/FR-244）目标 Week 1-3 完成，P1 穿插，第 7 周稳定性与发布。
```

关键依赖链：

1. 独占 session 契约 → 事务 UI → 断链/取消语义；FR-244 改动最深，排最前，避免后期返工 query 路径。
2. 现有预览查询路径 → 服务端筛选/排序/分页；与 FR-244 独立，但共享 query_id 迟到守卫与取消契约。
3. SQL 分号状态机（现有 guard）→ 多语句拆分执行 → 多结果 tab；多语句里可能含 `BEGIN`，依赖 Week 1-2 的事务语义先定清楚。
4. metadata 契约与 LRU cache（v0.2 已建）→ index/constraint 扩展 → 对象搜索。
5. 导出「dialog 选路径 + 后端读写」模式（v0.2 已建）→ SQL 文件保存/打开；不引入 `tauri-plugin-fs`。

## V3.3 分周任务与验收

### v0.3 Week 1 — Driver 契约扩展：独占 session 与事务原语（12h）

- **V3-T1.1 [4h]** 扩展 `Driver` 契约，新增最小独占 session 面（获取 session、session 内执行/取消、释放 session）；普通查询继续走 pool 路径，不重写已有调用，不提前抽象 v0.4 编辑能力。
- **V3-T1.2 [4h]** MySQL 独占 session 实现：`BEGIN` / `COMMIT` / `ROLLBACK` 固定同一 connection；session 独立于 pool 的限额与空闲超时，超时强制回收并回滚。
- **V3-T1.3 [2h]** PostgreSQL 独占 session 实现：事务语义与 `pg_cancel_backend` 作用于事务内连接的回归。
- **V3-T1.4 [2h]** 单测证明同一 session 语句落同一连接（`CONNECTION_ID()` / `pg_backend_pid()`）；断链、关闭、超时路径自动 `ROLLBACK`。

验收：MySQL 现有测试全绿（零回归）；双 driver 事务原语可用；**V3-CP1** 通过后才进入 Week 2。

### v0.3 Week 2 — 事务工作台 UI 与闭环（13h）

- **V3-T2.1 [4h]** session-store 增加事务状态：tab 显式进入事务模式，事务内 SQL 走绑定 session；事务状态栏与 `COMMIT` / `ROLLBACK` 按钮，未提交有明确视觉标识。
- **V3-T2.2 [3h]** 事务与现有护栏交互：写确认、取消、关闭 tab / 连接时未提交事务的提示与回滚路径。
- **V3-T2.3 [3h]** 断链语义：事务中 SSH 断开 → session 失效 → UI 明示事务已回滚；禁止「重连续事务」的隐式承诺。
- **V3-T2.4 [3h]** 并发回归：事务 tab 与普通 tab 并行、两个事务 tab 互不串连接；事务 tab 取消不波及同连接其他 tab。

验收：事务内多语句同连接可从前端证明；取消/断链/关闭每条路径都有确定终态；**V3-CP2** 事务闭环通过。

### v0.3 Week 3 — 表数据服务端筛选、排序与分页（13h）

- **V3-T3.1 [4h]** Driver 契约扩展数据浏览查询：WHERE（列白名单 + 操作符枚举 + 值全参数化）、ORDER BY（列白名单）、LIMIT/OFFSET 分页与总行数 COUNT；MySQL/PostgreSQL 各自标识符引用规则。
- **V3-T3.2 [4h]** 预览 tab 改造：筛选栏、列头排序、分页器；筛选/排序/翻页作为新查询接入 query_id 迟到守卫与取消。
- **V3-T3.3 [3h]** 大表回归：百万行级表分页不整拉；COUNT 与数据查询的取消独立；明确 10 万行导出上限与分页并存的关系。
- **V3-T3.4 [2h]** 注入与方言安全测试：操作符不可拼串、列名只接受已加载 metadata 白名单、值参数化覆盖 NULL/字符串/数值。

验收：双 driver × 0/1/3 跳下筛选分页正常；全程不出现整表拉取；**V3-CP3** 前半通过。

### v0.3 Week 4 — index/constraint 元数据树与对象搜索（12h）

- **V3-T4.1 [4h]** metadata 契约增加 index/constraint：MySQL `information_schema` 与 PostgreSQL `pg_index` / `pg_constraint` 双方言实现；接入 v0.2 的 LRU cache 失效链（刷新/DDL/重连）。
- **V3-T4.2 [3h]** schema 树展示索引与约束（类型、列、唯一性、引用），按需展开不阻塞列加载。
- **V3-T4.3 [3h]** 对象搜索：按名称过滤 database/schema/table/column/index，选中定位展开树节点；大 schema 下防抖与过期响应丢弃。
- **V3-T4.4 [2h]** 大 schema（2000 表 / 16000 列基线）性能回归与 cache 行为验证。

验收：双方言索引/约束展示正确；搜索定位流畅不阻塞 UI；**V3-CP3** 浏览效率通过。

### v0.3 Week 5 — 多结果 tab 与 SQL 格式化（12h）

- **V3-T5.1 [2h]** 多语句执行策略落地：保持「单语句直接执行」护栏不变；「执行全部」由后端按方言分号状态机拆分后逐条执行，每条独立走 guard 分类与写确认；PostgreSQL dollar-quoted body 与字符串/注释内分号不误判，拆分无法确定边界时拒绝执行并返回稳定 key，绝不尽力执行。
- **V3-T5.2 [5h]** 多结果 tab：一次执行保留多个结果集（逐语句一个结果，含行列、截断与成功/失败状态）；失败语句明确标注，后续语句继续/中止策略固定且可预期。
- **V3-T5.3 [3h]** SQL 格式化：前端引入成熟格式化库（选型 + license/bundle 审计），覆盖 MySQL/PostgreSQL 方言；快捷键与菜单入口。
- **V3-T5.4 [2h]** 并发与取消回归：多结果执行中取消、部分成功状态展示、与事务 tab 的组合。

验收：多语句脚本结果完整不串线；格式化不破坏方言与 dollar-quoted 语法；**V3-CP4** 工作台增强通过。

### v0.3 Week 6 — SQL 文件工作流（10h）

- **V3-T6.1 [4h]** 保存/打开 SQL 文件：复用 dialog 选路径 + 后端读写（同 v0.2 导出模式，不引 `tauri-plugin-fs`）；UTF-8；保存动作与 tab dirty 状态联动。
- **V3-T6.2 [3h]** 最近文件列表：只持久化路径与打开时间（不写入加密历史）；失效文件清理；点击以新 tab 打开。
- **V3-T6.3 [2h]** 未保存关闭确认；打开后文件被外部修改的提示（读取快照比对即可，不做实时监听）。
- **V3-T6.4 [1h]** 菜单与快捷键完善。

验收：保存/打开/最近文件全链路；文件路径不进敏感日志；**V3-CP5** 前置就绪。

### v0.3 Week 7 — 双 driver dogfooding 与发布（12h）

- **V3-T7.1 [4h]** MySQL/PostgreSQL × 直连/1 跳/3 跳全功能回归：事务、筛选分页、多结果、对象搜索、SQL 文件。
- **V3-T7.2 [3h]** 作者 + 至少 2 位试用者使用 v0.3 RC ≥ 1 周（沿用 V2-T8.2 标准：0 数据丢失、0 凭据泄露、0 不可恢复 crash）。
- **V3-T7.3 [3h]** 文档：`REQUIREMENTS.md` v0.3 范围收口、`ARCHITECTURE.md` 补 session/事务与多结果章节、`RELEASE_CHECKLIST.md` 补 v0.3 节、CHANGELOG 持续维护。
- **V3-T7.4 [2h]** `just check`、双 driver integration、本机安装包、全平台 RC 下载验收；P0/P1 清零后发布 v0.3.0。

验收：**V3-CP5** 发布门槛全部通过；未完成 P1 降级项明确移入 v0.3.1 或 v0.4，不在 Release notes 虚假承诺。

## V3.4 v0.3 检查点与降级规则

| 检查点 | 时机 | 通过标准 | 不通过的应对 |
|---|---|---|---|
| **V3-CP0** 启动准入 | 开工前 | §V3.1 全部完成 | 继续收 v0.2，不创建 v0.3 功能分支 |
| **V3-CP1** Session 抽象 | Week 1 末 | MySQL 零回归 + 双 driver 事务原语可用 | 收窄契约；不得继续铺事务 UI |
| **V3-CP2** 事务闭环 | Week 2 末 | 同连接可证、取消/断链/关闭终态确定 | FR-244 整体降级，v0.4 顺延；其余四项继续 |
| **V3-CP3** 浏览效率 | Week 4 末 | 筛选分页 + index/constraint 树双方言可用 | 对象搜索降级，保筛选分页与元数据树 |
| **V3-CP4** 工作台增强 | Week 5 末 | 多结果正确隔离、格式化可用 | SQL 格式化降级，保多结果 |
| **V3-CP5** 发布 | Week 7 末 | 双 driver dogfood + P0/P1 清零 + RC 安装通过 | 延后正式版，不降低事务与数据安全标准 |

范围超时时按以下顺序降级：SQL 格式化 → 最近文件（保保存/打开） → 对象搜索（保 index/constraint 树） → 多结果（保多语句拆分执行）。FR-242 / FR-244 不降级；它们未完成则版本继续延期。

## V3.5 测试矩阵

沿用 v0.2 全部矩阵（静态质量、双 driver integration、MySQL 5.7/8.x + PostgreSQL 15/18 兼容、隧道 0/1/3 跳 × 三类认证、安全矩阵、并发矩阵），新增：

- **事务矩阵**：双 driver × BEGIN/COMMIT/ROLLBACK × 取消/断链/关闭/空闲超时；同连接证明（`CONNECTION_ID()` / `pg_backend_pid()`）；多事务 tab 并发隔离。
- **分页筛选矩阵**：双方言大表分页边界（首页/末页/空页）、排序稳定性、筛选注入尝试、COUNT 取消。
- **多语句矩阵**：字符串/注释/dollar-quoted 内分号、写语句混排确认、部分失败、执行中取消。

## V3.6 主要风险

| 风险 ID | 描述 | 影响 | 缓解 |
|---|---|---|---|
| V3-R01 | 事务 session 长期占用连接，并发下资源耗尽 | 高 | session 独立限额 + 空闲超时强制回收；UI 明示事务占用 |
| V3-R02 | 多语句拆分在 dollar-quoted / 存储过程体上误判 | 高 | 复用并扩充分号状态机测试；边界不确定即拒绝执行，绝不尽力执行 |
| V3-R03 | 筛选条件拼接导致 SQL 注入 | 高 | 值全参数化、列名白名单、操作符枚举；安全测试覆盖 |
| V3-R04 | 用户误以为断链重连可续事务 | 中 | 明示事务随连接消亡；禁止自动重放事务状态 |
| V3-R05 | 契约扩展波及 v0.2 已稳定的 query 路径 | 高 | pool 与 session 路径并存；Week 1 零回归门槛 |
| V3-R06 | v0.4 安全编辑欲望导致范围膨胀 | 中 | 明确不做；Week 6 后不加新 FR |

明确不进入 v0.3：安全表格编辑、Table/View 对象设计与 DDL 预览、CSV 导入、SQL dump、备份同步、用户权限、ER/BI/AI（均见 [ROADMAP](./ROADMAP.md) v0.4-v0.5+）；加密分享连接配置（FR-221）与 EXPLAIN 可视化（FR-222）继续留在跨版本清单，按反馈再排。
