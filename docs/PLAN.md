---
title: tiny-sql 待办开发计划
version: 0.6.0-draft-2
status: in-progress
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

试用期发现的 P0/P1 走补丁，不混进下一版承诺。v0.7+ 候选见 [ROADMAP](./ROADMAP.md#v07--数据同步权限与高级工作台)，本文件在用户要求前不立项。
