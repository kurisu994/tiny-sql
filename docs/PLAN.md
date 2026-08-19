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

**v0.2 剩余事项全部是真实环境 / 人工验收与发布。**

## v0.2 剩余待办

### 真实环境验收

- [ ] **V2-T3.4 [2h]** 真实 Tauri 应用验收（调试包在 `target/debug/bundle/`）：PostgreSQL 直连、双 driver 切换与取消不串线、MySQL/PostgreSQL 各自 1 跳 SSH。通过后关闭 **V2-CP2**。
- [ ] **V2-T4.3 [3h]** 真实 TLS MySQL 验收：Preferred / Required / Verify CA / Verify Identity 正反例与双向证书；确认 TLS 专项错误 key 的文案可操作性。通过后关闭 **V2-CP3**。
- [ ] **V2-T7.1/T7.2 真实链路 [2h]** 多跳环境确认累计 RTT 数值与 2s 超时表现不阻塞连接主链路；断开中间跳后拓扑 lost → 手动重连 → connected 闭环，无旧 task / event 泄漏。
- [ ] **V2-T8.1 [4h]** 双 driver dogfooding 回归：MySQL/PostgreSQL × 直连 / 1 跳 / 真实 3 跳，覆盖 metadata、查询、取消、历史、tab、导出、TLS 与重连。通过后确认 **V2-CP4**。

### 发布

- [ ] **PostgreSQL 版本矩阵 [1h]** RC 前完成 15.latest / 18.latest 双端点 integration 回归（版本基线见 `memory-bank/techContext.md`）。
- [ ] **V2-T8.2 [3h]** 作者和至少 2 位试用者使用 v0.2 RC ≥ 1 周；至少 1 人以 PostgreSQL 为主，要求 0 数据丢失、0 凭据泄露、0 不可恢复 crash。
- [ ] **V2-T8.4 [2h]** `just release v0.2.0-rc1` 触发全平台构建并下载验收；P0/P1 清零后发布 v0.2.0，通过 **V2-CP5**。

### 发布检查点

| 检查点 | 通过标准 | 不通过的应对 |
|---|---|---|
| **V2-CP2** 双 driver 闭环 | T3.4 真实验收完成 | 延后发布，先修状态与 dialect 边界 |
| **V2-CP3** 安全与 TLS | T4.3 真实 TLS 正反例通过 | 停止发布；保留会话 passphrase，不强推持久化 |
| **V2-CP4** 查询工作台 | T8.1 中历史 / tab / 导出无隔离与内存问题 | P2 整体移入 v0.2.1，不在 Release notes 承诺 |
| **V2-CP5** 发布 | 双 driver dogfooding + P0/P1 清零 + RC 安装通过 | 延后正式版，不降低凭据与数据安全标准 |

明确不进入 v0.2：安全表格编辑、对象设计、CSV 导入、SQL dump、备份同步、用户权限和 ER/BI/AI；这些分别留在 v0.3-v0.5+（见 [ROADMAP](./ROADMAP.md)）。
