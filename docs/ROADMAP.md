---
title: tiny-sql 路线图
version: 0.6.0-draft-1
status: draft
last_updated: 2026-08-24
---

# tiny-sql 路线图

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [PLAN.md](./PLAN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

## 路线总览

```
v0.1  ✅ 已发布（2026-08-18）── MySQL + 3 跳 SSH + 拓扑图 + macOS/Windows/Linux 打包 + 自动更新
   │
   ▼
v0.2  ✅ 已发布（2026-08-20）── PG driver + passphrase 加密 + TLS 验收/UX + Schema-aware 智能联想
   │
   ▼
v0.3  ✅ 已发布（2026-08-22）── 查询工作台 + 元数据检索 + 服务端筛选分页 + 可靠事务
   │
   ▼
v0.4  🚧 编码与自动化门禁完成，rc1 试用中 ── 安全表格编辑 + 对象管理 + CSV/SQL dump 导入导出
   │
   ▼
v0.5  🚧 编码完成，待 GUI/RC 验收 ── 修改表 / 索引设计器 + 官方备份恢复 + 加密分享连接
   │
   ▼
v0.6  🚧 编码完成，待 GUI/RC 验收 ── 双连接结构 diff + 可审阅结构同步脚本 + 只读 ER
   │
   ▼
v0.7+ ── 数据同步 + 用户权限 + BI/AI + 平台与 crate 长期演进
```

时间预估按"作者业余时间 12-13 小时/周"计算。

---

## v0.1 — 已发布（2026-08-18）

详见 [REQUIREMENTS.md 3.1](./REQUIREMENTS.md#31-v01-范围5-6-周--60-75-小时) 与 [PLAN.md](./PLAN.md)。

核心卖点：

- 多级 SSH 跳板可视化拓扑（FR-015）
- 每跳错误归因（FR-013；TunnelLost/ChannelDropped/AcceptLoopDied 三个 mid-session 变体均有独立运行检测路径与去重上报，v0.2 已收口）
- 180s 内感知隧道断开（FR-014，keepalive 60s + 连续 3 次失败阈值）
- MySQL 5.7 + 8.0 浏览 / SQL 执行 / 取消 / 只读保护
- macOS / Windows / Linux x64 打包 / zh-CN only / 无 Apple Developer 代码签名
- 正式版自动更新（Tauri updater 签名包；RC 不作为更新源）

`v0.1.0` 已于 2026-08-18 正式发布。Release workflow 四个平台构建全部成功，GitHub Release 已包含 macOS arm64/x64、Windows x64、Linux x64 安装包、签名更新包与四平台 `latest.json`；从 v0.0.3 发现、下载、安装并重启到 v0.1.0 的应用内更新闭环也已实测。少量已知能力缺口作为并行待办继续跟踪，不影响已发布版本事实。

---

## v0.2 — 已发布（2026-08-20）

详细任务历史见 [progress.md](../memory-bank/progress.md)。

**发布事实**：`v0.2.0` 已于 2026-08-20 正式发布。Week 1-6 全部功能（下表）+ V2-T7.4 决策 + 文档收口完成；`just check` 全绿，双 driver integration 全过，全平台构建与应用内升级闭环验收通过。

### 功能

| ID | 功能 | 优先级 | 状态 |
|---|---|---|---|
| **FR-100** | PostgreSQL driver | P0 | ✅ 已完成（含 V2-T3.4 真实 Tauri 验收） |
| **FR-102** | 加密 passphrase 存储（用户主密码 Argon2id 派生 key） | P0 | ✅ 已完成（支持迁移回滚与锁定） |
| **FR-103** | MySQL TLS 证书选择与错误诊断（模式/证书选择器/错误分类已接线） | P1 | ✅ 已完成（含 V2-T4.3 真实 TLS 正反例验收） |
| **FR-104** | Schema-aware 智能联想（双方言补全 + 启发式 JOIN + ON） | P1 | ✅ 已完成（Week 5） |
| **FR-105** | 每跳累计 SSH 协议 RTT/超时显示 | P1 | ✅ 已完成（含真实多跳链路验收） |
| **FR-110** | 隧道断开后的幂等「重连」按钮 | P1 | ✅ 已完成（含真实断链验收） |
| **FR-111** | 结果表格列宽拖拽调整（localStorage 持久化 + 恢复默认） | P2 | ✅ 已完成（Week 6） |
| **FR-112** | schema 树列清单展示（按需展开 + 完整元信息） | P1 | ✅ 已完成（Week 5） |
| **FR-106** | SQL 历史（最近 100 条加密落盘 + 回填 + 清空） | P1 | ✅ 已完成（Week 6） |
| **FR-107** | 导出 CSV / Excel（后端流式写文件 + 区分 NULL/空串） | P2 | ✅ 已完成（Week 6） |
| **FR-108** | 大表 LRU schema cache（128 项、5 分钟 TTL 分区隔离） | P2 | ✅ 已完成（Week 5） |
| **FR-109** | 多 tab 同时执行（独立 SQL/结果/query_id/取消/dirty） | P2 | ✅ 已完成（Week 6） |

合计 P0+P1 约 5-6 周；含 P2 约 7 周。

### 工程

- **Driver 契约**：V2-T1.1 已从 `MySqlDriver` 真实调用面提取对象安全的最小契约，v0.2 内已新增 `PostgresDriver` 双实现并按反馈收窄（NFR-042）
- `AppState` 的活跃连接注册表从具体 `MySqlDriver` 扩展到可容纳多 driver；隧道生命周期仍留在 `src-tauri::OpenConnection` 组合层
- keepalive 间隔 + 失败阈值可配置，FR-014 的 60s / 连续 3 次（180s）改为默认值
- 评估 Apple Developer 代码签名 / notarization（$99/年），降低首次打开摩擦

### v0.2 决策落地项（V2-T7.4）

- **KILL QUERY 四状态与 SSH 统一状态机**：V2-T7.4 决定**保留现有公共契约**，不引入额外公共状态。取消令牌 + session_id/query_id 双守卫已覆盖串线与并发场景，自动化门禁全绿；新增公共状态会扩大 IPC 契约面而无实际用户反馈依据。若真实 dogfooding 出现取消状态误报则触发重审。

### 文档（已完成）

- ✅ `README_EN.md`（英文版 README）
- ✅ `CONTRIBUTING.md`（贡献指南）
- ✅ `docs/ARCHITECTURE.md` 补多 driver 与双时代加密格式章节

---

## v0.3+ — 后续开发版本

> 从 Navicat 日常替代能力清单中，先剔除 v0.2 已规划的 SQL 历史（FR-106）、CSV/Excel 导出（FR-107）、column 树（FR-112）和多查询 tab（FR-109）。以下只登记剩余能力，避免同一功能跨版本重复承诺。

### v0.3 — 查询与浏览效率（已发布，2026-08-22）

详细任务历史见 [progress.md](../memory-bank/progress.md)。

**发布事实**：v0.3 全部五项 FR 已于 2026-08-20 完成编码与自动化门禁（Week 1-6 + V3-T7.3 文档 + V3-T7.4 门禁）；`just check` 全绿，双 driver integration 20/20，本机 dmg + updater 签名产物构建成功。V3-T7.1 双 driver × 直连/1 跳/3 跳全功能真实回归已于 2026-08-21 用户实测通过；`v0.3.0-rc1` 同日发布（四平台 prerelease，无 `latest.json`）。V3-T7.2 RC 一周试用于 2026-08-22 关闭（0 数据丢失 / 0 凭据泄露 / 0 不可恢复 crash，无阻塞 P0/P1）。`v0.3.0` 已于 2026-08-22 正式发布（发布提交 `0825da5`，Release run `32546492367` 四平台成功，非草稿非预发布，含四平台资产与 `latest.json`）。

| ID | 功能 | 优先级 | 状态 | 范围边界 |
|---|---|---|---|---|
| FR-240 | 保存 / 打开 SQL 文件与最近文件 | P1 | ✅ 已完成（Week 6） | SQL 历史仍由 v0.2 FR-106 负责 |
| FR-241 | index / constraint 元数据树与数据库对象搜索 | P1 | ✅ 已完成（Week 4） | column 树仍由 v0.2 FR-112 负责 |
| FR-242 | 表数据服务端筛选、排序和分页 | P0 | ✅ 已完成（Week 3） | 避免先拉全表再在前端处理 |
| FR-243 | 多结果 tab 与 SQL 格式化 | P1 | ✅ 已完成（Week 5） | 多查询 tab 仍由 v0.2 FR-109 负责；同一次执行可保留多个结果 |
| FR-244 | 连接绑定的独占 session 与可靠事务 | P0 | ✅ 已完成（Week 1-2） | `BEGIN / COMMIT / ROLLBACK` 必须固定在同一 MySQL connection；是 v0.4 安全编辑的前置能力 |

### v0.4 — 安全数据维护与对象管理（编码与自动化门禁完成，rc1 试用中）

详细任务历史见 [progress.md v0.4 归档](../memory-bank/progress.md#v04-已交付周计划归档)；收口见 [PLAN](./PLAN.md)。

**当前进度**：Week 1-7 全部三项 FR + V4-T8.3 文档 + V4-T8.4 门禁已于 2026-08-22 完成，V4-CP0~CP4 全部收口；`just check` 全绿（双 driver integration 33/33），本机 dmg + updater 签名产物构建成功。`v0.4.0-rc1` 同日发布（发布提交 `dbae167`，Release run `32554496338` 四平台成功，prerelease，无 `latest.json`）。剩余仅为 V4-T8.1 GUI 真实回归、V4-T8.2 一周试用与正式发布（V4-CP5，均需用户参与）。

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-250 | 仅带主键单表的安全表格编辑 | P0 | 支持新增 / 修改 / 删除、dirty state、提交 / 放弃；不允许 JOIN / 聚合结果直接写回 |
| FR-251 | 结构查看、DDL 预览与新建表 | P1 | v0.4 交付结构查看（列 / 索引 / 约束）、建表 DDL 预览（MySQL `SHOW CREATE TABLE`、PG 元数据重建）与新建表表单；View 结构与修改表 / 索引设计器改走 v0.5 FR-253 |
| FR-252 | CSV 导入与 SQL dump 导入 / 导出 | P1 | CSV/Excel 结果导出仍由 v0.2 FR-107 负责；本项补导入和完整 SQL 文件工作流 |

### v0.5 — 结构变更、官方备份与连接协作（编码完成，待验收）

详细任务历史见 [progress.md v0.5 归档](../memory-bank/progress.md#v05-已交付周计划归档)；收口见 [PLAN](./PLAN.md)。

**当前进度**：2026-08-24 三项 FR 编码与 `just check` 完成；待 V5-T8.1 / T8.2。

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-253 | 修改表、索引 / 约束设计器与 View 结构 | P0 | 补完 FR-251 顺延项；列级 ALTER + 索引增删必须先预览 SQL；不承诺换主键 / RENAME COLUMN 向导 |
| FR-260 | 官方工具备份与恢复 | P1 | 编排 `mysqldump` / `mysql`（PG 争取同版本）；经现有隧道本地端口；不发明备份格式；与 FR-252 dump 入口分离 |
| FR-221 | 加密分享连接配置 | P1 | 独立口令信封；不导出 master.key；默认不打包私钥文件；导入新 id 且不带 known_hosts |

### v0.6 — 结构对比、可审阅同步与关系图（编码完成，待验收）

详细任务历史见 [progress.md v0.6 归档](../memory-bank/progress.md#v06-已交付周计划归档)；收口见 [PLAN](./PLAN.md)。

**当前进度**：2026-08-24 三项 FR 编码与单测完成；待 V6-T8.1 / T8.2。

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-220 | 双连接结构 diff | P0 | 两条已打开连接的库/表/列/索引/约束；跨 driver 只展示不生成脚本 |
| FR-261 | 结构同步脚本 | P1 | 由 diff 生成可审阅 SQL，确认后才执行；v0.6 不做数据拷贝 |
| FR-263 | 只读 ER | P1 | 现有 FK 元数据构图；不做正向工程 |

### v0.7+ — 数据同步、权限与高级工作台

| ID | 功能 | 优先级 | 范围边界 |
|---|---|---|---|
| FR-261b | 数据传输与行级同步 | P1 | 从 FR-261 拆出；默认不自动执行破坏性变更 |
| FR-262 | MySQL 用户、角色与权限管理 | P1 | 只管理数据库权限，不引入 tiny-sql 服务端账号或应用 RBAC |
| FR-264 | BI 图表与仪表板 | P2 | 面向查询结果的本地可视化，不扩展成独立监控平台 |
| FR-265 | Schema-aware AI Assistant | P2 | 可配置模型供应商；发送 schema / SQL 前必须明确提示数据边界 |

以下工程与产品工作在 v0.3-v0.7+ 期间按反馈穿插，不与上面的 Navicat 日常替代主线抢 P0：

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
| FR-220 | 多集群 / 双连接结构 diff | P0 | 已列入 v0.6 |
| FR-221 | 加密分享连接配置（导出文件 + 同事密码导入） | P1 | 已列入 v0.5 |
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
- GitHub Discussions：开放讨论 / v0.4 反馈与 v0.5 优先级确认
- V2EX / 掘金 帖子下评论

24h 内首次回应是承诺。
