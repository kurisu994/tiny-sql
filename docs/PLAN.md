---
title: tiny-sql 待办开发计划
version: 0.7.0
status: awaiting-acceptance
last_updated: 2026-08-24
---

# tiny-sql 待办开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> 本文件只保留尚未完成的工作。已交付周计划见 [progress.md](../memory-bank/progress.md)；用户可见变化见 [CHANGELOG.md](../CHANGELOG.md)。

**代码事实（以仓库为准）**：四文件版本号为 `0.4.0-rc1`；稳定 GitHub Release 仍是 `v0.3.0`。main 已包含 v0.4–v0.7 功能编码（前后端各 54 个 Tauri command，`just check` 全绿：vitest 163、app_lib 66、db-driver 43、ssh-multihop 8）。尚未正式切 `v0.4.0` / `v0.5.0` / `v0.6.0` / `v0.7.0`。

---

# 待用户验收

周计划明细已归档：

- [v0.4](../memory-bank/progress.md#v04-已交付周计划归档) FR-250 / 251 / 252
- [v0.5](../memory-bank/progress.md#v05-已交付周计划归档) FR-253 / 260 / 221
- [v0.6](../memory-bank/progress.md#v06-已交付周计划归档) FR-220 / 261 / 263
- [v0.7](../memory-bank/progress.md#v07-已交付周计划归档) FR-266 / 262 / 222

| 版本 | 代码 | 剩余 | 清单 |
|---|---|---|---|
| v0.4 | 已在 `0.4.0-rc1` 发布 | GUI 回归、一周试用、`just release v0.4.0` | [RELEASE_CHECKLIST v0.4](./RELEASE_CHECKLIST.md#v04-发布检查清单) |
| v0.5 | main 已落地，未切正式版 | GUI 回归、RC 试用、正式发布 | [v0.5](./RELEASE_CHECKLIST.md#v05-发布检查清单) |
| v0.6 | main 已落地，未切正式版 | GUI 回归（先开两条连接再进「对比」）、RC 试用、正式发布 | [v0.6](./RELEASE_CHECKLIST.md#v06-发布检查清单) |
| v0.7 | main 已落地，未切正式版 | GUI 回归（拷贝 / 权限 / EXPLAIN）、RC 试用、正式发布 | [v0.7](./RELEASE_CHECKLIST.md#v07-发布检查清单) |

试用期发现的 P0/P1 走补丁，不混进下一版承诺。

v0.7 GUI 入口：对比台「拷贝数据」；工作台「权限」；查询区「解释 / ANALYZE」。
