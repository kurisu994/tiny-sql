---
title: tiny-sql 待办开发计划
version: 0.7.0-draft-1
status: draft
last_updated: 2026-08-24
---

# tiny-sql 待办开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> 本文件只保留尚未完成的工作。已交付周计划见 [progress.md](../memory-bank/progress.md)；用户可见变化见 [CHANGELOG.md](../CHANGELOG.md)。

**代码事实（以仓库为准）**：四文件版本号为 `0.4.0-rc1`；稳定 GitHub Release 仍是 `v0.3.0`。main 已包含 v0.4–v0.6 功能编码（50 个 Tauri command，`just check` 全绿）。尚未正式切 `v0.4.0` / `v0.5.0` / `v0.6.0`。

---

# 待用户验收

周计划明细已归档：

- [v0.4](../memory-bank/progress.md#v04-已交付周计划归档) FR-250 / 251 / 252
- [v0.5](../memory-bank/progress.md#v05-已交付周计划归档) FR-253 / 260 / 221
- [v0.6](../memory-bank/progress.md#v06-已交付周计划归档) FR-220 / 261 / 263

| 版本 | 代码 | 剩余 | 清单 |
|---|---|---|---|
| v0.4 | 已在 `0.4.0-rc1` 发布 | GUI 回归、一周试用、`just release v0.4.0` | [RELEASE_CHECKLIST v0.4](./RELEASE_CHECKLIST.md#v04-发布检查清单) |
| v0.5 | main 已落地，未切正式版 | GUI 回归、RC 试用、正式发布 | [v0.5](./RELEASE_CHECKLIST.md#v05-发布检查清单) |
| v0.6 | main 已落地，未切正式版 | GUI 回归（先开两条连接再进「对比」）、RC 试用、正式发布 | [v0.6](./RELEASE_CHECKLIST.md#v06-发布检查清单) |

试用期发现的 P0/P1 走补丁，不混进下一版承诺。

---

# v0.7 开发计划

> 本节为 2026-08-24 起草，**范围已由用户确认**。功能开工建议等 v0.4–v0.6 用户验收清零；等待期间只做文档级契约。

**周期与预算**：8 周，约 96-100h。

**定位**：v0.7 的主题是「表数据搬迁、库内权限与执行计划」。v0.6 已能对两套连接做结构 diff / 结构脚本，本版补上**同方言表数据拷贝**（FR-266，P0），再给 MySQL 权限一个可预览的管理面（FR-262，P1），并让 EXPLAIN 不再只是一张普通结果表（FR-222，P1）。完整范围以 [ROADMAP v0.7](./ROADMAP.md#v07--表数据搬迁库内权限与执行计划) 与 [REQUIREMENTS §3.7](./REQUIREMENTS.md#37-v07-范围表数据搬迁库内权限与执行计划) 为准。

**为什么不把原 v0.7+ 整包塞进来**：行级双向同步、BI 仪表板、AI 助手各自是另一条产品线。8 周仍只扛 1 个不降级 P0 + 2 个可降级 P1。

| ID | 功能 | 优先级 | 版本内地位 |
|---|---|---|---|
| FR-266 | 双连接、同方言、表级数据拷贝 | P0 | 不降级 |
| FR-262 | MySQL 用户与权限（预览 SQL） | P1 | 可降级 PG；可降级「只读授权」 |
| FR-222 | EXPLAIN 可读化 | P1 | 可降级整项 |

## V7.1 Phase 0：启动准入（不计入 8 周）

- [ ] v0.4–v0.6 无阻塞 P0/P1 反馈；补丁走旧版号，不混进 v0.7。
- [x] `REQUIREMENTS.md` 已补 §3.7（2026-08-24）。

真实用户反馈的 P0/P1 始终优先于 v0.7 任何任务。

## V7.2 时间线

```text
Week 1  13h  拷贝内核：列映射、分页读、bulk_insert 写（FR-266 后端）
Week 2  13h  对比台「拷贝数据」UI：预览行数 / 映射 / 手输目标表（FR-266 前端）
Week 3  12h  清空后插入 vs 仅追加、取消、进度、失败定位（FR-266 收口）
Week 4  12h  MySQL 用户 / 授权列表（FR-262 前半）
Week 5  12h  创建用户 / GRANT / REVOKE 的 SQL 预览确认（FR-262 后半）
Week 6  13h  EXPLAIN 解析与树/表展示（FR-222 前半）
Week 7  12h  双方言 EXPLAIN；PG 权限只读或降级（收口）
Week 8  12h  dogfood + 文档 + RC
```

关键依赖：

1. v0.6 双连接已打开 + `bulk_insert_rows` / `browse_table` → 拷贝；不新开「同步协议」。
2. 只允许**同方言**、**已打开**连接；跨 driver / 未打开一律拒绝。
3. 权限变更与拷贝清空目标表必须展示完整 SQL / 语义，并手输目标名。
4. EXPLAIN 走现有 `db_query`（元数据语句免写确认），只做展示，不改执行计划。

## V7.3 分周任务

### Week 1 — 拷贝内核（13h）✅ 已完成（2026-08-24）

- **V7-T1.1 [5h]** ✅ `db_copy_table_rows`：browse 分页读 + `bulk_insert_rows`；列按名字映射。
- **V7-T1.2 [5h]** ✅ append / replace（TRUNCATE 预览）。
- **V7-T1.3 [3h]** ✅ 映射单测；跨 driver / 无映射 / 目标名不符拒绝。

### Week 2 — 拷贝 UI（13h）✅ 已完成（2026-08-24）

- **V7-T2.1 [6h]** ✅ 对比台「拷贝数据」。
- **V7-T2.2 [4h]** ✅ 预览行数与列映射。
- **V7-T2.3 [3h]** ✅ 手输 `database.table` 才启用；确认框含连接名。

### Week 3 — 拷贝收口（12h）✅ 已完成（2026-08-24）

- **V7-T3.1 [5h]** ✅ `copy:progress` + 取消。
- **V7-T3.2 [4h]** ✅ replace 展示 TRUNCATE 并手输确认。
- **V7-T3.3 [3h]** ✅ 不做双向同步 / 跨 driver。

验收：**V7-CP2 已通过（2026-08-24）**。

### Week 4 — 权限列表（12h）✅ 已完成（2026-08-24）

- **V7-T4.1 [6h]** ✅ `db_list_accounts` 只取 User/Host，不含哈希。
- **V7-T4.2 [4h]** ✅ `db_show_grants`。
- **V7-T4.3 [2h]** ✅ `error.privilege.forbidden`。

### Week 5 — 权限变更（12h）✅ 已完成（2026-08-24）

- **V7-T5.1 [5h]** ✅ CREATE/DROP/GRANT/REVOKE 白名单生成 + 确认框。
- **V7-T5.2 [4h]** ✅ 走 `db_query` 写确认。
- **V7-T5.3 [3h]** ✅ PG 角色只读。

验收：**V7-CP3 已通过（2026-08-24）**。

### Week 6 — EXPLAIN 展示（13h）✅ 已完成（2026-08-24）

- **V7-T6.1 [6h]** ✅ 「解释」按钮包装 EXPLAIN。
- **V7-T6.2 [4h]** ✅ MySQL 行转树。
- **V7-T6.3 [3h]** ✅ ANALYZE 单独确认。

### Week 7 — 双方言收口（12h）✅ 已完成（2026-08-24）

- **V7-T7.1 [5h]** ✅ PG `EXPLAIN (FORMAT JSON)` 递归树。
- **V7-T7.2 [4h]** ✅ 超过 200 节点截断。
- **V7-T7.3 [3h]** ✅ PG 权限只读文案。

验收：**V7-CP4 已通过（2026-08-24）**。

### Week 8 — 发布（12h）

- **V7-T8.1** 双连接拷贝 + MySQL GRANT + EXPLAIN 真实回归。
- **V7-T8.2** RC 试用（0 误清空生产表、0 凭据进日志）。
- **V7-T8.3** 文档 / CHANGELOG / 清单。
- **V7-T8.4** `just check`。

## V7.4 检查点与降级

| 检查点 | 通过标准 | 状态 |
|---|---|---|
| **V7-CP0** | §V7.1 | ⏭ 按用户要求跳过 |
| **V7-CP1** | 拷贝内核可单测 | ✅ 2026-08-24 |
| **V7-CP2** | 同方言表追加拷贝可用 | ✅ 2026-08-24 |
| **V7-CP3** | MySQL GRANT 预览执行 | ✅ 2026-08-24 |
| **V7-CP4** | EXPLAIN 双方言或降级 | ✅ 2026-08-24 |
| **V7-CP5** | 发布门槛 | ⏳ |

超时降级：FR-222 整项 → PG 权限变更 → replace 模式（保 append）。**FR-266 append 拷贝不降级**。

## V7.5 风险

| ID | 风险 | 缓解 |
|---|---|---|
| V7-R01 | 把生产表拷进/清空错库 | 手输目标表；确认框写连接名 |
| V7-R02 | 大表拷贝占满隧道 | 分页 + 可取消；不一次拉全表 |
| V7-R03 | SHOW GRANTS / mysql.user 把哈希送到 UI | 前端只收账号与权限文本 |
| V7-R04 | EXPLAIN ANALYZE 当只读 | 单独入口 + 写确认 |
| V7-R05 | 做成双向同步 / AI | 明确不做 |

明确不进入 v0.7：双向行级同步、冲突合并、BI 仪表板、AI、应用内账号、跨 driver 拷贝。
