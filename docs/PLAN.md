---
title: tiny-sql 待办开发计划
version: 0.2.0-draft-2
status: draft
last_updated: 2026-08-19
---

# tiny-sql 待办开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> 本文件只保留尚未完成的工作。v0.1 已实现内容、历史检查点和架构决策见 [progress.md](../memory-bank/progress.md)。

当前稳定版为 `v0.1.0`，已于 2026-08-18 发布并验证全平台安装包、签名更新包、`latest.json` 及从 v0.0.3 到 v0.1.0 的应用内更新闭环。PostgreSQL 版本基线已固化，v0.2 Week 1-3 与 Week 4-7 的自动化开发门禁均已完成；剩余真实环境验收：V2-T3.4（PostgreSQL Tauri 直连/切换/取消/1 跳 SSH）、V2-T4.3（真实 TLS）、Week 8 dogfooding 与发布。

## v0.2 开发计划

**周期与预算**：8 周，约 96-100h（当前拆分约 98h）。

**目标**：把单一 MySQL 实现演进为稳定的多 driver 架构，并交付 PostgreSQL、凭据安全、TLS 验收、schema intelligence、查询工作台和 SSH 可观测性增强。完整范围以 [ROADMAP v0.2](./ROADMAP.md#v02--首发后-2-3-个月) 为准。

必须交付全部 P0/P1。FR-107 / FR-108 / FR-109 / FR-111 等 P2 若超过预算，可整体推到 v0.2.1，不得挤压 PostgreSQL、凭据安全、TLS、schema-aware、RTT、重连、column 树和 SQL 历史。

明确不进入 v0.2：安全表格编辑、对象设计、CSV 导入、SQL dump、备份同步、用户权限和 ER/BI/AI；这些分别留在 v0.3-v0.5+。

### 时间线与依赖顺序

```text
Week 1  12h  Driver 契约 + 连接模型迁移 + PostgreSQL vertical slice
Week 2  13h  PostgreSQL metadata/query/cancel 后端闭环
Week 3  12h  多 driver AppState/commands/UI + MySQL 回归
Week 4  13h  passphrase 加密存储 + MySQL TLS 真实验收与证书 UX
Week 5  13h  column 树 + schema cache + schema-aware 智能联想
Week 6  13h  SQL 历史 + 多 tab + 导出 + 结果表格体验
Week 7  10h  RTT + 重连 + keepalive 配置 + 状态模型决策
Week 8  12h  双 driver dogfooding + 文档 + RC / 正式发布

合计约 98h；P0/P1 目标 6-7 周完成，第 8 周用于稳定性与发布。
```

关键依赖链：

1. `Driver` 契约 → PostgreSQL 实现 → 多 driver AppState / UI → 双 driver 回归。
2. 统一 metadata 模型 → column 树 / cache → schema-aware 补全。
3. 每 tab 独立 session state → 独立 query_id / cancel → 多 tab 与历史恢复。
4. 用户主密码与存储迁移 → passphrase 持久化；迁移失败不得覆盖原文件。
5. RTT 探测语义与连接状态机决策 → 重连按钮和拓扑动画。

### Week 1：Driver 契约与 PostgreSQL vertical slice（12h）

- [x] **V2-T1.1 [4h]** 从现有 `MySqlDriver` 调用面提取最小、对象安全的 `Driver` 契约；覆盖 ping、metadata、query、基于 `CancellationToken` 的 cancel、close，连接创建仍由具体 driver/factory 负责，未提前抽象 v0.3 对象编辑能力。MySQL 生产调用面已通过该契约接线，workspace 编译与 `db-driver` 单测通过。
- [x] **V2-T1.2 [3h]** 连接配置已增加显式 `driver` 类型，稳定值为 `mysql` / `postgresql`；旧记录缺字段时只在内存中默认迁移为 MySQL，不在启动读取时重写密文，后续显式保存才落成新格式。未知 driver 迁移失败会保留原加密文件，Rust 加密存储测试与前端类型检查通过。
- [x] **V2-T1.3 [3h]** PostgreSQL 最窄链路已通过真实数据库验证：`PostgresDriver` 支持显式直连、`SELECT 1::BIGINT`、关闭主/control pool 与稳定 `error.driver.connect_failed`；显式连接不读取 `~/.pgpass`，SSH 仍由上层复用通用 TCP 隧道。
- [x] **V2-T1.4 [2h]** MySQL 18 个单测与 5 个真实 integration 全绿，覆盖连接、metadata、NULL/数值解码以及 `SELECT SLEEP(10)` 取消；SQL guard / LIMIT 单测和独立 control pool 取消行为均无回归。

完成条件：MySQL 现有测试全绿；PostgreSQL `SELECT 1` 通过；旧 `connections.enc` 无损读取。技术主链与三项 v0.1 代码承诺缺口均已关闭，**V2-CP1** 已通过；真实 Tauri 双 driver 验收仍由 V2-T3.4 / CP2 管理。

### Week 2：PostgreSQL 后端闭环（13h）

- [x] **V2-T2.1 [5h]** 公共 metadata 模型已增加显式 `MetadataScope { database, schema }` 与 `SchemaMeta`；PostgreSQL 分别查询 database/schema/table/column，并拒绝在同一连接上静默跨 database。MySQL 继续把 schema 映射为同名 database，生产调用行为不变。
- [x] **V2-T2.2 [4h]** PostgreSQL 已实现 query、NULL/日期/数值/JSON/BYTEA 解码、方言感知行数上限、写确认、DML `RETURNING` 与独立 control pool `pg_cancel_backend` 取消；dollar-quoted body、数据修改 CTE、`TABLE`/`VALUES`、`OFFSET` 均有 guard 单测。
- [x] **V2-T2.3 [2h]** `TINY_SQL_TEST_POSTGRES_URL` 真实 integration 已覆盖 ping、四层 metadata、SELECT/解码/截断/写确认、长查询取消及取消后 pool 恢复；4 项全绿，不起 Docker。MySQL 5 项 integration 同步扩展到同等级基本类型与写确认契约。
- [x] **V2-T2.4 [2h]** MySQL/PostgreSQL 共用稳定 i18n key；`DriverError` 的 `Display` 只输出 key，原始 sqlx 错误保留在后端结构化字段，不经 Tauri IPC 暴露。新增 database 切换/schema 缺失 key，前端连接失败文案已泛化为多 driver。

完成条件：两个 driver 均通过 ping、metadata、SELECT、写确认、取消及 NULL/日期/数值/JSON 基本解码。当前真实门禁为 MySQL 5/5、PostgreSQL 4/4 全绿；PostgreSQL 15/18 双端点版本矩阵仍留正式版兼容回归。

### Week 3：多 driver 应用接线（12h）

- [x] **V2-T3.1 [4h]** `AppState` 活跃连接注册表已改为 `ActiveDriver::{MySql, PostgreSql}` 多 driver 容器并实现统一 `Driver` 转发；`OpenConnection` 继续按 driver → tunnel 字段顺序绑定和关闭生命周期。
- [x] **V2-T3.2 [3h]** connection test/open/close 与 metadata/query commands 已按 driver 泛化，原 command 名和错误 key 保持稳定；新增 `db_list_schemas` 与可选 schema 入参，MySQL 专属 CREATE DATABASE 对 PostgreSQL 返回明确不支持。
- [x] **V2-T3.3 [3h]** 连接表单已增加 MySQL/PostgreSQL 选择，切换时带出 3306/root 或 5432/postgres 默认值；连接列表标识 driver，PostgreSQL 树按 database → schema → table 展示并使用双引号生成预览 SQL。PostgreSQL 证书路径尚未接线，表单明确提示使用 driver 默认 TLS 策略。
- [ ] **V2-T3.4 [2h]** 双 driver 后端真实 integration 9/9、AppState/command/frontend 单测和 `just check` 已通过；Tauri 调试包已验证 MySQL 直连、元数据树与 `SELECT 1`，仍需验证 PostgreSQL 直连、双 driver 切换/取消不串线及各自 1 跳 SSH，3 跳 PostgreSQL 留到 Week 8。

完成条件：同一应用能保存并分别打开 MySQL/PostgreSQL；关闭、切换和取消不会串 driver；通过 **V2-CP2**。当前代码与自动门禁已满足，MySQL 直连已实测，剩余 PostgreSQL、切换/取消与 1 跳 SSH 验证未完成，因此 T3.4/CP2 保持未完成。

### Week 4：凭据安全与 TLS（13h）

- [x] **V2-T4.1 [5h]** 用户主密码方案已落地：Argon2id v19（19 MiB / t=2 / p=1）派生 32 字节数据 key，AES-256-GCM v2 自描述 envelope，`security.json` 存明文 KDF 参数 + verifier 区分密码错误与数据损坏；passphrase 经独立 `secrets.enc` secrets map 持久化。新增直接依赖 argon2 0.5 / zeroize =1.8.1（MSRV 与 license 审计通过），不自创密码算法。
- [x] **V2-T4.2 [3h]** v1→v2 迁移采用 `.bak` 备份 + 临时文件 + rename 原子替换，`security.json` 最后写入作为提交点；任一步失败用 `.bak` 回滚，崩溃中断后下次启动自动还原。前端提供启动解锁框、安全设置（启用/锁定/关闭）与忘记主密码重置路径；错误密码不触碰任何数据文件。
- [ ] **V2-T4.3 [3h]** 代码部分已完成：SSL 页 CA/客户端证书/私钥路径支持系统文件选择器，MySQL 连接失败按 SSL 模式细分出 `error.driver.tls_handshake_failed` / `error.driver.tls_verify_failed` 并配可操作文案。真实 TLS MySQL 的 Preferred / Required / Verify CA / Verify Identity 及双向证书正反例验收仍待 V2-T8.1 环境。
- [x] **V2-T4.4 [2h]** 明文扫描测试覆盖 connections.enc / secrets.enc / history.enc（host、密码、passphrase、SQL 字面量均不出现）；密钥材料 Debug 输出已脱敏，导出 IO 错误只回稳定 key、细节留在后端日志；迁移回滚与崩溃自动还原有专项测试。

完成条件：重启后可用主密码解锁 passphrase；错误主密码不破坏数据；真实 TLS 正反例通过；通过 **V2-CP3**。当前除真实 TLS 正反例（依赖 V2-T8.1 环境）外均已由代码与自动化测试覆盖。

### Week 5：Schema intelligence（13h）

- [x] **V2-T5.1 [3h]** 前端已接入 `db_list_columns`，MySQL/PostgreSQL 表节点均可按需展开列，并展示类型、nullable、key、default 与 comment；收起或切换命名空间后旧请求不会覆盖当前树（FR-112）。
- [x] **V2-T5.2 [3h]** 已增加按 connection/driver/database/schema/resource/table 完整分区的内存 LRU metadata cache（128 项、5 分钟 TTL）；schema/table/column 加载均接入 cache，提供手动刷新，并在重连、建库和成功 DDL 后按连接失效（FR-108）。
- [x] **V2-T5.3 [5h]** CodeMirror 已按连接选择 MySQL/PostgreSQL dialect；原生 schema source 使用当前命名空间已加载的列元数据补全 column 与 alias，自定义 source 按 `target_id → target.id`、反向关系或同名 key/id 列生成可直接应用的 JOIN + ON 片段（FR-104）。
- [x] **V2-T5.4 [2h]** metadata 请求使用单调 epoch，消除 database/schema/table 快速 A→B→A 时的 ABA 覆盖；回归覆盖三层乱序响应、双方言补全隔离、5000 项 cache 写入保持 128 项上限，以及 2000 表/16000 列 namespace 在 250ms 预算内构建。

完成条件：DDL/手动刷新后 cache 可失效；大 schema 不阻塞 UI；两个 driver 的补全结果不串库。当前 65 项前端测试、TypeScript 与 Next.js 生产构建已覆盖并通过，Week 5 完成。

### Week 6：查询工作台（13h）

- [x] **V2-T6.1 [3h]** `history.enc` 记录最近 100 条 SQL 历史（driver/connection/database/schema/时间/成功状态），与连接配置共用 v1/v2 加密器；`db_query` 结束自动记录，超长 SQL 截断 4000 字符；前端历史面板支持回填与确认清空（FR-106）。
- [x] **V2-T6.2 [4h]** 查询工作台已改为多 tab：每 tab 独立 SQL、结果集、query_id、取消状态与 dirty 标记；双击表预览新开 tab，关闭 dirty/执行中 tab 先确认，重连与建库保留各 tab SQL 只复位执行态（FR-109）。
- [x] **V2-T6.3 [3h]** 新增 `db_export_query`：后端重新执行只读 SQL 并流式写文件，结果不经过前端序列化；CSV 带 BOM、SQL NULL 写作无引号 `NULL`、空串与字面 "NULL" 文本强制加引号区分；Excel 用 rust_xlsxwriter constant memory 模式，NULL 为空白单元格（FR-107）。
- [x] **V2-T6.4 [2h]** 表头右缘拖拽手柄实时调宽（64-640px clamp），松手按连接 + 列签名持久化到 localStorage；自定义后可一键恢复默认（FR-111）。
- [x] **V2-T6.5 [1h]** 前端并发回归：双 tab 同时执行互不污染、取消 A 不影响 B、关闭执行中 tab 先取消后端查询、旧 query_id 迟到结果不写回；后端连接关闭/重连按 connection_id 收敛取消的已有测试保持通过。

完成条件：历史加密且可清除；至少 3 个 tab 并发互不污染；大结果导出内存稳定；通过 **V2-CP4**。自动化门禁已全部覆盖，CP4 随 Week 8 真实 dogfooding 最终确认。

### Week 7：SSH 可观测性与连接恢复（10h）

- [x] **V2-T7.1 [3h]** 使用 SSH global-request 测量累计到每跳 session 的协议 RTT，10s 低频采样、2s 超时；session actor 在等待 ping 时优先处理 direct-tcpip，采样不进入连接关键路径，超时不改变连接状态。拓扑明确标注“SSH”且 tooltip 说明非 ICMP/非单段延迟（FR-105）。
- [x] **V2-T7.2 [3h]** 已在顶部、断链提示和连接右键菜单增加手动重连；后端按 connection_id 串行 open/close/reconnect，重连前取消该连接查询并按顺序关闭旧 pool/tunnel，每次打开生成 session_id 过滤旧事件，query_id 守卫拒绝旧结果回写（FR-110）。
- [x] **V2-T7.3 [2h]** 将 keepalive 间隔和失败阈值接入高级配置，默认保持 60s / 3 次；旧记录缺少阈值时补 3，关闭配置不发送心跳，监控 task 改用只读 session 状态避免干扰设置间隔。
- [x] **V2-T7.4 [2h]** 决策：保留现有公共契约，不新增 KILL QUERY 四状态或统一状态机。依据：取消令牌 + query_id/session_id 双守卫已覆盖取消、重连与并发串线场景，自动化门禁无反例；新增公共状态会增加 IPC 契约面而没有对应用户反馈。触发重审的条件：真实 dogfooding 出现取消状态误报或连接状态混淆反馈。

完成条件：断开中间跳后能看到 lost 并成功重连；RTT 不阻塞连接主链路；配置重启后生效；无旧 task / event 泄漏。

### Week 8：Dogfooding 与发布（12h）

- [ ] **V2-T8.1 [4h]** MySQL/PostgreSQL 分别完成直连、1 跳和真实 3 跳回归，覆盖 metadata、查询、取消、历史、tab、导出、TLS 与重连。
- [ ] **V2-T8.2 [3h]** 作者和至少 2 位试用者使用 v0.2 RC ≥ 1 周；至少 1 人以 PostgreSQL 为主，要求 0 数据丢失、0 凭据泄露、0 不可恢复 crash。
- [x] **V2-T8.3 [3h]** ARCHITECTURE 已更新 v1/v2 双时代加密格式、迁移回滚、secrets/history 存储与目录结构；新增 `README_EN.md` 与 `CONTRIBUTING.md`；`docs/RELEASE_CHECKLIST.md` 增加 v0.2 段（双 driver dogfooding、主密码路径、安全矩阵）。
- [ ] **V2-T8.4 [2h]** 已通过：`just check` 全绿、双 driver integration 9/9、本机 Tauri 调试包与 dmg/updater 产物构建成功。仍待：RC tag 触发全平台构建与下载验收、P0/P1 清零后发布 v0.2.0。

完成条件：通过 **V2-CP5**；未完成 P2 明确移入 v0.2.1，不在 Release notes 中承诺。

### 检查点与降级规则

| 检查点 | 时机 | 通过标准 | 不通过的应对 |
|---|---|---|---|
| **V2-CP0** 启动准入 | 开工前 | v0.1.0 无紧急回滚问题；应用内更新实测与 PostgreSQL 版本基线完成 | 先修紧急回滚问题，不进入 v0.2 Week 1 |
| **V2-CP1** Driver 抽象 | Week 1 末 | MySQL 零回归 + PostgreSQL SELECT 1 + 配置迁移通过；并行代码承诺缺口已处理或收窄 | 收窄 trait，不继续铺 PostgreSQL 全功能 |
| **V2-CP2** 双 driver 闭环 | Week 3 末 | 两个 driver 的 connect/metadata/query/cancel/UI 可用 | 延后 Week 4，先修状态与 dialect 边界 |
| **V2-CP3** 安全迁移 | Week 4 末 | 旧配置无损、错误密码不破坏文件、真实 TLS 通过 | 停止发布；保留会话 passphrase，不强推持久化 |
| **V2-CP4** 查询工作台 | Week 6 末 | history/tab/export 隔离正确，无明显内存回归 | P2 整体推 v0.2.1，保留 P1 SQL 历史 |
| **V2-CP5** 发布 | Week 8 末 | 双 driver dogfooding + P0/P1 清零 + RC 安装通过 | 延后正式版，不降低凭据与数据安全标准 |

超时时按以下顺序降级：FR-111 列宽 → FR-108 LRU cache → FR-107 Excel（保 CSV）→ FR-109 多 tab。FR-100/102/103/104/105/106/110/112 不降级；未完成则版本延期。

### 测试矩阵

- [x] **静态质量**：每组改动至少跑 `just lint`；合并前跑 `just check`。本轮全量 `just check` 通过（含新增 security/history/export 后端 20 项与前端 16 项测试）。
- [x] **driver integration**：使用 `TINY_SQL_TEST_MYSQL_URL` 与 `TINY_SQL_TEST_POSTGRES_URL` 连接本地实例，不引入 Docker；CI 只跑无外部数据库的单元测试。本轮 MySQL 5/5、PostgreSQL 4/4 全绿。
- [ ] **兼容回归**：覆盖 MySQL 5.7 / 8.x 与 PostgreSQL 最低支持版本 / 最新稳定版本。PostgreSQL 15.latest / 18.latest 双端点留 RC 前执行。
- [ ] **隧道矩阵**：覆盖 MySQL/PostgreSQL × 0/1/3 跳，以及密码、无口令私钥、带口令私钥认证。留 V2-T3.4 / T8.1 真实环境验收。
- [x] **安全矩阵**：自动化已覆盖旧加密文件迁移、错误主密码、篡改 KDF 参数、迁移中断 `.bak` 还原、历史/passphrase/连接配置明文扫描；TLS CA/hostname/客户端证书正反例留 V2-T4.3 真实环境。
- [x] **并发矩阵**：自动化已覆盖多 tab 同时查询、分别取消、连接关闭、重连、cache 切换（前端 6 项新回归 + 既有 session/ABA 用例）；大结果导出内存稳定由 constant memory 流式实现保证，真实大数据量验证留 Week 8 dogfooding。

### 主要风险

| 风险 ID | 描述 | 影响 | 缓解 |
|---|---|---|---|
| V2-R01 | 为 PostgreSQL 过度抽象 Driver，破坏 MySQL | 高 | 只从现有调用面提取；Week 1 设置零回归门槛 |
| V2-R02 | MySQL database 与 PostgreSQL schema 语义混淆 | 高 | 公共模型显式表达层级；driver 负责 dialect 和引用规则 |
| V2-R03 | 主密码迁移失败导致连接配置不可恢复 | 极高 | 临时文件 + 原子替换 + 原文件备份；失败不覆盖 |
| V2-R04 | SQL 历史或导出泄露敏感字面量 | 高 | 历史加密、显式清空、用户选择导出路径、日志不记录 SQL 全文 |
| V2-R05 | 多 tab 的 query_id / cancel token 串线 | 高 | tab-local state + 并发单测；关闭连接统一收敛终态 |
| V2-R06 | RTT 数字被误解为 ICMP 网络延迟 | 中 | 文案标注 SSH 探测 RTT；采样失败不改变连接状态 |
| V2-R07 | 8 周范围再次膨胀 | 中 | Week 6 按降级顺序推迟 P2；禁止提前做 v0.3 数据编辑 |
