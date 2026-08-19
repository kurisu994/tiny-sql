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

当前稳定版为 `v0.1.0`（2026-08-18 发布）。**v0.2 的全部开发任务已完成**：Driver 契约、PostgreSQL 后端与应用接线、主密码加密与 TLS 错误诊断、schema intelligence、查询工作台（历史/多 tab/导出/列宽）、SSH RTT/重连/keepalive、文档与英文 README。自动化门禁全绿：`just check`、双 driver integration 9/9、本机 Tauri 调试包构建成功。

**v0.2 真实环境验收已于 2026-08-19 全部通过**（T3.4 双 driver Tauri 验收、T4.3 真实 TLS、T7.1/T7.2 真实链路、T8.1 双 driver dogfooding），V2-CP2 / V2-CP3 / V2-CP4 均已关闭。剩余事项仅为发布。

## v0.2 剩余待办

### 发布

- [ ] **PostgreSQL 版本矩阵 [1h]** RC 前完成 15.latest / 18.latest 双端点 integration 回归（版本基线见 `memory-bank/techContext.md`）。
- [ ] **V2-T8.2 [3h]** 作者和至少 2 位试用者使用 v0.2 RC ≥ 1 周；至少 1 人以 PostgreSQL 为主，要求 0 数据丢失、0 凭据泄露、0 不可恢复 crash。
- [ ] **V2-T8.4 [2h]** `just release v0.2.0-rc1` 触发全平台构建并下载验收；P0/P1 清零后发布 v0.2.0，通过 **V2-CP5**。

### 发布检查点

| 检查点 | 通过标准 | 不通过的应对 |
|---|---|---|
| **V2-CP2** 双 driver 闭环 | ✅ 已通过（2026-08-19 T3.4 真实验收） | — |
| **V2-CP3** 安全与 TLS | ✅ 已通过（2026-08-19 T4.3 真实 TLS 正反例） | — |
| **V2-CP4** 查询工作台 | ✅ 已通过（2026-08-19 T8.1 dogfooding） | — |
| **V2-CP5** 发布 | 双 driver dogfooding + P0/P1 清零 + RC 安装通过 | 延后正式版，不降低凭据与数据安全标准 |

明确不进入 v0.2：安全表格编辑、对象设计、CSV 导入、SQL dump、备份同步、用户权限和 ER/BI/AI；这些分别留在 v0.3-v0.5+（见 [ROADMAP](./ROADMAP.md)）。
