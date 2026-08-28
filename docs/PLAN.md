---
title: tiny-sql 待办开发计划
version: 0.8.0
status: awaiting-acceptance
last_updated: 2026-08-28
---

# tiny-sql 待办开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> 本文件只保留尚未完成的工作。已交付周计划见 [progress.md](../memory-bank/progress.md)；用户可见变化见 [CHANGELOG.md](../CHANGELOG.md)。

**代码事实（以仓库为准）**：四文件版本号已切到 `v0.8.0-rc2`（tag `v0.8.0-rc2`，发布提交 `53c5e5a`，2026-08-28）；GitHub 稳定 Release 仍为 `v0.7.0`。main 含 v0.8 全部功能编码、SQLite driver 与应用设置弹窗。前后端各 54 个 Tauri command（v0.8 与 SQLite 均未新增 command）。`just check` 最近全绿：vitest 190 例（26 文件，2026-08-28 设置轮新增 settings-store 9 例）、app_lib 67、db-driver 单测 47 + SQLite integration 23。

---

# 待用户验收

周计划明细已归档：

- [v0.4](../memory-bank/progress.md#v04-已交付周计划归档) FR-250 / 251 / 252
- [v0.5](../memory-bank/progress.md#v05-已交付周计划归档) FR-253 / 260 / 221
- [v0.6](../memory-bank/progress.md#v06-已交付周计划归档) FR-220 / 261 / 263
- [v0.7](../memory-bank/progress.md#v07-已交付周计划归档) FR-266 / 262 / 222
- [v0.8](../memory-bank/progress.md#v08-已交付周计划归档) FR-270 / 271 / 272 / 273 / 274 / 275

| 版本 | 代码 | 剩余 | 清单 |
|---|---|---|---|
| v0.4–v0.7 | 已打进 `v0.7.0` | 正式版后 GUI 回归；P0/P1 走补丁 | [RELEASE_CHECKLIST](./RELEASE_CHECKLIST.md) |
| v0.8 | `v0.8.0-rc2` 已发布，版本号已切 `0.8.0-rc2` | GUI 回归、RC 试用、`just release v0.8.0` | [v0.8](./RELEASE_CHECKLIST.md#v08-发布检查清单) |

试用期发现的 P0/P1 走补丁，不混进下一版承诺。

v0.8 GUI 入口：连接表单「应用只读 / 环境」；树顶「复制表」；结果格双击检查器；修改表可重命名非主键列；EXPLAIN 树带提示；应用菜单 `Settings...`（⌘,）打开设置弹窗（rc2 新增）。
