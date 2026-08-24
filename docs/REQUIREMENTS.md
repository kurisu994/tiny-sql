---
title: tiny-sql 需求文档
version: 0.8.0
status: awaiting-acceptance
last_updated: 2026-08-24
---

# tiny-sql 需求文档

> 配套文档：[PLAN.md](./PLAN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)

> **实现快照（2026-08-24）**：稳定 Release 与应用版本号均为 `v0.7.0`。main 另含 v0.8 功能编码（仍 54 个 command，未切 `v0.8.0`）。v0.8 范围见 §3.8。

## 1. 项目愿景

tiny-sql 是一款**多级跳板机友好的 MySQL 桌面客户端**。

主流 SQL 客户端（DBeaver、TablePlus、Navicat、DataGrip、Sequel Ace、Beekeeper Studio）把 SSH 隧道当作"雾中一根管子"——单跳、黑盒、出错无法定位哪一跳挂了。DBeaver 名义上支持 OpenSSH ProxyJump 多跳，但 UI 完全不暴露这层逻辑，调试体验等同于裸 `ssh -L`。

tiny-sql 把跳板机从"雾中一根管子"变成**可观测的路由器**：每一跳都是 UI 上的一等公民节点，有独立的连接状态和错误归因。v0.1 给出"本地 → 跳板 1 → 跳板 2 → 跳板 3 → MySQL"的拓扑图视图；隧道任意一跳挂掉时高亮断点节点，180s 内向 UI 推送 lost 状态。v0.2 增加每跳 SSH 协议 RTT 与超时显示。

这是即使 DBeaver 下个版本想追也追不上的理念差距：不是 feature 差距，是把 SSH 从"网络层"提升到"数据模型层"的差距。

---

## 2. 用户与场景

tiny-sql 同时服务三类用户。三类用户的功能需求高度重叠，区别在于"用什么频率"和"看重哪个体验细节"。

### 2.1 用户画像 A：作者自用

**身份**：作者本人，每天都要连公司生产 MySQL 的工程师。

**关键痛点**：
- 公司生产环境是 4 层堡垒：办公网堡垒 → 业务 VPC 堡垒 → DB 跳板 → MySQL；每天 30+ 次连接，手动 `ssh -L` 拼链路心智成本高。
- 用 DBeaver 时如果链路第 2 跳因为对端 sshd 重启导致挂掉，DBeaver 只会告诉"connection refused"，无法定位是第几跳。

**典型场景**：

- **场景 A1：高频日常查询**。开机后 30s 内打开 tiny-sql，连接列表第一个就是"生产读库 RO"，双击连接，3 跳隧道自动建立，左侧列出所有 schema，点 `orders` schema 点 `t_order` 表，看前 1000 行核对昨天的促销数据。整个流程预期 15s 内完成。
- **场景 A2：故障排查**。线上告警，需要立刻连库 SELECT 状态。点开"生产读库 RO"连接，第 2 跳堡垒机因为业务方网络抖动连不上，UI 上 hop[1] 节点变红，tooltip 提示"connection timeout"。立刻判定是堡垒机的问题，不浪费时间排查本地网络或 MySQL。
- **场景 A3：执行修复 SQL**。需要 `UPDATE t_order SET status = ... WHERE id IN (...)` 一行修数据。粘贴 SQL 进编辑器，点执行，弹出写操作确认对话框，用户点击「确认执行」后提交。执行成功显示影响行数。

### 2.2 用户画像 B：同事推广

**身份**：与作者同公司、同样面对多级堡垒的工程师，运维、后端、数据。

**关键痛点**：
- 不愿配 OpenSSH ProxyJump（觉得是高阶技巧）；用 Navicat 但只能配单跳，于是日常先开 iTerm `ssh -L` 拼链路、再让 Navicat 连 `127.0.0.1:13306`，工具链断裂。
- 没有 $99 Apple Developer 账号也能用（v0.1 无 Apple Developer 代码签名，README 教"右键打开"）。

**典型场景**：

- **场景 B1：上手 5 分钟**。从作者群消息拿到 .dmg 链接，下载、右键打开、配第一个连接：填 3 跳 SSH + MySQL 信息，TOFU 弹窗确认指纹，连接成功。整个流程预期 5 分钟内，不需要看文档。
- **场景 B2：连接配置分享**。v0.1–v0.4 不支持分享或导入连接配置：`connections.enc` 依赖同机 `master.key`，不能把加密文件单独发给同事使用。同事 C 需要手动新建自己的连接；带独立导出密码的加密导出/导入安排在 v0.5（FR-221）。
- **场景 B3：替代 Navicat**。同事 B 用 1 周后反馈：日常浏览数据、查 schema、跑 SELECT 完全够用，唯一缺失的是"导出 CSV"和"SQL 历史"（这些是 v0.2 范围）。

### 2.3 用户画像 C：开源社区用户

**身份**：V2EX/掘金/GitHub 上看到 tiny-sql 的中文开发者，环境可能是中小公司或个人项目。

**关键痛点**：
- 不一定有 4 层堡垒，但 1-2 跳很常见（个人 VPS 上的 MySQL 通过 1 跳 SSH 访问）。
- 多语言但首发只需 zh-CN；后端错误继续返回稳定 i18n key，前端 v0.1 用静态中文映射，完整 i18n runtime 留后续版本接入。
- 期待 GitHub 上的 issue 和 PR 得到回应。

**典型场景**：

- **场景 C1：单跳够用**。配 1 跳 SSH 连 VPS 上的 MySQL，体验和 Sequel Ace 单跳模式接近，无新功能优势。tiny-sql 不需要在这个场景上赢，但不能输得太难看（连接体感不能比 Sequel Ace 慢 3 倍）。
- **场景 C2：v0.2 反馈**。在 issue 区提"希望加 PostgreSQL 支持"或"希望加 SQL 历史"。作者拒绝/接受/排期，但 24h 内必须回应。
- **场景 C3：贡献 PR**。社区贡献者发 PR 加 SQL 历史功能，作者 review。要求代码结构清晰（这是选 Approach B 的核心动机：仓库诞生即干净）。

---

## 3. 功能需求清单

需求按发布版本分组。每条需求带唯一 ID（FR-xxx）、优先级（P0 必做 / P1 应做 / P2 可做）、验收标准。

### 3.1 v0.1 范围（5-6 周 / 60-75 小时）

#### 3.1.1 连接管理

**FR-001 [P0] 连接配置 CRUD**

- 用户能创建、编辑、删除、列出 MySQL 连接配置。
- 单条配置含：name / host / port / user / password / database（可选默认） / ssh（可选多跳）/ ssl / advanced。
- 配置以 AES-GCM 加密落盘到 `~/Library/Application Support/tiny-sql/connections.enc`。
- **验收标准**：
  - 新建一个 3 跳 + MySQL 配置，重启应用后配置仍在列表中。
  - 删除一个配置，重启应用后配置不在列表中。
  - 用 `cat connections.enc` 直接看文件，不能看到明文 host/user/password。

**FR-002 [P0] 连接测试**

- 创建/编辑对话框上有"测试连接"按钮，点击立刻尝试建立完整链路（SSH 隧道 + MySQL 握手 + `SELECT 1`），成功显示绿色对勾，失败显示具体错误（i18n key 翻译后的中文）。
- 带口令私钥时，SSH 页提供“私钥 passphrase（仅测试）”输入；`connection_test` 只把它用于本次握手，不写入连接配置，也不进入正式连接的会话缓存。
- **验收标准**：
  - 配置正确 → 5s 内显示成功。
  - SSH 第 2 跳故意填错端口 → 30s 内显示"第 2 跳连接失败"。
  - MySQL 密码错 → 显示"MySQL 认证失败"，不能误报 SSH 错误。

**FR-003 [P1] 连接历史与最近使用**

- 连接列表按"最近使用时间"排序，最近用的连接在最上面。
- **验收标准**：双击连接 A 后再回到列表，A 在最上面。

#### 3.1.2 SSH 多跳隧道

**FR-010 [P0] 配置 N 跳 SSH 隧道**

- UI 上"SSH 跳板"区块是动态数组，用户可以"+"添加 hop、删除 hop，并用上移 / 下移按钮调整顺序。
- 单条持久化 hop 含：host / port（默认 22） / username / auth_type（password / privateKey） / password? / private_key_path?；passphrase 不属于 hop 配置。正式打开由 `connection_open` 参数传入并按 connection_id 缓存在本会话内存，测试连接则作为瞬时参数使用后丢弃。
- v0.1 测试到 3 跳；理论上无硬上限（性能限制留待 v0.2 评估）。
- **验收标准**：
  - 配置 1 跳能连。
  - 配置 3 跳能连。
  - 调整 hop 顺序后连接路径按新顺序走。

**FR-011 [P0] 私钥 passphrase 处理**

- 私钥带 passphrase 时，首次连接弹窗让用户输入；输入后**仅本会话内存缓存**，进程退出即丢。
- 创建/编辑表单测试连接时可输入一次性 passphrase；该值不复用正式连接缓存，也不落盘。
- v0.1 **不持久化** passphrase；v0.2 才加加密 passphrase 存储。
- **验收标准**：
  - passphrase 错误 → 显示"私钥 passphrase 错误"。
  - 同一会话内第二次连同一配置 → 不再弹窗。
  - 退出应用重新打开 → 重新弹窗。

**FR-012 [P0] TOFU 流程**

- 首次连接未知 host 时，弹窗显示 host / port / 公钥指纹（SHA256），让用户选"信任并继续" / "拒绝"。
- 用户信任后，指纹写入 `~/Library/Application Support/tiny-sql/known_hosts.json`（自有 store，**不污染** `~/.ssh/known_hosts`）。
- TOFU 弹窗 120s 无响应自动按拒绝处理，避免连接流程永久挂起。
- **验收标准**：
  - 首次连新 host → 弹窗，显示正确的指纹。
  - 用户选"信任" → 第二次连同一 host 静默通过。
  - 已信任 host 的指纹**被改了**（手动改 known_hosts.json 模拟）→ 硬拒绝，UI 显示"主机公钥变更，可能遭遇中间人攻击"。
  - 弹窗不响应 120s → 自动按拒绝处理，连接流程退出。

**FR-013 [P0] 隧道断点定位**

- 任意一跳建立失败时，UI 必须高亮**断点的那一跳**的拓扑节点（红边 + tooltip 显示 i18n 错误消息）。
- 错误归因机制：与具体跳相关的 `SshTunnelError` 变体带 `hop_index: usize`；`NoHops` / `LocalListenFailed` 这类无单跳语义的错误返回 `None`。Tauri command 读取 `hop_index()` 后单独 emit `ssh:hop-status`，命令错误只返回稳定 i18n key。
- **验收标准**：
  - 第 2 跳 host 填错 → hop[1] 节点红，hop[0] 绿。
  - 第 3 跳认证失败 → hop[2] 节点红。
  - 错误消息是中文（i18n 翻译后），不是英文 `connect_failed` 字面量。

**FR-014 [P0] SSH keepalive 与隧道断开感知**

- 隧道建立后给每一跳 russh session 配置 keepalive；高级设置可控制启用状态、间隔和连续失败阈值，新建连接默认 `keepalive_interval=60s`、`keepalive_max=2`，即第 3 次未响应时结束 session。每跳另有轻量只读监控 task 探测 session 是否已退出。
- 默认 **连续 3 次未响应（≈180s）才判定断开**——避免弱网抖动 / 企业 bastion ratelimit 误报。监控 task 发现 session 已退出时 emit `ssh:hop-status` event，payload 含 `connectionId / sessionId / hopIndex / status: "lost" / reason`；前端仅接收当前 session 的事件并把对应拓扑节点变红。
- `SshTunnelError` 新增三个 mid-session 变体（各有独立 i18n key）：`TunnelLost { hop_index, reason }`（keepalive 超时）/ `ChannelDropped { hop_index }`（对端主动关 channel，可能跳板重启）/ `AcceptLoopDied { hop_index }`（accept loop panic，代码 bug 需上报）。
- **当前实现状态**：首跳 session 断开上报 `TunnelLost`，嵌套跳 transport channel 断开上报 `ChannelDropped`，本地 accept worker panic / 意外退出上报 `AcceptLoopDied`；正常关闭通过 shutdown 标记抑制误报，同一跳断链只上报一次。
- keepalive 间隔与失败阈值已在 v0.2 接入高级配置；旧记录缺少阈值时按 3 次兼容读取，关闭 keepalive 后不再发送心跳。
- **验收标准**：
  - 隧道连接稳定时 → 不 emit lost 事件。
  - 手动 kill 第 2 跳 sshd → **180s 内** UI hop[1] 变红，弹 toast 提示"第 2 跳断开"。
  - 隧道断开后用户能重新连上：**v0.1 UI 无独立"重连"按钮**，需先点"断开"再重新打开连接回到 pending → connected 流程（已知缺口，推 v0.2）。
  - **v0.2** 已提供显式「重连」，恢复前清理旧查询、pool 和 tunnel，并用 session_id 隔离旧事件。
- **设计意图**：这是"把跳板机从雾中一根管子变成可观测路由器"叙事的核心，不是可选项。

**FR-015 [P0] 拓扑图视图**

- 连接面板顶部用纯 CSS 线性拓扑展示：节点 = 本地 / hop[0] / hop[1] / ... / hop[N-1] / MySQL；边 = TCP 通道。
- 节点状态：`pending`（灰色）/ `connected`（绿色）/ `failed`（红色）/ `lost`（红色）。
- 状态通过 tauri event `ssh:hop-status` 推送，payload schema 见 [ARCHITECTURE.md](./ARCHITECTURE.md#7-前后端事件契约)。
- v0.1 节点状态简化为 4 态（pending / connected / failed / lost），**不**做"实时延迟动画"（推 v0.2）。
- v0.2 通过独立 `ssh:hop-rtt` 事件显示 10s 低频采样；值是从本机累计到该 SSH session 的 global-request RTT，不是 ICMP，也不是可相减的单段链路延迟。2s 超时只更新指标，不把节点改成 failed/lost。
- **验收标准**：
  - 连接进行中 → 节点按顺序从 pending → connected。
  - 第 2 跳失败 → hop[1] 红，hop[2..] 保持 pending。
  - 拓扑图截图后能直接发 V2EX 帖子，无需后期编辑。

#### 3.1.3 MySQL 操作

**FR-020 [P0] 列出 database 与 table**

- 连接成功后，左侧树形导航列出所有 database（schema），点开 database 列出所有 table。
- v0.1 **小库假设**：≤30 schema，≤200 表/schema；不实现搜索、不实现分页。
- 数据来自 `information_schema` 直查，**不 cache**（大库 LRU cache 推 v0.2）。
- **验收标准**：
  - 连接成功后 2s 内左侧列出 database 列表。
  - 点开 database 后 2s 内列出 table 列表。

**FR-021 [P0] 浏览表前 1000 行**

- 点击 table 节点 → 右侧打开"数据"标签页，显示前 1000 行。
- **顶层安全追加 LIMIT 注入**（不是 regex 检测）：表浏览 `rowLimit=1000`，内部在语句末尾追加 `LIMIT 1001` 多取 1 行判断 truncated，返回前只保留 1000 行。用户手写 LIMIT 装在内部，取小意图一致。避免大表 OOM。实现说明：不做 derived table 包装（`SELECT * FROM (...) AS tiny_sql_limited` 会在多表 JOIN 重名列触发 1060 错误），改为**顶层（括号深度 0）无 `LIMIT / FOR / LOCK / INTO / PROCEDURE` 时直接换行追加** `LIMIT n+1`；顶层已含这些子句时保持原样，由客户端截断兜底。
- 用 `react-virtuoso` 虚拟滚动渲染；**列宽拖拽调整 v0.1 未实现**（列宽固定 `minmax(140px, 260px)`，推 v0.2）。
- **验收标准**：
  - 表 100 万行 → 服务端只回 1000 行，UI 流畅滚动。
  - 表 50 行 → 显示 50 行，不报"已截断"。

**FR-022 [P0] SQL 执行**

- 顶部 SQL 编辑器基于 CodeMirror 6，支持 MySQL 语法高亮、行号、基础 database/table 补全、本地结构错误提示和 `Cmd/Ctrl+Enter` 快捷执行。
- 结果以表格展示，复用 FR-021 的虚拟滚动组件。
- **客户端结果集硬上限 10w 行**：超出截断并显示提示"已截断到 10w 行，请加 LIMIT"。
- **验收标准**：
  - `SELECT * FROM t_order LIMIT 100` → 显示 100 行。
  - `SELECT * FROM huge_table`（500w 行表，无 LIMIT）→ 显示 10w 行 + 截断提示。
  - 语法错 → 显示稳定 i18n 文案「SQL 执行失败」；若 MySQL 返回 `line N`，后端只提取正整数行号并通过 `{ key, line }` 结构化载荷传递，原始 sqlx/MySQL 错误与 SQL 片段不进入 IPC。

**FR-023 [P0] SQL 取消**

- 执行按钮旁有"取消"按钮，执行中点取消能立刻中止 query（不等结果回来）。
- 后端用 `tokio::select!` + cancel token 中止客户端等待；执行前记录 MySQL `CONNECTION_ID()`，取消分支从独立 control pool（主 MySqlPool 之外、同一连接参数独立连接池）发 `KILL QUERY <connection_id>` 中止远端执行。独立 control pool 保证主 pool 满时 KILL 仍能发出，不留服务端"幽灵查询"。**注意：control pool 与主 pool 走同一隧道同一本地端口，只是独立连接池；v0.1 未用独立本地端口**（留后续按 dogfooding 反馈强化）。
- **验收标准**：
  - 跑 `SELECT SLEEP(60)` → 5s 后点取消 → 1s 内停止，UI 显示"已取消"。
  - 取消后 MySQL `SHOW PROCESSLIST` 中该 query 消失（服务端确实被 KILL）。

**FR-024 [P0] 只读保护（best-effort）**

- 用户输入的 SQL 在执行前按**首 token 白名单分类**（前后端同一套规则）：首 token ∈ `SELECT / WITH` 视为读，免确认；首 token ∈ `SHOW / DESC / DESCRIBE / EXPLAIN` 视为元数据语句，返回结果集、免确认（`EXPLAIN ANALYZE` 分析写语句时仍需确认，因为 ANALYZE 变体会真正执行被分析语句）；**其余语句一律视为写操作**，需 `allow_write=true` 才执行。
- 预处理：剥离 SQL 注释（`-- ...` / `# ...` / `/* ... */`）和字符串字面量（`'...'` / `"..."`）后再做首 token 判定，忽略字符串/注释内的伪命中。
- **明确语义：这是 best-effort 防护，不承诺数据库级只读。** `SELECT func_that_writes()` / `SELECT ... INTO OUTFILE` / 用户变量赋值 / 存储过程边界等绕过判定的写副作用无法拦截。真正只读请使用 MySQL 只读账号——README 与连接编辑页都提示这一点。首 token 白名单只是"低成本一道闸"，不是安全边界（比早期黑名单正则更保守：`SET` / `USE` / `CALL` 等也会弹确认）。
- **验收标准**：
  - `SELECT * FROM t` → 直接执行。
  - `UPDATE t SET x = 1 WHERE id = 1` → 弹对话框。
  - `SELECT 'UPDATE not really' FROM t` → 直接执行（识别字符串内的伪命中）。
  - `-- UPDATE 这是注释` → 直接执行。
  - `SHOW TABLES` / `DESC t` / `EXPLAIN SELECT...` → 直接执行并返回结果集。

**FR-025 [P0] MySQL 5.7 + 8.0 兼容**

- 必须同时支持 MySQL 5.7（默认 `mysql_native_password`）和 8.0（默认 `caching_sha2_password`）。
- 用 `sqlx 0.8` features=["mysql", "runtime-tokio-rustls", "chrono", "bigdecimal"] 实现（chrono / bigdecimal 用于结果集日期与 Decimal 解码）。连接默认 `ssl-mode=disabled`，但 v0.1 已允许用户显式选择 Preferred / Required / Verify CA / Verify Identity，并传入 CA、客户端证书与私钥路径；真实 TLS MySQL 环境尚未验收，留到 dogfooding / v0.2 打磨。
- **验收标准**（不用 Docker，连用户本地 MySQL）：
  - 用户本地 MySQL 8.0 经 `TINY_SQL_TEST_MYSQL_URL` integration test → 能连、能查（caching_sha2_password 握手通过）。
  - **MySQL 5.7 兼容继续不进 CI 矩阵**；已在 dogfooding 期间完成验证，后续正式版前保留人工回归。

**FR-026 [P1] 连接池策略**

- 1 个 tiny-sql 连接 = 1 个本地 listener 端口 = 1 个 `MySqlPool`（max_connections = 5）。
- 隧道断开（FR-014）触发 pool drop，UI 显示连接已断开。
- v0.1 **不做断线自动重连**——用户手动重连。**v0.1 UI 无"重连"按钮**：lost 后需先点"断开"再重新打开连接（已知缺口，推 v0.2）。
- v0.2 已增加用户触发的幂等「重连」按钮，不做后台自动重试：重连前按 connection_id 取消旧查询，关闭旧 pool/tunnel，再建立带新 session_id 的连接；旧查询结果和旧 SSH 事件不得写回新会话。
- **验收标准**：
  - 同时打开 5 个 tab 跑不同 SQL → 复用同一 pool，不报"too many connections"。
  - 隧道挂了 → SQL 报错 + UI 显示连接已断开；点击「重连」后恢复 pending → connected，且旧查询 / 事件不污染新会话。

**FR-027 [P1] MySQL SSL/TLS 连接配置**

- 新建 / 编辑连接的 SSL 标签页支持 Disabled / Preferred / Required / Verify CA / Verify Identity。
- CA、客户端证书、客户端私钥路径随连接加密保存；`connection_test` 与 `connection_open` 都把同一配置传给 `MySqlDriver::connect_with_settings`。
- 默认 Disabled，避免部分内网 MySQL 声明 SSL 能力但握手配置不完整时连接失败。
- **当前验收状态**：配置持久化、模式解析与 driver 接线已有代码/单测；真实 TLS 服务端与双向证书正反例、错误提示已于 v0.2 验收通过（V2-T4.3）。

#### 3.1.4 国际化与本地化

**FR-030 [P0] 中文（zh-CN）**

- v0.1 UI 全中文。
- 后端错误对外返回稳定 i18n key，前端 v0.1 用静态 `ERROR_ZH` map 翻译。
- 英文 UI 与 i18next / react-i18next runtime 留到 v0.2+。
- **验收标准**：
  - 切换语言下拉框只能选"中文"（en 选项灰色 + tooltip "v0.2"）。**v0.1 实际未实现语言下拉框**（UI 固定全中文，无 locale 状态；此验收项推 v0.2）。

#### 3.1.5 分发

**FR-040 [P0] 全平台桌面包发布**

- GitHub Actions 矩阵：macOS arm64 + x64、Windows x64、Linux x64。
- tag `v0.1.0` 触发自动 build + 上传 `.dmg` / `.exe` / `.AppImage` 到 GitHub Releases。
- v0.1 无 Apple Developer 代码签名 / notarization：README 顶部提供 macOS "右键打开 → 允许"文字说明；不要求额外录制 GIF。
- **验收标准**：
  - 全新 M 系列 Mac 下载 .dmg → 右键打开 → 应用启动 → 能连数据库。
  - Intel Mac 同上。
  - Windows x64 下载 `.exe` → 应用启动 → 能连数据库。
  - Linux x64 下载 `.AppImage` → 应用启动 → 能连数据库。

**FR-042 [P0] 正式版自动更新**

- 接入 `tauri-plugin-updater`，为 macOS / Windows / Linux 构建 updater artifact 与 `.sig` 更新包。
- tag `v0.1.0` 正式版发布时生成 GitHub Release `latest.json`；`v*-rc*` / beta / alpha 不生成 `latest.json`，不作为自动更新源。
- 应用启动后每日检查一次正式版更新，macOS 应用菜单支持手动检查。
- 发现更新后展示版本号、release notes、下载进度；安装完成后提示重启。
- **验收标准**：
  - 从旧正式版手动检查能发现新正式版。
  - RC 发布后旧正式版不会提示更新到 RC。
  - 修改更新包或签名不匹配时 updater 拒绝安装。

**FR-041 [P0] dogfooding 验证**

- 作者自己用 ≥ 1 周。
- ≥ 2 位同事在公司环境用 ≥ 1 周。
- **验收标准**：3 人 1 周内 0 数据丢失、0 不可恢复 crash。

---

### 3.2 v0.2 范围（首发后 2-3 个月）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md)。

- **FR-100** PostgreSQL driver（后端与 AppState/Tauri/UI 已接线，真实 driver integration 与 Tauri 直连/1 跳 SSH 应用验收均通过）
- **FR-102** 加密 passphrase 存储（v0.2 已实现用户主密码 Argon2id 派生 key + v2 envelope + secrets.enc；迁移可回滚）
- **FR-103** MySQL TLS 真实环境验收、证书选择与错误诊断 UX 打磨（模式/路径/证书选择器与 TLS 专项错误 key 已接线；真实 TLS 环境正反例已验收，V2-T4.3）
- **FR-104** Schema-aware 智能联想：按 MySQL/PostgreSQL 方言补全当前命名空间的 table、column 和 alias；已加载列满足 `target_id → target.id`、反向关系或同名 key/id 时，在输入 `JOIN` 后提供带 ON 条件的候选片段。
- **FR-105** 实时隧道延迟动画（v0.2 已实现累计 SSH 协议 RTT/超时显示；非 ICMP、非单段延迟）
- **FR-106** SQL 历史（v0.2 已实现：最近 100 条、含成功状态、加密落盘、可清空）
- **FR-107** 导出 CSV / Excel（v0.2 已实现：后端流式写文件，区分 SQL NULL 与空字符串）
- **FR-108** 大表 LRU schema cache：按 connection/driver/database/schema 分区，覆盖 schema/table/column metadata；提供手动刷新，重连、建库和成功 DDL 后必须失效，禁止跨连接或跨 driver 命中。
- **FR-109** 多 tab 同时执行（v0.2 已实现：每 tab 独立 SQL/结果/query_id/取消 token/dirty state）
- **FR-110** 隧道断开后的重连按钮（v0.2 已实现用户触发的幂等恢复；不含自动重试）
- **FR-111** 结果表格列宽拖拽调整（v0.2 已实现：拖拽 + localStorage 持久化 + 恢复默认）
- **FR-112** schema 树列清单展示

实施顺序与历史见 [progress.md](../memory-bank/progress.md)。

---

### 3.3 v0.3 范围（查询与浏览效率 + 可靠事务）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md) 与 [progress.md](../memory-bank/progress.md)。

- **FR-242** 表数据服务端筛选、排序和分页（P0）：WHERE 列白名单 + 操作符枚举 + 值全参数化，LIMIT/OFFSET 分页与总行数 COUNT，双方言各自标识符引用；禁止先拉全表再在前端处理。
- **FR-244** 连接绑定的独占 session 与可靠事务（P0）：`BEGIN` / `COMMIT` / `ROLLBACK` 固定同一 connection；session 独立于 pool 限额并有空闲超时强制回收；断链即事务消亡，不提供「重连续事务」；是 v0.4 安全编辑（FR-250）的前置能力。
- **FR-240** 保存 / 打开 SQL 文件与最近文件（P1）：系统对话框选路径 + 后端读写（不引入 `tauri-plugin-fs`）；最近文件只持久化路径与打开时间，不写入加密历史；SQL 历史仍由 FR-106 负责。
- **FR-241** index / constraint 元数据树与数据库对象搜索（P1）：MySQL `information_schema` 与 PostgreSQL `pg_index` / `pg_constraint` 双方言实现，接入 v0.2 LRU cache 失效链；搜索按名称过滤并定位展开树节点；column 树仍由 FR-112 负责。
- **FR-243** 多结果 tab 与 SQL 格式化（P1）：保持「单语句直接执行」护栏不变；「执行全部」由后端按方言分号状态机拆分逐条执行，每条独立 guard 分类与写确认，边界不确定即拒绝执行；一次执行保留多个结果集；多查询 tab 仍由 FR-109 负责。

实施顺序与历史见 [progress.md](../memory-bank/progress.md)。

---

### 3.4 v0.4 范围（安全数据维护与对象管理）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md) 与 [progress.md v0.4 归档](../memory-bank/progress.md#v04-已交付周计划归档)。

> **实现状态（2026-08-22）**：三项 FR 代码与自动化门禁已全部完成，integration 双 driver 全绿（编辑批 7 项 + bulk_insert 3 项 + dump 往返 2 项）；`v0.4.0-rc1` 已发布（prerelease，四平台构建成功）；待 V4-T8.1 真实环境回归、V4-T8.2 一周试用与正式发布。

- **FR-250** 仅带主键单表的安全表格编辑（P0）：在浏览 tab（FR-242）上进入编辑模式，新增 / 修改 / 删除先以 dirty state 暂存前端；「提交」时在独占 session（FR-244）上以单事务批量执行参数化 DML，「放弃」整体丢弃；编辑期不持有事务，避免长事务占用连接。仅显式主键表可编辑（复合主键支持），无主键表与 JOIN / 聚合结果禁止写回；提交前展示变更摘要并二次确认；MySQL / PostgreSQL 双方言。
- **FR-251** 结构查看、DDL 预览与新建表（P1）：v0.4 范围为完整结构查看（列定义 + 已有索引 / 约束）、建表 DDL 预览（MySQL `SHOW CREATE TABLE`，PostgreSQL 由元数据拼装）与「新建表」结构化表单（生成 SQL 预览 → 二次确认后执行）；修改表与索引 / 约束设计器按反馈顺延，不在 v0.4 承诺。执行任何 DDL 必须先展示 SQL 预览并二次确认。
- **FR-252** CSV 导入与 SQL dump 导入 / 导出（P1）：CSV 导入带列映射预览、类型转换、批量参数化 INSERT 与错误行策略（中止 / 跳过并报告）；表 / 库级 SQL dump 导出为 INSERT 语句文件，导入按大文件流式拆分执行（复用 FR-243 分号状态机）并带进度与失败定位；禁止整文件读入内存。CSV / Excel 查询结果导出仍由 FR-107 负责，本项不含备份 / 恢复语义（FR-260）。

实施顺序与验收见 [PLAN](./PLAN.md) 与 [RELEASE_CHECKLIST v0.4](./RELEASE_CHECKLIST.md#v04-发布检查清单)。

---

### 3.5 v0.5 范围（结构变更、官方备份与连接协作）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md) 与 [progress.md v0.5 归档](../memory-bank/progress.md#v05-已交付周计划归档)。

> **实现状态（2026-08-24）**：三项 FR 编码与自动化单测已完成；GUI 真实回归与 RC 试用由用户验收（V5-T8.1 / T8.2）。

- **FR-253** 修改表、索引 / 约束设计器与 View 结构（P0）：在 v0.4 结构查看与新建表（FR-251）之上提供列级 ALTER（ADD / DROP / MODIFY，双方言）以及索引增删；所有语句先生成 SQL 预览再二次确认后执行。v0.5 不承诺图形化换主键、不承诺 `RENAME COLUMN` 向导。View 仅只读展示列。FOREIGN KEY / CHECK 新建向导可降级。
- **FR-260** 官方工具备份与恢复（P1）：编排本机 `mysqldump` / `mysql`（PG 的 `pg_dump` / `pg_restore` 争取同版本交付），经已建立隧道的本地端口读写文件，提供进度、取消、日志与失败中止。不自行发明备份格式，也不把 FR-252 SQL dump 冒充备份。恢复必须手输目标库名。范围是当前库 / schema 或单表，不做全实例。
- **FR-221** 加密分享连接配置（P1）：用独立口令导出选中连接到自描述信封文件，同事用同一口令导入；不导出 `master.key`，默认不打包私钥文件内容，导入一律新 id 且不带入对方 `known_hosts`。

实施顺序与验收见 [PLAN](./PLAN.md) 与 [RELEASE_CHECKLIST v0.5](./RELEASE_CHECKLIST.md#v05-发布检查清单)。

---

### 3.6 v0.6 范围（结构对比、可审阅同步与关系图）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md) 与 [progress.md v0.6 归档](../memory-bank/progress.md#v06-已交付周计划归档)。

> **实现状态（2026-08-24）**：三项 FR 编码与单测已完成；GUI/RC 由用户验收（V6-T8.1 / T8.2）。

- **FR-220** 双连接结构 diff（P0）：对两条**已打开**连接的指定 database/schema 对比表 / 列 / 索引 / 约束。同方言可进入后续同步；跨 driver 只展示。不隐式打开连接。
- **FR-261** 结构同步脚本（P1）：由 diff 按用户选定方向生成可审阅 SQL（CREATE/DROP/ALTER/索引/约束），确认后才在目标连接执行。v0.6 **不做数据拷贝 / 行级同步**。跨 driver 禁止生成执行脚本。
- **FR-263** 只读 ER（P1）：用已有外键元数据画当前 schema 的表关系；点击定位结构页。不做正向工程、不持久化拖拽布局。

实施顺序与验收见 [PLAN](./PLAN.md) 与 [RELEASE_CHECKLIST v0.6](./RELEASE_CHECKLIST.md#v06-发布检查清单)。

---

### 3.7 v0.7 范围（表数据搬迁、库内权限与执行计划）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md) 与 [progress.md v0.7 归档](../memory-bank/progress.md#v07-已交付周计划归档)。

> **实现状态（2026-08-24）**：三项 FR 编码与单测已完成；GUI/RC 由用户验收。

- **FR-266** 双连接表级数据拷贝（P0）：两条已打开、同方言连接之间按表拷贝行。源侧分页读取，目标侧参数化批量插入（复用 `bulk_insert_rows`）。默认追加；若先清空目标必须手输目标表名并预览语句。跨 driver / 未打开连接拒绝。不做双向同步或冲突合并。
- **FR-262** MySQL 用户与权限（P1）：列出账号与授权摘要（不含密码哈希），变更生成 GRANT/REVOKE/CREATE USER SQL 并二次确认。不引入 tiny-sql 应用账号。PG 角色变更可降级为只读。
- **FR-222** EXPLAIN 可读化（P1）：查询 tab 对当前 SQL 执行 EXPLAIN 并以树/表展示。`EXPLAIN ANALYZE` 单独入口并确认（会真正执行）。不做慢查询采集或监控平台。

验收见 [PLAN](./PLAN.md) 与 [RELEASE_CHECKLIST v0.7](./RELEASE_CHECKLIST.md#v07-发布检查清单)。

---

### 3.8 v0.8 范围（防连错与查询补齐）

非详细需求，仅锚点。详见 [ROADMAP.md](./ROADMAP.md) 与 [progress.md v0.8 归档](../memory-bank/progress.md#v08-已交付周计划归档)。

> **实现状态（2026-08-24）**：六项 FR 编码与单测已完成；GUI/RC 由用户验收。

- **FR-270** 连接只读开关（P0）：连接配置增加应用层 `readOnly`。打开后前端禁用写入口，后端所有写 command（含导入、恢复、拷贝目标、权限变更、ANALYZE、结构同步目标）返回 `error.connection.read_only`。不替代数据库账号权限。浏览、导出、备份导出、以只读连接为对比源仍可用。
- **FR-271** 连接环境色 / 标签（P1）：`none | prod | staging | dev` 展示在列表、标题、tab 与破坏性确认框。不做自定义调色板，不按环境自动只读。
- **FR-272** 同库复制为新表（P1）：当前连接上预览建表 SQL（MySQL `CREATE TABLE … LIKE`，PG 用结构重建并改名），手输新表名后执行；可选再灌数据（复用表拷贝内核）。不做整库克隆。
- **FR-273** 单元格检查器与外键跳转（P1）：结果格查看完整值（NULL/空串可区分，JSON 尝试格式化）。单列 FK 可打开引用表并等值筛选。检查器不直接写回。跨连接 FK 不做。
- **FR-274** RENAME COLUMN 预览（P1）：修改表对话框可重命名列，生成双方言 `RENAME COLUMN` 并确认。仍不换主键。可整项降级。
- **FR-275** EXPLAIN 读后提示（P1）：在已有计划树上标注全表扫描 / filesort / Seq Scan 等，不改写 SQL，不做采集。可整项降级。

验收见 [PLAN](./PLAN.md) 与 [RELEASE_CHECKLIST v0.8](./RELEASE_CHECKLIST.md#v08-发布检查清单)。

---

## 4. 非功能需求

### 4.1 性能

**NFR-001 启动速度**：冷启动到主窗口可交互 ≤ 2s（M 系列 Mac）/ ≤ 3s（Intel Mac）。

**NFR-002 连接建立**：3 跳 SSH + MySQL `SELECT 1` 全链路 ≤ 5s（典型办公网到云数据库）。

**NFR-003 隧道断开感知**：keepalive 连续 3 次失败到 UI 显示 lost ≤ 180s（60s × 3，FR-014）。

**NFR-004 表浏览渲染**：1000 行 × 10 列虚拟滚动 60fps（react-virtuoso 实测能达到）。

**NFR-005 SQL 取消响应**：点取消按钮到查询中止 ≤ 1s（FR-023）。

### 4.2 安全

**NFR-010 数据落盘加密**：连接配置（含 SSH password）必须 AES-GCM 加密。明文 grep 必须返回 0 命中。

**NFR-011 passphrase 存储安全**：未启用主密码时 SSH 私钥 passphrase 仅会话内存（Zeroizing 包装，进程退出即丢，不写文件）；v0.2 启用主密码并解锁后，用户可选择加密持久化到 `secrets.enc`（FR-102），删除连接同步清理。

**NFR-012 known_hosts 隔离**：tiny-sql 的 SSH known_hosts 写到自有 store（`~/Library/Application Support/tiny-sql/known_hosts.json`），**不读、不写** `~/.ssh/known_hosts`。

**NFR-013 host key 变更硬拒绝**：已信任主机的公钥指纹变化时硬拒绝连接（不弹"忽略"按钮），UI 显示明确的 MITM 警告（i18n key `error.ssh.host_key_mismatch`）。

**NFR-014 仅本地业务通信**：tiny-sql 不上传连接配置、SQL、查询结果或错误日志；业务通信只访问用户配置的 SSH/MySQL 目标。自动更新只访问 GitHub Release 的正式版更新清单；无遥测、无错误上报。

**NFR-015 SQL 写操作二次确认**：FR-024 描述的只读保护是默认开启的，无法在 UI 上关闭（v0.2 可加"已知风险，永久关闭"开关，但 v0.1 不留口子）。

### 4.3 可观测性

**NFR-020 拓扑图断点定位**：用户能在拓扑图上一眼看出哪一跳失败（FR-013 + FR-014）。

**NFR-021 错误消息可读**：所有用户可见的错误用中文 + 具体上下文。禁止显示原始 Rust 错误（如 `Custom { kind: ConnectionRefused, error: ... }`）。

**NFR-022 日志可导出**：`tauri-plugin-log` 写日志到本地文件，用户能从设置页"打开日志目录"。

### 4.4 兼容性

**NFR-030 macOS 版本**：macOS 13 Ventura 及以上（Tauri 2 最低要求）。

**NFR-031 MySQL 版本**：5.7 / 8.0 / 8.4 LTS（5.7 EOL 但国内仍在用，必须支持）。

**NFR-032 SSH 协议**：OpenSSH 兼容；不支持 SSH1 protocol（russh 不支持）；不支持基于 GSSAPI 的 Kerberos 认证（企业场景留待 v0.3+ 评估）。

### 4.5 可维护性

**NFR-040 仓库分层**：选 Approach B（Clean Workspace），`crates/ssh-multihop` 与 `crates/db-driver` 是独立 crate，能脱离 tiny-sql 整体被其他项目复用。

**NFR-041 SshTunnelError 稳定 i18n key**：每个错误变体的 i18n key 是公开 API 的一部分；后续版本只能加新 key、不能改已有 key（前端翻译表向后兼容）。

**NFR-042 Driver 契约与多数据库扩展**：v0.2 已从真实 commands 调用面提取对象安全的最小 `Driver` 契约，覆盖 kind、ping、metadata（显式 database/schema scope）、query/取消与 close；`MySqlDriver` 与 `PostgresDriver` 均实现该契约。连接创建与方言专属操作（如 MySQL `CREATE DATABASE`）留在具体实现，保持契约紧凑。

---

## 5. 范围边界（明确不做什么）

v0.1 **不做**的事情，全部有明确理由：

### 5.1 数据库范围之外

- **PostgreSQL / SQLite / Oracle / SQL Server / MongoDB / Redis**：v0.1 不实现；v0.2 增加 PostgreSQL，其他数据库仍不进入当前范围（NFR-042）。理由：v0.1 dogfooding 场景 100% MySQL。
- **MySQL 写操作的图形化编辑器**（点表格 cell 改值后写回）：FR-024 的 SQL 编辑器是 v0.1 写操作上限。理由：图形化编辑器需要 2-3 周额外工作量，60-75h 预算装不下。

### 5.2 平台范围之外

- **Windows ARM / Linux ARM / 发行版专属包**：v0.1 只覆盖 macOS arm64/x64、Windows x64、Linux x64 AppImage。理由：先跑通主流桌面平台和 updater，签名、更多包格式与 ARM 平台留后续打磨。
- **iOS / Android**：永不在路线图内。理由：手机上敲 SQL 是反人类需求。

### 5.3 功能范围之外

- **Schema-aware 智能联想**：v0.1 仅做基础 database/table 补全；"点 `user_id` 列自动提示 JOIN 候选"推 v0.2（FR-104）。
- **Monaco Editor / 高级代码补全**：v0.1 已用 CodeMirror 6 覆盖基础编辑体验，不接 Monaco、不做语义级 SQL 智能补全。
- **SQL 历史**：推 v0.2（FR-106）。
- **导出 CSV / Excel**：推 v0.2（FR-107）。
- **多 tab 同时执行**：v0.1 单 tab，单 SQL。理由：复杂度 +30%，dogfooding 场景里作者本人 80% 时间只开一个查询。
- **大表 LRU schema cache**：v0.1 假设小库（FR-020 注），每次开 schema 重查 `information_schema`。大库 cache 推 v0.2。
- **MySQL TLS 生产级验收与诊断 UX**：v0.1 已接线 SSL 模式和证书路径，但真实 TLS/双向证书环境、证书选择器和错误诊断尚未完成，推 v0.2 打磨。
- **断线自动重连**：仍不做后台指数退避 / 自动重试。v0.2 的 FR-110 是用户显式触发的幂等重连，避免静默循环连接或锁死。

### 5.4 协同与团队范围之外

- **多人协同编辑同一连接**：tiny-sql 是单机工具。
- **加密分享连接配置**：v0.1–v0.4 不支持；`connections.enc` 绑定同机 `master.key`，不得把“复制加密文件”描述成可用分享流程。独立导出密码的加密导出/导入见 v0.5 FR-221。
- **审计日志**：v0.1 不记录"用户在 X 时间对 Y 库执行了 Z SQL"。理由：审计是企业场景，副业项目不背书。

### 5.5 监控与告警范围之外

- **慢查询监控 / EXPLAIN 可视化**：DataGrip 的 selling point，不是 tiny-sql 的。
- **多集群 diff**：不在 v0.5；作为 v0.6 结构同步（FR-261）的前置（FR-220）。

---

## 6. 关键决策回溯

为方便后续 review 与重构，关键产品决策的依据汇总：

| 决策 | 依据 |
|---|---|
| 选 Approach B（Clean Workspace）而非 A（Fork） | 长期维护意图 + 仓库诞生即干净 + ssh-multihop 未来独立 publish |
| v0.1 全平台先覆盖 x64 | 先跑通 macOS arm64/x64、Windows x64、Linux x64 打包和 updater；签名、更多包格式与 ARM 平台后续打磨 |
| v0.1 仅 MySQL | dogfooding 100% MySQL；v0.2 再提取 Driver 契约并增加 PostgreSQL |
| v0.1 仅 zh-CN | 翻译成本 vs 首发收益不划算 |
| v0.1 拓扑图用纯 CSS 线性布局 | 当前只需要固定的本机 → N 跳 → MySQL 状态链路；避免 react-flow 画布的缩放、拖拽、attribution 和 bundle 成本 |
| v0.1 无 Apple Developer 代码签名 | $99/年阻塞首发；README 教用户右键打开 |
| v0.1 加自动更新但不做 Apple Developer 代码签名 | Tauri updater minisign 签名不需要开发者账号；自动更新解决正式版分发迭代，首次打开摩擦仍靠 README 说明 |
| v0.1 加 SSH keepalive（FR-014），60s + 3 次阈值 | "可观测路由器"叙事必需；180s 内感知断开仍胜过 DBeaver"亲 query 才发现"；阈值防弱网/bastion 误报 |
| v0.1 不做断线自动重连 | 重连策略独立设计；避免 v0.1 引入隐式状态机 |
| v0.1 加密配置但不加密 passphrase | 配置低风险落盘 + passphrase 推 v0.2（用户主密码 derive key） |
| v0.1 SQL 取消用 tokio::select! + 独立 control pool KILL QUERY | 不依赖 sqlx 的 fragile cancellation；独立 control pool 保证主 pool 满时 KILL 仍发得出，不留服务端幽灵查询 |
| v0.1 LIMIT 防护用顶层安全追加 LIMIT 而非 derived table 包装 | 早期考虑子查询包装（`SELECT * FROM (...) AS t LIMIT n`），实测在多表 JOIN 重名列触发 MySQL 1060；改为顶层无 LIMIT/FOR/LOCK/INTO/PROCEDURE 时末尾追加 `LIMIT n+1`，否则客户端截断兜底（截断且无服务端 LIMIT 时主动 KILL QUERY 止损） |
| v0.1 不写 trait Driver，用具体 struct | 单实现 trait 是 premature abstraction；v0.2 已从真实调用面提取最小对象安全契约 |

---

## 7. 验收 checklist（v0.1 发布门槛）

发布前必须全部通过：

- [x] FR-001 ~ FR-042 标 P0 的需求验收完成；已知实现边界已写入 v0.1.0 Release notes 与 PLAN
- [x] NFR-001 ~ NFR-005 性能指标实测达标
- [x] NFR-010 ~ NFR-015 安全检查通过（含明文扫描）
- [x] NFR-020 ~ NFR-022 可观测性达标
- [x] FR-041 dogfooding：作者 + 2 同事 × 1 周 × 0 数据丢失
- [x] README 含中文“右键打开”说明；不要求额外录制 GIF
- [x] CHANGELOG 0.1.0 已写
- [x] GitHub Actions 跑通 macOS arm64/x64、Windows x64、Linux x64 build
- [x] tag v0.1.0 已发布 `.dmg` / `.exe` / `.AppImage`、updater artifact 和 `latest.json`

---

## 附录 A：术语表

| 术语 | 含义 |
|---|---|
| **hop** | SSH 多跳隧道中的一跳；hops[0] 是本地直连的 SSH 主机，hops[N-1] 是出口主机 |
| **TOFU** | Trust On First Use；首次见到未知 host key 时让用户决定信任或拒绝 |
| **TunnelLost** | SshTunnelError mid-session 变体，已建立的隧道因 keepalive 连续 3 次失败而断开（FR-014） |
| **ChannelDropped** | SshTunnelError mid-session 变体，某跳 channel 被对端主动关闭（可能跳板重启），需人工重连 |
| **AcceptLoopDied** | SshTunnelError mid-session 变体，某跳 accept loop panic（代码 bug），需上报 |
| **control pool** | SQL 取消用的独立 MySQL 连接池（max=1，主 pool 之外、同一连接参数），专发 KILL QUERY |
| **direct-tcpip** | SSH 协议的 channel 类型，用于把 SSH session 内的一个 channel 转发到任意 TCP 地址 |
| **dogfooding** | 作者自己 + 同事用自己的产品验证可用性 |
| **caching_sha2_password** | MySQL 8.0 默认认证插件，sqlx 0.8 默认支持 |
| **i18n key** | 错误的稳定字符串标识（如 `error.ssh.host_key_mismatch`），前端按 key 翻译，不依赖错误消息文本 |
