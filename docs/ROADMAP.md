---
title: tiny-sql 路线图
version: 0.1.0-draft-2
status: draft
last_updated: 2026-08-18
---

# tiny-sql 路线图

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [PLAN.md](./PLAN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

## 路线总览

```
v0.1  (5-6 周) ── MySQL + 3 跳 SSH + 拓扑图 + macOS/Windows/Linux 打包 + 自动更新
   │
   ▼
v0.2  (首发后 2-3 个月) ── PG driver + passphrase 加密 + TLS 验收/UX + Schema-aware 智能联想
   │
   ▼
v0.3  ── 查询工作台 + 元数据检索 + 服务端筛选分页 + 可靠事务
   │
   ▼
v0.4  ── 安全表格编辑 + Table/View 对象管理 + CSV/SQL dump 导入导出
   │
   ▼
v0.5+ ── 备份同步 + 用户权限 + ER/BI/AI + 平台与 crate 长期演进
```

时间预估按"作者业余时间 12-13 小时/周"计算。

---

## v0.1 — 本次范围（5-6 周）

详见 [REQUIREMENTS.md 3.1](./REQUIREMENTS.md#31-v01-范围5-6-周--60-75-小时) 与 [PLAN.md](./PLAN.md)。

核心卖点：

- 多级 SSH 跳板可视化拓扑（FR-015）
- 每跳错误归因（FR-013；TunnelLost/ChannelDropped/AcceptLoopDied 公共错误已定义，后两类运行检测仍待补）
- 180s 内感知隧道断开（FR-014，keepalive 60s + 连续 3 次失败阈值）
- MySQL 5.7 + 8.0 浏览 / SQL 执行 / 取消 / 只读保护
- macOS / Windows / Linux x64 打包 / zh-CN only / 无 Apple Developer 代码签名
- 正式版自动更新（Tauri updater 签名包；RC 不作为更新源）

`v0.1.0` 已于 2026-08-18 正式发布。Release workflow 四个平台构建全部成功，GitHub Release 已包含 macOS arm64/x64、Windows x64、Linux x64 安装包、签名更新包与四平台 `latest.json`。README 真实 GIF、应用内升级端到端实测和少量已知能力缺口作为发布后待办继续跟踪，不影响已发布版本事实。

---

## v0.2 — 首发后 2-3 个月

启动条件：现有 dogfooding 与 v0.1.0 全平台发布验收不重做；先完成 [PLAN 的发布后待办](./PLAN.md#v01-发布后待办) 中影响代码承诺的事项、应用内升级端到端实测和 PostgreSQL 版本基线。真实 GIF 可随 v0.1.1 补充，不阻塞 v0.2 Week 1。

详细任务、依赖、检查点与测试矩阵见 [v0.2 开发计划](./PLAN.md#v02-开发计划)。

### 功能

| ID | 功能 | 优先级 | 工量预估 |
|---|---|---|---|
| **FR-100** | PostgreSQL driver | P0 | 1 周 |
| **FR-102** | 加密 passphrase 存储（用户主密码 derive key） | P0 | 1 周 |
| **FR-103** | MySQL TLS 真实环境验收、证书选择与错误诊断 UX 打磨（模式/证书路径已接线） | P1 | 0.5 周 |
| **FR-104** | Schema-aware 智能联想（点 user_id 列自动 JOIN 候选） | P1 | 1.5 周 |
| **FR-105** | 实时隧道延迟动画（每跳 RTT 显示在边上） | P1 | 0.5 周 |
| **FR-110** | 隧道断开后的「重连」按钮（v0.1 需先断开再重新打开） | P1 | 0.3 周 |
| **FR-111** | 结果表格列宽拖拽调整（v0.1 列宽固定） | P2 | 0.3 周 |
| **FR-112** | schema 树列清单展示（`db_list_columns` 前端接线） | P1 | 0.5 周 |
| **FR-106** | SQL 历史（最近 100 条） | P1 | 0.3 周 |
| **FR-107** | 导出 CSV / Excel | P2 | 0.5 周 |
| **FR-108** | 大表 LRU schema cache | P2 | 0.3 周 |
| **FR-109** | 多 tab 同时执行 | P2 | 1 周 |

合计 P0+P1 约 5-6 周；含 P2 约 7 周。

### 工程

- **extract trait Driver**：v0.1 是具体 `struct MySqlDriver`，v0.2 加 PG 时先用 rust-analyzer extract trait（两个实现在手才设计接口），再写 `PostgresDriver`（NFR-042）
- `AppState` 的活跃连接注册表从具体 `MySqlDriver` 扩展到可容纳多 driver；隧道生命周期仍留在 `src-tauri::OpenConnection` 组合层
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

## v0.3+ — 后续开发版本

> 从 Navicat 日常替代能力清单中，先剔除 v0.2 已规划的 SQL 历史（FR-106）、CSV/Excel 导出（FR-107）、column 树（FR-112）和多查询 tab（FR-109）。以下只登记剩余能力，避免同一功能跨版本重复承诺。

### v0.3 — 查询与浏览效率

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-240 | 保存 / 打开 SQL 文件与最近文件 | P1 | SQL 历史仍由 v0.2 FR-106 负责 |
| FR-241 | index / constraint 元数据树与数据库对象搜索 | P1 | column 树仍由 v0.2 FR-112 负责 |
| FR-242 | 表数据服务端筛选、排序和分页 | P0 | 避免先拉全表再在前端处理 |
| FR-243 | 多结果 tab 与 SQL 格式化 | P1 | 多查询 tab 仍由 v0.2 FR-109 负责；同一次执行可保留多个结果 |
| FR-244 | 连接绑定的独占 session 与可靠事务 | P0 | `BEGIN / COMMIT / ROLLBACK` 必须固定在同一 MySQL connection；是 v0.4 安全编辑的前置能力 |

### v0.4 — 安全数据维护与对象管理

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-250 | 仅带主键单表的安全表格编辑 | P0 | 支持新增 / 修改 / 删除、dirty state、提交 / 放弃；不允许 JOIN / 聚合结果直接写回 |
| FR-251 | Table / View 结构查看、DDL 预览与对象编辑 | P1 | 先做结构化表单 + SQL 预览，再逐步扩展索引、约束等对象设计；执行 DDL 前必须二次确认 |
| FR-252 | CSV 导入与 SQL dump 导入 / 导出 | P1 | CSV/Excel 结果导出仍由 v0.2 FR-107 负责；本项补导入和完整 SQL 文件工作流 |

### v0.5+ — 管理、迁移与高级工作台

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-260 | MySQL 备份与恢复 | P1 | 优先编排兼容工具并提供进度、日志和失败恢复，不自行发明备份格式 |
| FR-261 | 数据传输、数据同步与结构同步 | P1 | 基于 FR-220 多集群 diff 生成可审阅脚本，默认不自动执行破坏性变更 |
| FR-262 | MySQL 用户、角色与权限管理 | P1 | 只管理数据库权限，不引入 tiny-sql 服务端账号或应用 RBAC |
| FR-263 | ER 图与数据库反向工程 | P2 | 先做只读关系可视化，再评估正向生成 DDL |
| FR-264 | BI 图表与仪表板 | P2 | 面向查询结果的本地可视化，不扩展成独立监控平台 |
| FR-265 | Schema-aware AI Assistant | P2 | 可配置模型供应商；发送 schema / SQL 前必须明确提示数据边界 |

以下工程与产品工作在 v0.3-v0.5+ 期间按反馈穿插，不与上面的 Navicat 日常替代主线抢 P0：

### 跨版本：平台扩展

| ID | 功能 | 优先级 | 备注 |
|---|---|---|---|
| FR-200 | Windows 安装体验打磨 | P1 | v0.1 已补 Windows x64 CI 打包；后续补真实用户验证、签名和安装说明 |
| FR-201 | Linux 安装体验打磨 | P1 | v0.1 已补 Linux x64 AppImage；后续补真实发行版验证和更多包格式 |
| FR-202 | ARM Linux（树莓派等） | P2 | 看社区呼声 |

### 跨版本：crate 独立化

| ID | 功能 | 备注 |
|---|---|---|
| FR-210 | `ssh-multihop` 独立 publish 到 crates.io | 需要：API 文档、example、CI 覆盖率、CHANGELOG |
| FR-211 | `db-driver` 独立 publish | 需要：≥ 2 个 driver impl（MySQL + PG） |

### 跨版本：既有高级功能

| ID | 功能 | 优先级 | 备注 |
|---|---|---|---|
| FR-220 | 多集群 diff（同一表在 prod/staging 的 schema 差异） | P1 | SRE 友好场景 |
| FR-221 | 加密分享连接配置（导出文件 + 同事密码导入） | P1 | 团队场景 |
| FR-222 | EXPLAIN 可视化 | P2 | 复杂度高，看用户呼声 |
| FR-223 | 慢查询监控 | P2 | 同上 |
| FR-224 | 协同编辑同一连接（多人共享） | P3 | 需要后端服务，可能永不做 |

### 跨版本：国际化

| ID | 功能 | 备注 |
|---|---|---|
| FR-230 | 英文 UI（en） | i18next bundle 填齐 |
| FR-231 | 繁体中文 / 日文 | 看社区翻译贡献 |

---

## 不做的事（明确边界）

以下功能在 v0.3-v0.5+ 规划调整后仍不进入路线图，避免用户和贡献者反复提问：

### 数据库

- **Oracle / SQL Server / MongoDB**：小众或商业绑定，背景调研 + license 评估成本高，副业项目不背书
- **Redis / Kafka 等非关系型**：作者已有 redis-desktop-client，不重叠

### UI 功能

- **JOIN / 聚合结果直接写回**：v0.4 安全编辑只允许能用主键唯一定位的单表结果；复杂结果继续通过 SQL 显式修改
- **无 SQL 预览的拖拽式 DDL 执行**：对象设计必须先生成并展示 SQL，再由用户确认执行

### 团队与协同

- **多人协同编辑同一 SQL**（实时光标）：tiny-sql 是单机工具
- **服务端账号**（账号系统 / 云同步连接配置）：开源信任的前提是仅本地
- **审计日志服务**：企业场景，不背书
- **tiny-sql 自身的应用角色 / 权限系统**：数据库侧 MySQL 用户与权限管理已列入 FR-262，但应用本身仍无服务端账号和 RBAC

### 监控与运维

- **数据库性能监控仪表盘**：DBA 工具范畴
- **告警与通知**：同上

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
