---
title: tiny-sql 需求文档
version: 0.1.0-draft-2
status: draft
last_updated: 2026-06-26
---

# tiny-sql 需求文档

> 配套文档：[PLAN.md](./PLAN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)

## 1. 项目愿景

tiny-sql 是一款**多级跳板机友好的 MySQL 桌面客户端**。

主流 SQL 客户端（DBeaver、TablePlus、Navicat、DataGrip、Sequel Ace、Beekeeper Studio）把 SSH 隧道当作"雾中一根管子"——单跳、黑盒、出错无法定位哪一跳挂了。DBeaver 名义上支持 OpenSSH ProxyJump 多跳，但 UI 完全不暴露这层逻辑，调试体验等同于裸 `ssh -L`。

tiny-sql 把跳板机从"雾中一根管子"变成**可观测的路由器**：每一跳都是 UI 上的一等公民节点，有独立的连接状态、独立的错误归因、独立的延迟读数。v0.1 给出"本地 → 跳板 1 → 跳板 2 → 跳板 3 → MySQL"的拓扑图视图；隧道任意一跳挂掉时高亮断点节点，180s 内向 UI 推送 lost 状态。

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
- **场景 A3：执行修复 SQL**。需要 `UPDATE t_order SET status = ... WHERE id IN (...)` 一行修数据。粘贴 SQL 进 textarea，点执行，弹出"检测到 UPDATE 操作，确认执行？"对话框，输 yes 二次确认。执行成功显示影响行数。

### 2.2 用户画像 B：同事推广

**身份**：与作者同公司、同样面对多级堡垒的工程师，运维、后端、数据。

**关键痛点**：
- 不愿配 OpenSSH ProxyJump（觉得是高阶技巧）；用 Navicat 但只能配单跳，于是日常先开 iTerm `ssh -L` 拼链路、再让 Navicat 连 `127.0.0.1:13306`，工具链断裂。
- 没有 $99 Apple Developer 账号也能用（v0.1 无 Apple Developer 代码签名，README 教"右键打开"）。

**典型场景**：

- **场景 B1：上手 5 分钟**。从作者群消息拿到 .dmg 链接，下载、右键打开、配第一个连接：填 3 跳 SSH + MySQL 信息，TOFU 弹窗确认指纹，连接成功。整个流程预期 5 分钟内，不需要看文档。
- **场景 B2：连接配置分享**。同事 C 想用同样的连接，作者把 tiny-sql 加密后的连接配置 JSON 发给 C（v0.1 手动复制配置文件；v0.2 加密导出/导入），C 输入自己的 SSH 私钥 passphrase 后即可使用。
- **场景 B3：替代 Navicat**。同事 B 用 1 周后反馈：日常浏览数据、查 schema、跑 SELECT 完全够用，唯一缺失的是"导出 CSV"和"SQL 历史"（这些是 v0.2 范围）。

### 2.3 用户画像 C：开源社区用户

**身份**：V2EX/掘金/GitHub 上看到 tiny-sql 的中文开发者，环境可能是中小公司或个人项目。

**关键痛点**：
- 不一定有 4 层堡垒，但 1-2 跳很常见（个人 VPS 上的 MySQL 通过 1 跳 SSH 访问）。
- 多语言但首发只需 zh-CN；i18next 留扩展口。
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
- 单条配置含：name / host / port / username / password / database（可选默认） / ssh_hops[]（可选）。
- 配置以 AES-GCM 加密落盘到 `~/Library/Application Support/tiny-sql/connections.enc`。
- **验收标准**：
  - 新建一个 3 跳 + MySQL 配置，重启应用后配置仍在列表中。
  - 删除一个配置，重启应用后配置不在列表中。
  - 用 `cat connections.enc` 直接看文件，不能看到明文 host/user/password。

**FR-002 [P0] 连接测试**

- 创建/编辑对话框上有"测试连接"按钮，点击立刻尝试建立完整链路（SSH 隧道 + MySQL 握手 + `SELECT 1`），成功显示绿色对勾，失败显示具体错误（i18n key 翻译后的中文）。
- **验收标准**：
  - 配置正确 → 5s 内显示成功。
  - SSH 第 2 跳故意填错端口 → 30s 内显示"第 2 跳连接失败"。
  - MySQL 密码错 → 显示"MySQL 认证失败"，不能误报 SSH 错误。

**FR-003 [P1] 连接历史与最近使用**

- 连接列表按"最近使用时间"排序，最近用的连接在最上面。
- **验收标准**：双击连接 A 后再回到列表，A 在最上面。

#### 3.1.2 SSH 多跳隧道

**FR-010 [P0] 配置 N 跳 SSH 隧道**

- UI 上"SSH 跳板"区块是动态数组，用户可以"+"添加 hop、"-"删除 hop、拖动调整顺序。
- 单条 hop 含：host / port（默认 22） / username / auth_type（password / privateKey） / password? / private_key_path? / passphrase?（仅会话内存，不落盘）。
- v0.1 测试到 3 跳；理论上无硬上限（性能限制留待 v0.2 评估）。
- **验收标准**：
  - 配置 1 跳能连。
  - 配置 3 跳能连。
  - 调整 hop 顺序后连接路径按新顺序走。

**FR-011 [P0] 私钥 passphrase 处理**

- 私钥带 passphrase 时，首次连接弹窗让用户输入；输入后**仅本会话内存缓存**，进程退出即丢。
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
- 错误归因机制：`SshTunnelError` 每个变体都带 `hop_index: usize` 字段，从后端原样透传到前端。
- **验收标准**：
  - 第 2 跳 host 填错 → hop[1] 节点红，hop[0] 绿。
  - 第 3 跳认证失败 → hop[2] 节点红。
  - 错误消息是中文（i18n 翻译后），不是英文 `connect_failed` 字面量。

**FR-014 [P0] SSH keepalive 与隧道断开感知**

- 隧道建立后，每 **60s** 向每一跳发 `russh::session::send_keepalive()`。
- **连续 3 次失败（≈180s）才判定断开**——避免弱网抖动 / 企业 bastion ratelimit 误报。判定断开时 emit `ssh:hop-status` event，payload 含 `connection_id / hop_index / status: "lost" / reason`，前端拓扑节点变红。
- `SshTunnelError` 新增三个 mid-session 变体（各有独立 i18n key）：`TunnelLost { hop_index, reason }`（keepalive 超时）/ `ChannelDropped { hop_index }`（对端主动关 channel，可能跳板重启）/ `AcceptLoopDied { hop_index }`（accept loop panic，代码 bug 需上报）。
- keepalive 间隔（60s）与失败阈值（3 次）v0.1 是常量，v0.2 做成可配置。
- **验收标准**：
  - 隧道连接稳定时 → 不 emit lost 事件。
  - 手动 kill 第 2 跳 sshd → **180s 内** UI hop[1] 变红，弹 toast 提示"第 2 跳断开"。
  - 隧道断开后用户点"重连" → 拓扑回到 pending → connected 流程。
- **设计意图**：这是"把跳板机从雾中一根管子变成可观测路由器"叙事的核心，不是可选项。

**FR-015 [P0] 拓扑图视图**

- 连接面板顶部用 `@xyflow/react` 画静态拓扑：节点 = 本地 / hop[0] / hop[1] / ... / hop[N-1] / MySQL；边 = TCP 通道。
- 节点状态：`pending`（灰色）/ `connected`（绿色）/ `failed`（红色）/ `lost`（红色 + 闪烁，区别于 failed）。
- 状态通过 tauri event `ssh:hop-status` 推送，payload schema 见 [ARCHITECTURE.md](./ARCHITECTURE.md#7-前后端事件契约)。
- v0.1 节点状态简化为 4 态（pending / connected / failed / lost），**不**做"实时延迟动画"（推 v0.2）。
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
- **子查询包装注入 LIMIT**（不是 regex 检测）：`SELECT * FROM (<原 SQL>) AS tiny_sql_limited LIMIT 1000`，MySQL 原生语义、零误判；用户手写 LIMIT 装在内部、外层取小，意图一致。避免大表 OOM。
- 用 `react-virtuoso` 虚拟滚动渲染，列宽可拖拽调整。
- **验收标准**：
  - 表 100 万行 → 服务端只回 1000 行，UI 流畅滚动。
  - 表 50 行 → 显示 50 行，不报"已截断"。

**FR-022 [P0] SQL 执行**

- 顶部 textarea（**不上 Monaco Editor**，v0.1 砍代码补全），用户输入 SQL，点"执行"按钮跑。
- 结果以表格展示，复用 FR-021 的虚拟滚动组件。
- **客户端结果集硬上限 10w 行**：超出截断并显示提示"已截断到 10w 行，请加 LIMIT"。
- **验收标准**：
  - `SELECT * FROM t_order LIMIT 100` → 显示 100 行。
  - `SELECT * FROM huge_table`（500w 行表，无 LIMIT）→ 显示 10w 行 + 截断提示。
  - 语法错 → 显示 MySQL 服务端原文错误（带行号）。

**FR-023 [P0] SQL 取消**

- 执行按钮旁有"取消"按钮，执行中点取消能立刻中止 query（不等结果回来）。
- 后端用 `tokio::select!` + cancel token 中止客户端等待；**同时从一条独立 control connection（主 MySqlPool 之外、同一隧道独立本地端口）发 `KILL QUERY <connection_id>` 中止远端执行**。独立 control conn 保证 pool 满时 KILL 仍能发出，不留服务端"幽灵查询"。
- **验收标准**：
  - 跑 `SELECT SLEEP(60)` → 5s 后点取消 → 1s 内停止，UI 显示"已取消"。
  - 取消后 MySQL `SHOW PROCESSLIST` 中该 query 消失（服务端确实被 KILL）。

**FR-024 [P0] 只读保护（best-effort）**

- 用户输入的 SQL 在执行前**正则检测**，命中 `DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|GRANT|CREATE|REPLACE` 关键字（忽略大小写、忽略字符串/注释内的伪命中）时，弹出"检测到写操作，确认执行？"对话框，二次确认后才执行。
- **明确语义：这是 best-effort 防护，不承诺数据库级只读。** `SELECT func_that_writes()` / `SELECT ... INTO OUTFILE` / 用户变量赋值 / 存储过程边界等绕过正则的写副作用无法拦截。真正只读请使用 MySQL 只读账号——README 与连接编辑页都提示这一点。正则只是"低成本一道闸"，不是安全边界。
- **验收标准**：
  - `SELECT * FROM t` → 直接执行。
  - `UPDATE t SET x = 1 WHERE id = 1` → 弹对话框。
  - `SELECT 'UPDATE not really' FROM t` → 直接执行（识别字符串内的伪命中）。
  - `-- UPDATE 这是注释` → 直接执行。

**FR-025 [P0] MySQL 5.7 + 8.0 兼容**

- 必须同时支持 MySQL 5.7（默认 `mysql_native_password`）和 8.0（默认 `caching_sha2_password`）。
- 用 `sqlx 0.8` features=["mysql", "runtime-tokio", "rustls"] 实现。**v0.1 编译进 rustls 但不启用也不测试 MySQL TLS**，v0.2 启用时再补 webpki-roots/native-tls CA 链选型。
- **验收标准**（不用 Docker，连用户本地 MySQL）：
  - 用户本地 MySQL 8.0 经 `TINY_SQL_TEST_MYSQL_URL` integration test → 能连、能查（caching_sha2_password 握手通过）。
  - **MySQL 5.7 兼容验证推到 Week 5 dogfooding** 找用 5.7 的同事验证（CP-3），不进 CI 矩阵。

**FR-026 [P1] 连接池策略**

- 1 个 tiny-sql 连接 = 1 个本地 listener 端口 = 1 个 `MySqlPool`（max_connections = 5）。
- 隧道断开（FR-014）触发 pool drop，UI 显示连接已断开。
- v0.1 **不做断线自动重连**——用户手动点"重连"。
- **验收标准**：
  - 同时打开 5 个 tab 跑不同 SQL → 复用同一 pool，不报"too many connections"。
  - 隧道挂了 → SQL 报错 + UI 显示连接已断开 + "重连"按钮可用。

#### 3.1.4 国际化与本地化

**FR-030 [P0] 中文（zh-CN）**

- v0.1 UI 全中文。
- i18next runtime 保留，方便 v0.2 加英文。
- en bundle 留 placeholder（key 全有，value 待填）。
- **验收标准**：
  - 切换语言下拉框只能选"中文"（en 选项灰色 + tooltip "v0.2"）。

#### 3.1.5 分发

**FR-040 [P0] macOS .dmg 发布**

- GitHub Actions 矩阵：macOS arm64 + x64。
- tag `v0.1.0` 触发自动 build + 上传 .dmg 到 GitHub Releases。
- v0.1 无 Apple Developer 代码签名 / notarization：README 顶部写"右键打开 → 允许"操作说明 + GIF。
- **验收标准**：
  - 全新 M 系列 Mac 下载 .dmg → 右键打开 → 应用启动 → 能连数据库。
  - Intel Mac 同上。

**FR-042 [P0] 正式版自动更新**

- 接入 `tauri-plugin-updater`，构建 `.app.tar.gz` 与 `.sig` 更新包。
- tag `v0.1.0` 正式版发布时生成 GitHub Release `latest.json`；`v*-rc*` / beta / alpha 不生成 `latest.json`，不作为自动更新源。
- 应用启动后每日检查一次正式版更新，左侧工具区支持手动检查。
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

- **FR-100** PostgreSQL driver（v0.2 用 rust-analyzer extract trait Driver，v0.1 是具体 struct）
- **FR-102** 加密 passphrase 存储（用户主密码 derive key）
- **FR-103** MySQL TLS 连接启用（webpki-roots / native-tls CA 链选型）
- **FR-104** Schema-aware 智能联想（点 user_id 列自动提示 JOIN 候选）
- **FR-105** 实时隧道延迟动画（每跳的 RTT 显示在边上）
- **FR-106** SQL 历史
- **FR-107** 导出 CSV / Excel

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

**NFR-011 passphrase 不持久化**：v0.1 SSH 私钥 passphrase 仅会话内存，进程退出即丢；不写文件、不写 swap（best effort，无 mlock 保证）。

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

**NFR-042 v0.1 具体 struct，v0.2 才抽 trait**：v0.1 **不写 `trait Driver`**——直接写具体 `struct MySqlDriver`，commands 返回具体类型。v0.2 加 PG 时用 rust-analyzer extract trait（两个实现在手才设计接口，避免抽象提前）。理由：单实现 trait 是 premature abstraction，trait 签名只能凭猜设计、v0.2 PG 大概率要返工。代价是 v0.2 加 PG 时 commands 调用点要做一次 refactor（rust-analyzer 一键操作）。

---

## 5. 范围边界（明确不做什么）

v0.1 **不做**的事情，全部有明确理由：

### 5.1 数据库范围之外

- **PostgreSQL / SQLite / Oracle / SQL Server / MongoDB / Redis**：v0.1 不实现；v0.2 加 PG 时 extract trait（NFR-042）。理由：dogfooding 场景 100% MySQL，无优先级。
- **MySQL 写操作的图形化编辑器**（点表格 cell 改值后写回）：FR-024 的 SQL textarea 是 v0.1 写操作上限。理由：图形化编辑器需要 2-3 周额外工作量，60-75h 预算装不下。

### 5.2 平台范围之外

- **Windows / Linux**：v0.1 仅 macOS arm64 + x64。理由：CI 调试 Win/Linux 会吃掉 dogfooding 时间，作者本身也只用 macOS（dogfooding 不到这俩平台）。v0.2 排期。
- **iOS / Android**：永不在路线图内。理由：手机上敲 SQL 是反人类需求。

### 5.3 功能范围之外

- **Schema-aware 智能联想**：v0.1 仅"列出 schema/table/column"（FR-020）。"点 `user_id` 列自动提示 JOIN 候选"推 v0.2（FR-104）。
- **代码补全 / Monaco Editor**：v0.1 用 `<textarea>` 即可。理由：Monaco 集成需要 5-8h，且与 v0.1 拓扑图叙事无关。
- **SQL 历史**：推 v0.2（FR-106）。
- **导出 CSV / Excel**：推 v0.2（FR-107）。
- **多 tab 同时执行**：v0.1 单 tab，单 SQL。理由：复杂度 +30%，dogfooding 场景里作者本人 80% 时间只开一个查询。
- **大表 LRU schema cache**：v0.1 假设小库（FR-020 注），每次开 schema 重查 `information_schema`。大库 cache 推 v0.2。
- **MySQL TLS 启用**：v0.1 sqlx feature `rustls` 编译进去，但**不启用、不测试** MySQL TLS 连接。理由：CA 链选型（webpki-roots vs native-tls）和测试需要 1-2 天，v0.1 不值。
- **断线自动重连**：v0.1 隧道断开后用户手动点"重连"（FR-026）。理由：自动重连策略（指数退避 / 最大次数 / 用户配置）是个独立设计，避免 v0.1 引入死锁。

### 5.4 协同与团队范围之外

- **多人协同编辑同一连接**：tiny-sql 是单机工具。
- **加密分享连接配置**：v0.1 用户手动复制配置文件给同事（场景 B2）。v0.3 可能加加密导出/导入（ROADMAP.md）。
- **审计日志**：v0.1 不记录"用户在 X 时间对 Y 库执行了 Z SQL"。理由：审计是企业场景，副业项目不背书。

### 5.5 监控与告警范围之外

- **慢查询监控 / EXPLAIN 可视化**：DataGrip 的 selling point，不是 tiny-sql 的。
- **多集群 diff**：v0.3+ 可能（ROADMAP.md）。

---

## 6. 关键决策回溯

为方便后续 review 与重构，关键产品决策的依据汇总：

| 决策 | 依据 |
|---|---|
| 选 Approach B（Clean Workspace）而非 A（Fork） | 长期维护意图 + 仓库诞生即干净 + ssh-multihop 未来独立 publish |
| v0.1 仅 macOS | dogfooding 不到 Win/Linux + CI 时间预算紧 |
| v0.1 仅 MySQL | dogfooding 100% MySQL + v0.2 extract trait 代价小 |
| v0.1 仅 zh-CN | 翻译成本 vs 首发收益不划算 |
| v0.1 拓扑图用 react-flow（@xyflow/react） | 自绘 SVG +1-1.5 周；bundle 300KB 桌面端可接受 |
| v0.1 无 Apple Developer 代码签名 | $99/年阻塞首发；README 教用户右键打开 |
| v0.1 加自动更新但不做 Apple Developer 代码签名 | Tauri updater minisign 签名不需要开发者账号；自动更新解决正式版分发迭代，首次打开摩擦仍靠 README 说明 |
| v0.1 加 SSH keepalive（FR-014），60s + 3 次阈值 | "可观测路由器"叙事必需；180s 内感知断开仍胜过 DBeaver"亲 query 才发现"；阈值防弱网/bastion 误报 |
| v0.1 不做断线自动重连 | 重连策略独立设计；避免 v0.1 引入隐式状态机 |
| v0.1 加密配置但不加密 passphrase | 配置低风险落盘 + passphrase 推 v0.2（用户主密码 derive key） |
| v0.1 SQL 取消用 tokio::select! + 独立 control conn KILL QUERY | 不依赖 sqlx 的 fragile cancellation；独立 control conn 保证 pool 满时 KILL 仍发得出，不留服务端幽灵查询 |
| v0.1 LIMIT 防护用子查询包装而非 regex | regex 会被注释/字符串/CTE/UNION 骗；子查询包装是 MySQL 原生语义、零误判 |
| v0.1 不写 trait Driver，用具体 struct | 单实现 trait 是 premature abstraction；v0.2 加 PG 时 extract trait |

---

## 7. 验收 checklist（v0.1 发布门槛）

发布前必须全部通过：

- [ ] FR-001 ~ FR-042 标 P0 的需求全部 ✅
- [ ] NFR-001 ~ NFR-005 性能指标实测达标
- [ ] NFR-010 ~ NFR-015 安全检查通过（含 grep 明文测试）
- [ ] NFR-020 ~ NFR-022 可观测性达标
- [ ] FR-041 dogfooding：作者 + 2 同事 × 1 周 × 0 数据丢失
- [ ] README 含"右键打开"GIF + 中文操作说明
- [ ] CHANGELOG 0.1.0 已写
- [ ] GitHub Actions 跑通 macOS arm64 + x64 build
- [ ] tag v0.1.0 推送后 GitHub Releases 自动出现 `.dmg`、updater artifact 和 `latest.json`

---

## 附录 A：术语表

| 术语 | 含义 |
|---|---|
| **hop** | SSH 多跳隧道中的一跳；hops[0] 是本地直连的 SSH 主机，hops[N-1] 是出口主机 |
| **TOFU** | Trust On First Use；首次见到未知 host key 时让用户决定信任或拒绝 |
| **TunnelLost** | SshTunnelError mid-session 变体，已建立的隧道因 keepalive 连续 3 次失败而断开（FR-014） |
| **ChannelDropped** | SshTunnelError mid-session 变体，某跳 channel 被对端主动关闭（可能跳板重启），需人工重连 |
| **AcceptLoopDied** | SshTunnelError mid-session 变体，某跳 accept loop panic（代码 bug），需上报 |
| **control connection** | SQL 取消用的独立 MySQL 连接（主 pool 之外、同一隧道独立本地端口），专发 KILL QUERY |
| **direct-tcpip** | SSH 协议的 channel 类型，用于把 SSH session 内的一个 channel 转发到任意 TCP 地址 |
| **dogfooding** | 作者自己 + 同事用自己的产品验证可用性 |
| **caching_sha2_password** | MySQL 8.0 默认认证插件，sqlx 0.8 默认支持 |
| **i18n key** | 错误的稳定字符串标识（如 `error.ssh.host_key_mismatch`），前端按 key 翻译，不依赖错误消息文本 |
