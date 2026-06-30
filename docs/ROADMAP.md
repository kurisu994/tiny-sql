---
title: tiny-sql 路线图
version: 0.1.0-draft-2
status: draft
last_updated: 2026-06-26
---

# tiny-sql 路线图

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [PLAN.md](./PLAN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

## 路线总览

```
v0.1  (5-6 周) ── MySQL + 3 跳 SSH + 拓扑图 + macOS only + 自动更新
   │
   ▼
v0.2  (首发后 2-3 个月) ── PG driver + passphrase 加密 + TLS + Schema-aware 智能联想
   │
   ▼
v0.3+ (半年+) ── Win/Linux + ssh-multihop crate 独立 publish + 多集群 diff + 加密分享
```

时间预估按"作者业余时间 12-13 小时/周"计算。

---

## v0.1 — 本次范围（5-6 周）

详见 [REQUIREMENTS.md 3.1](./REQUIREMENTS.md#31-v01-范围5-6-周--60-75-小时) 与 [PLAN.md](./PLAN.md)。

核心卖点：

- 多级 SSH 跳板可视化拓扑（FR-015）
- 每跳错误归因（FR-013，含 TunnelLost/ChannelDropped/AcceptLoopDied 三个 mid-session 变体）
- 180s 内感知隧道断开（FR-014，keepalive 60s + 连续 3 次失败阈值）
- MySQL 5.7 + 8.0 浏览 / SQL 执行 / 取消 / 只读保护
- macOS only / zh-CN only / 无 Apple Developer 代码签名
- 正式版自动更新（Tauri updater 签名包；RC 不作为更新源）

发布时间预期：2026-08 月初。

---

## v0.2 — 首发后 2-3 个月

启动条件：v0.1 dogfooding 1 个月稳定 + GitHub 收到 ≥ 5 条社区反馈。

### 功能

| ID | 功能 | 优先级 | 工量预估 |
|---|---|---|---|
| **FR-100** | PostgreSQL driver | P0 | 1 周 |
| **FR-102** | 加密 passphrase 存储（用户主密码 derive key） | P0 | 1 周 |
| **FR-103** | MySQL TLS 连接启用（webpki-roots / native-tls 选型） | P1 | 0.5 周 |
| **FR-104** | Schema-aware 智能联想（点 user_id 列自动 JOIN 候选） | P1 | 1.5 周 |
| **FR-105** | 实时隧道延迟动画（每跳 RTT 显示在边上） | P1 | 0.5 周 |
| **FR-106** | SQL 历史（最近 100 条） | P1 | 0.3 周 |
| **FR-107** | 导出 CSV / Excel | P2 | 0.5 周 |
| **FR-108** | 大表 LRU schema cache | P2 | 0.3 周 |
| **FR-109** | 多 tab 同时执行 | P2 | 1 周 |

合计 P0+P1 约 5-6 周；含 P2 约 7 周。

### 工程

- **extract trait Driver**：v0.1 是具体 `struct MySqlDriver`，v0.2 加 PG 时先用 rust-analyzer extract trait（两个实现在手才设计接口），再写 `PostgresDriver`（NFR-042）
- `MySqlDriverViaSshTunnel` 抽象为 `DriverViaSshTunnel<D: Driver>` 泛型
- keepalive 间隔 + 失败阈值可配置，FR-014 的 60s / 连续 3 次（180s）改为默认值
- 评估 Apple Developer 代码签名 / notarization（$99/年），降低首次打开摩擦

### v0.2 待定项（codex review surface，实施期决定）

eng review 中 codex 提出但 v0.1 未重开，留 v0.2 视实施情况决定：

- **KILL QUERY 取消 UI 是否细化为 4 状态**（`cancel_requested / killed / already_finished / failed`）。v0.1 先 2 状态（requested / done），视 dogfooding 反馈决定。
- **SshTunnelError 三变体是否重构为统一连接状态机**（`connecting / connected / degraded / reconnecting / lost / closed` + 内部 reason）。v0.1 用三个独立公共变体 + 各自 i18n key；若 dogfooding 发现 i18n key 膨胀，v0.2 重构为状态机。

### 文档

- 英文 README（首发英文社区）
- ARCHITECTURE.md 补 PG driver 章节
- 加 CONTRIBUTING.md（接受社区 PR 的标准）

---

## v0.3+ — 半年后

### 平台扩展

| ID | 功能 | 优先级 | 备注 |
|---|---|---|---|
| FR-200 | Windows 全平台 | P0 | CI 矩阵补 windows-latest，Windows 路径处理已存在（home_dir） |
| FR-201 | Linux 全平台 | P0 | Ubuntu LTS 22.04+ |
| FR-202 | ARM Linux（树莓派等） | P2 | 看社区呼声 |

### crate 独立化

| ID | 功能 | 备注 |
|---|---|---|
| FR-210 | `ssh-multihop` 独立 publish 到 crates.io | 需要：API 文档、example、CI 覆盖率、CHANGELOG |
| FR-211 | `db-driver` 独立 publish | 需要：≥ 2 个 driver impl（MySQL + PG） |

### 高级功能

| ID | 功能 | 优先级 | 备注 |
|---|---|---|---|
| FR-220 | 多集群 diff（同一表在 prod/staging 的 schema 差异） | P1 | SRE 友好场景 |
| FR-221 | 加密分享连接配置（导出文件 + 同事密码导入） | P1 | 团队场景 |
| FR-222 | EXPLAIN 可视化 | P2 | 复杂度高，看用户呼声 |
| FR-223 | 慢查询监控 | P2 | 同上 |
| FR-224 | 协同编辑同一连接（多人共享） | P3 | 需要后端服务，可能永不做 |

### 国际化

| ID | 功能 | 备注 |
|---|---|---|
| FR-230 | 英文 UI（en） | i18next bundle 填齐 |
| FR-231 | 繁体中文 / 日文 | 看社区翻译贡献 |

---

## 不做的事（明确边界）

以下功能**永久不在路线图**，避免用户和贡献者反复提问：

### 数据库

- **Oracle / SQL Server / MongoDB**：小众或商业绑定，背景调研 + license 评估成本高，副业项目不背书
- **Redis / Kafka 等非关系型**：作者已有 redis-desktop-client，不重叠

### UI 功能

- **写操作的图形化编辑器**（点 cell 改值后写回）：SQL textarea 是 v0.1 之后的写操作上限。理由：图形化编辑器需要列权限模型 + 类型转换 UI + 行级 dirty tracking，复杂度过高
- **可视化建表**（拖拽列 → DDL 生成）：DataGrip 的卖点，不是 tiny-sql 的
- **可视化 ER 图**：同上

### 团队与协同

- **多人协同编辑同一 SQL**（实时光标）：tiny-sql 是单机工具
- **服务端账号**（账号系统 / 云同步连接配置）：开源信任的前提是仅本地
- **审计日志服务**：企业场景，不背书
- **基于角色的权限**：同上

### 监控与运维

- **数据库性能监控仪表盘**：DBA 工具范畴
- **告警与通知**：同上
- **备份与恢复**：mysqldump 已存在，无需重造

### 平台

- **iOS / Android**：手机敲 SQL 反人类
- **Web 版**：SSH 多跳 + 客户端加密在浏览器里做不到（或做了很糟糕）

---

## 路线决策原则

每个 feature 进路线图前，必须能回答以下 3 个问题：

1. **作者自己会用吗？**（dogfooding 优先）
2. **这个 feature 与"把跳板机从雾中一根管子变成可观测路由器"叙事一致吗？**
3. **比同等工量的替代方案（如改 v0.1 一个 P0 bug）值吗？**

3 个全是 yes 才进路线图。

---

## 反馈通道

- GitHub Issues：bug / feature request
- GitHub Discussions：开放讨论 / v0.2 优先级投票
- V2EX / 掘金 帖子下评论

24h 内首次回应是承诺。
