---
title: tiny-sql 开发计划
version: 0.2.0-draft-1
status: draft
last_updated: 2026-08-18
---

# tiny-sql 开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> **draft-2 变更**：本版按 `/plan-eng-review` 的 9 个 binding 决策重排。最大变化是 **Week 1 改为 vertical slice**（只证明端到端最小链路 work），keepalive/错误模型细分/测试基础设施/拓扑图全部下放到 Week 2-4。决策全表见 §12。
>
> **v0.2 draft-1 变更**：保留 v0.1 计划与历史检查点，在 §13 新增 v0.2 的 8 周可执行计划、依赖顺序、检查点、测试矩阵与降级规则。

> **当前进度快照（2026-08-18）**：当前预览版仍为 v0.0.3；用户提交 `4f54f02` 已确认 CP-3/CP-4/CP-5/CP-6、作者与同事试用及 launch 活动完成。经 `git fetch --tags --prune origin` 复核，仓库与远端仍没有 `v0.1.0-rc1` / `v0.1.0` tag，应用版本也仍为 `0.0.3`，仓库内没有 README GIF；带 passphrase 私钥的测试连接和 ChannelDropped / AcceptLoopDied 运行时检测也仍需补齐或收窄承诺。因此 v0.1 尚未正式发布，v0.2 只能在 §13.1 的启动门槛全部满足后开工。

## 1. 时间线总览

v0.1 = **5-6 周 × 12-13 小时/周 = 60-75 小时**。Week 6 是缓冲、Week 7 是 launch 活动，不算 dev 工量。

```
Week 1   12h   vertical slice（workspace + 单跳 ssh + sqlx SELECT 1 + hello 页，端到端打通）
Week 2   12h   测试基础设施 + MySqlDriver（具体 struct）+ 加密 store + 连接管理 UI（无 SSH）
Week 3   13h   多跳 SSH + keepalive + 错误模型三变体 + TOFU + 表浏览
Week 4   13h   SQL 执行（顶层安全追加 LIMIT + KILL QUERY）+ 拓扑图 + 错误高亮 + .dmg
Week 5   13h   dogfooding + 修 bug + README + tag v0.1.0
Week 6   10h   缓冲（任何一周溢出的工量；全部按时则用于 v0.2 预研）
Week 7    -    launch 活动（V2EX / 掘金 / GIF），不计 dev 工量

合计 dev = 73h（含 10h 缓冲）；裸 dev = 63h；上下界 60-75h
```

每周任务列表见 §2-§6。

---

## 2. Week 1 — vertical slice（目标 12h）

**目标**：用最小代价证明 **整条技术栈能端到端跑通**——一条单跳 SSH 隧道连上 MySQL，`SELECT 1` 返回，前端显示"连接成功"。这一周交付看起来"少"，但 derisk 了最重的不确定性（Tauri+workspace+sqlx+russh 组合是否 work）。

> **为什么是 vertical slice**：原 draft-1 的 Week 1 同时做 workspace 拆分/Tauri/Next.js/ssh-multihop 抽取/keepalive/错误模型/测试架 6 件事，cross-model review 警告"都开头、都没闭环"。先打通一条最窄链路，再逐周加宽。

### 2.1 任务

**T1.1 [3h] Tauri + workspace 摩擦点验证（最先做，关键风险检查点 CP-1）**
- `cargo new --workspace tiny-sql`，建 `crates/ssh-multihop`（先放空 `lib.rs`）
- `src-tauri/Cargo.toml` 里 `ssh-multihop = { path = "../crates/ssh-multihop" }`
- 跑 `just build`（内部为 `pnpm tauri build`）验证 workspace 成员引用能走通
- **若失败**：立刻退回扁平 mod 方案——`crates/ssh-multihop` 内容挪到 `src-tauri/src/ssh_multihop/mod.rs`，删 workspace 配置。**不要拖到 Week 2**

**T1.2 [3h] 单跳 SSH 隧道（先不要 3 跳）**
- 把 `redis-desktop-client/src-tauri/src/redis/ssh_tunnel.rs` 复制到 `crates/ssh-multihop/src/lib.rs`
- 去掉 redis 相关措辞（doc 里 Redis → 通用 "TCP target"）
- v0.1 Week 1 **只验证单跳**：本地 → 1 个跳板 → 目标端口。3 跳留 Week 3
- **不要**在这周加 keepalive、错误模型细分、TOFU UI（留 Week 2/3）

**T1.3 [2h] sqlx 桥接 SELECT 1**
- `crates/db-driver` 加最小代码：隧道暴露本地端口 P → sqlx 用 `mysql://user:pass@127.0.0.1:P/db` 连接
- 参考 `redis-desktop-client/src-tauri/src/redis/client.rs` 第 145-165 行的"本地 listener → URL"模式
- 跑通 `sqlx::query("SELECT 1").fetch_one()` 返回

**T1.4 [2h] Next.js 16 骨架 + hello 页**
- 从 redis-desktop-client 抄 `next.config.ts` / `tsconfig.json` / `postcss.config.mjs` / `tailwind.config.ts` / `eslint.config.mjs`
- `package.json` 依赖对齐（见 [ARCHITECTURE.md §2.3](./ARCHITECTURE.md#23-前端依赖)）
- 一个 hello 页：硬编码连接信息 → 点按钮调 tauri command → 显示"连接成功 / 失败"

**T1.5 [1.5h] tauri.conf.json + 最小 CI**
- 从 redis-desktop-client 抄 `tauri.conf.json` + `capabilities/default.json`（最小 permission 集）
- GitHub Actions：单 macOS arm64 check job，跑前端 build/Vitest + Rust fmt/clippy/test；跨平台桌面构建由 tag release workflow 负责
- 完整测试矩阵留 Week 2

**T1.6 [0.5h] 收尾**
- 确认 `just dev` 启窗口 → 点按钮 → 单跳隧道 → SELECT 1 → 前端显示成功

### 2.2 验收点（vertical slice 闭环）

- [x] **CP-1**：`just build` 在 workspace 布局下成功
- [x] `cargo tauri dev` 启窗口，点按钮经单跳 SSH 连上 MySQL，`SELECT 1` 返回
- [x] 前端 hello 页显示"连接成功"
- [x] GitHub Actions check job 跑通（最新 main CI 于 2026-08-08 成功）

### 2.3 本周不做（明确推后）

| 推后项 | 目标周 |
|---|---|
| keepalive ping | Week 3 |
| SshTunnelError 三个 mid-session 变体 | Week 3 |
| 3 跳 SSH | Week 3 |
| 测试基础设施（vitest/playwright/integration） | Week 2 |
| 加密 store / 连接管理 UI | Week 2 |
| TOFU 弹窗 UI | Week 3 |
| 拓扑图 | Week 4 |

### 2.4 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| Tauri 2 + workspace 路径解析卡住 | 30% | 中 | T1.1 最先验证；超 4h 立刻退回扁平 mod |
| sqlx 连 127.0.0.1:P 立刻断（listener 没准备好 accept） | 25% | 高 | T1.3 先确保 listener ready 再 sqlx 连 |
| russh 0.54 API 改动需要适配 | 5% | 低 | 复制即用，源码无修改预期 |

---

## 3. Week 2 — 测试基础设施 + MySqlDriver + 连接管理（目标 12h）

**目标**：测试套件一次架齐；`crates/db-driver` 有具体 `MySqlDriver`（**不抽 trait**）；UI 能创建/编辑/列表/删除不带 SSH 的纯本地连接，配置加密落盘。

### 3.1 任务

**T2.1 [3h] 测试基础设施一次架齐（不用 Docker）**
- Rust unit：`cargo test`，每 crate 自带 `tests/` 子模块
- Rust integration：`crates/db-driver/tests/integration.rs` 通过 `TINY_SQL_TEST_MYSQL_URL` env var 连**用户本地 MySQL 服务器**（不起 Docker）。本地跑：
  ```bash
  TINY_SQL_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/test cargo test -p db-driver
  ```
- 前端：`vitest` + `@testing-library/react`；`playwright`（Tauri 2 模式）**已推迟**（见 ARCHITECTURE §10.3，仓库当前无 playwright 依赖）
- CI：unit + 前端单测。**CI 不跑 integration**（无 MySQL 服务器），README 写本地运行命令
- **MySQL 5.7 兼容验证推到 Week 5 dogfooding**（找一位用 5.7 的同事验证），不进 CI 矩阵

**T2.2 [3.5h] crates/db-driver — 具体 struct MySqlDriver（不抽 trait）**
- v0.1 **不写 `trait Driver`**——直接写具体 `struct MySqlDriver`，方法返回具体类型。v0.2 加 PG 时用 rust-analyzer extract trait（两个实现在手才设计接口，避免抽象提前）
- 方法：`connect / list_databases / list_tables / list_columns / query / cancel`，签名见 [ARCHITECTURE.md §3.2](./ARCHITECTURE.md#32-crates-db-driver)
- 内部用 `sqlx::MySqlPool`（max_connections = 5）
- 单测：连用户本地 MySQL 跑 `SELECT 1` + 列 schema

**T2.3 [2h] tauri commands — connection_* 系列**
- `connection_create / connection_list / connection_update / connection_delete / connection_test`（FR-002）
- payload schema 见 [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-前后端事件契约)

**T2.4 [1.5h] 加密 store**
- 复用 `redis-desktop-client/src-tauri/src/config/encryption.rs`
- AES-GCM 256 + master key 文件（`chmod 0o600`）+ 落盘到 `~/Library/Application Support/tiny-sql/connections.enc`
- **v0.1 加密的是连接配置（host/port/user/password/SshHop[]）；passphrase 不落盘，仅会话内存**
- 单测：encrypt → decrypt round-trip + 错误密钥解密失败 + master key 损坏报错

**T2.5 [2h] 前端 — 连接列表 + 编辑对话框（无 SSH 部分）**
- 左侧抽屉式连接列表
- "新建连接" → 对话框 → name/host/port/user/password/database
- "测试连接"调 `connection_test`，loading + toast

### 3.2 验收点

- [ ] `cargo test` + `pnpm test` 本地全绿，CI unit + 前端单测跑通（playwright 已推迟，见 ARCHITECTURE §10.3）
- [ ] integration test 连用户本地 MySQL 跑通
- [ ] UI 能创建 → 列出 → 编辑 → 删除 → 测试连接
- [ ] `connections.enc` 看不到明文 host/user
- [ ] **CP-2 25h 累计检查**

### 3.3 Week 2 末检查点（CP-2，critical）

| 累计投入 | 决策 |
|---|---|
| **≤ 25h** | 按计划继续 Week 3 |
| **25-30h** | 黄灯：砍 Week 4 拓扑图细节（节点状态简化为 connected/failed 两态，不做 lost 闪烁；保留 hop_index 错误归因） |
| **> 30h** | 红灯：v0.1 整体从 5-6 周拉到 7-8 周；或砍 FR-015 拓扑图（仅保留 hop 文字列表 + 状态徽章） |

判定原则：**不要为了赶时间砍 FR-013（hop_index 归因）和 FR-014（keepalive）**，这俩是叙事核心。

### 3.4 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 具体 struct 后期加 PG 要 refactor commands 调用点 | 25% | 低 | 已知 trade-off；extract trait 是 rust-analyzer 一键操作 |
| 加密 store 复用遇密钥派生问题 | 10% | 低 | redis-desktop-client 已稳定；遇问题直接复制实现 |

---

## 4. Week 3 — 多跳 SSH + keepalive + 错误模型 + 表浏览（目标 13h）

**目标**：连接面板能配 3 跳 SSH，TOFU 弹窗能确认，keepalive 能感知断开，错误能归因到具体 hop，连接成功后能浏览 schema/table。

### 4.1 任务

**T3.1 [2.5h] 单跳 → 3 跳 SSH + 桥接**
- 把 Week 1 的单跳隧道扩成 N 跳（逐跳 SSH session + direct-tcpip channel 嵌套，见 [ARCHITECTURE.md §4](./ARCHITECTURE.md#4-ssh-多跳隧道详解)）
- `MySqlDriver` 接隧道：隧道暴露本地端口 → sqlx URL（Week 1 已验证模式）
- SshTunnel handle 与 MySqlPool 绑定生命周期：tunnel drop → pool drop

**T3.2 [2.5h] SSH keepalive（FR-014 核心）**
- 每跳 russh session 配置 `keepalive_interval=60s`、`keepalive_max=2`，由 russh 在第 3 次未响应时结束 session；另起轻量监控 task 探测 session 是否退出
- **连续 3 次未响应（≈180s）才判定断开**，监控 task emit `ssh:hop-status` payload `{status: "lost", reason}`，避免弱网/bastion ratelimit 误报
- keepalive 间隔 + 失败阈值留为常量（v0.2 做成可配置）
- `SshTunnel` 的 Drop 里 abort 所有 keepalive task（避免 leak）

**T3.3 [1.5h] SshTunnelError 三个 mid-session 变体（FR-013）**
- 现有 10 个变体补 `hop_index: usize`（每个能定位哪一跳）
- 新增三件 mid-session 变体，各有独立 i18n key：
  - `TunnelLost { hop_index, reason }` → `error.ssh.tunnel_lost`（keepalive 超时）
  - `ChannelDropped { hop_index }` → `error.ssh.channel_dropped`（对端主动关 channel，可能是跳板重启）
  - `AcceptLoopDied { hop_index }` → `error.ssh.accept_loop_died`（accept loop panic，代码 bug 需上报）
- 三种 failure mode 重试策略独立
- **实际状态**：三个错误变体与 i18n key 已落地；当前运行路径只上报 keepalive `lost`，尚未主动构造 `ChannelDropped` / `AcceptLoopDied`。

**T3.4 [2h] TOFU 流程接通**
- 后端：`KnownHostsValidator` emit `ssh:tofu-request`（复用代码）
- 前端：抄 redis-desktop-client `ssh-tofu-dialog.tsx`
- 回传：`ssh_tofu_decision(connection_id, hop_index, accept)`，120s 超时后端已实现

**T3.5 [2.5h] 前端 — SSH 多跳配置表单**
- 连接编辑对话框加"SSH 跳板"折叠区
- SshHop 数组编辑器：动态加减、调顺序
- 单 hop：host/port/username/auth_type（password|privateKey）/password?/private_key_path?（路径文本输入）；passphrase 不属于持久化 hop，而是在 `connection_open` 时按 connection_id 传入并缓存于本会话

**T3.6 [2h] 前端 — schema/table 左侧树 + 1000 行表格**
- 连接成功 → `list_databases` → 点 schema → `list_tables`（v0.1 无搜索，FR-020 小库假设）
- 点 table → `SELECT * FROM ${db}.${table}`（走 Week 4 的顶层安全追加 LIMIT）
- react-virtuoso 虚拟滚动表格（抄 redis-desktop-client）

### 4.2 验收点

- [ ] 配 3 跳 SSH + MySQL 能连通（FR-001 / FR-010）
- [ ] passphrase 私钥首次弹窗，本会话第二次静默（FR-011）
- [ ] TOFU 首次弹窗，已信任静默；指纹被改硬拒绝（FR-012）
- [ ] 任意一跳故意填错，错误归因到具体 hop_index（FR-013）
- [ ] 故意 kill 第 2 跳 sshd，**180s 内** hop[1] 变 lost（FR-014）
- [ ] 左侧 db/table 树正确展示，点 table 看到前 1000 行

### 4.3 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| keepalive 在某些 SSH server 上不响应 | 20% | 中 | 60s 间隔 + 3 次阈值已留缓冲；v0.2 做成可配置 |
| keepalive task leak（drop 后没 abort） | 25% | 中 | 单测：建隧道 → drop → 验证 task count 回零 |
| TOFU 120s 超时与前端弹窗 unmount 竞态 | 15% | 中 | 复制 redis-desktop-client 已验证实现 |

---

## 5. Week 4 — SQL 执行 + 拓扑图 + .dmg（目标 13h）

**目标**：SQL 执行带顶层安全追加 LIMIT 防 OOM + KILL QUERY 取消；拓扑图能画能高亮；macOS .dmg 能 build；本周末进入 dogfooding。

### 5.1 任务

**T4.1 [2.5h] SQL 执行 — 顶层安全追加 LIMIT 防 OOM（FR-021/022）**
- v0.1 **拒多语句**（当前用自有 SQL 分析 / 分号状态机，未引入 sqlparser-rs），只允许单条 SELECT
- LIMIT 防护**用顶层安全追加，不用 regex 检测**：顶层（括号深度 0）无 `LIMIT / FOR / LOCK / INTO / PROCEDURE` 时在末尾换行追加 `LIMIT <rowLimit + 1>`（用户手写 LIMIT 5 时取小意图一致）；顶层已含这些子句时保持原样靠客户端截断。**注意：最终实现不做 derived table 包装**（`SELECT * FROM (...) AS tiny_sql_limited` 在多表 JOIN 重名列触发 1060，实际改为直接追加 LIMIT）
- 后端 sqlx stream 流式取 + `rowLimit` clamp 到 100000；表浏览用 1000，SQL 编辑器用 100000，超出返回 truncated 提示

**T4.2 [2h] SQL 取消 — 独立 control pool + KILL QUERY（FR-023）**
- MySqlDriver 在主 MySqlPool 外额外起一个 max=1 的 **control pool**（同一连接参数独立连接池；早期设计"独立本地端口"未实现）
- cancel 时从 control pool 发 `KILL QUERY <connection_id>`，主 pool 满时 KILL 仍能发出
- 前端取消按钮 → cancel token 触发 + control pool KILL 服务端 query
- 只读保护按**首 token 白名单分类**（SELECT/WITH 读、SHOW/EXPLAIN/DESC/DESCRIBE 元数据免确认、其余一律需 allow_write），前后端同一套规则，弹确认对话框（FR-024，注意 best-effort 语义见 REQUIREMENTS）

**T4.3 [3h] 纯 CSS 拓扑图组件（FR-015）**
- 固定线性布局画 N+2 节点（本地 / hop[0..N-1] / MySQL）
- 节点包含标题、状态徽章（pending/connected/failed/lost）和 host:port 副文本
- 边用 CSS 直线表达连接状态；**不实现** v0.2 的实时延迟动画

**T4.4 [2.5h] ssh:hop-status event 接线 + 错误高亮**
- 后端每跳不同阶段 emit `ssh:hop-status` `{connection_id, hop_index, status}`（status ∈ pending/connected/failed/lost，**v0.1 无 latency_ms**）
- 前端 subscribe → zustand 更新 → 拓扑节点 reactive 重渲染
- status=failed/lost 节点红边 + tooltip 用 `i18n.t(error.i18n_key)`，全部 SshTunnelError 变体（含三件 mid-session）有 zh-CN 翻译

**T4.5 [1.5h] 全平台桌面包 build**
- GitHub Actions release job：`v*` tag 触发 → macOS arm64/x64、Windows x64、Linux x64 原生 runner 分别构建 → 单独 release job 上传；正式版同时生成 `latest.json`
- 流水线已由 v0.0.3 成功验证；v0.1 仍需 RC 下载后的真实安装验收

**T4.6 [1.5h] CP-4 dogfooding 准入自查（见 §5.3）**

### 5.2 验收点

- [ ] SQL 执行：顶层安全追加 LIMIT 生效，手写 LIMIT 与外层取小，10w 截断提示
- [ ] 长查询取消：control pool KILL QUERY 发出，`SHOW PROCESSLIST` 中 query 消失
- [ ] 只读保护：UPDATE/DELETE 命中弹确认，SHOW/EXPLAIN/DESC 直接执行
- [ ] 拓扑图按"本地 → hop[..] → MySQL"画对，节点状态实时变化
- [ ] tag `v0.1.0-rc1` 后 GitHub Releases 出现 macOS / Windows / Linux 桌面安装包
- [x] **CP-4 dogfooding 准入**

### 5.3 Week 4 末检查点（CP-4，dogfooding 准入）

- [x] 应用稳定运行 ≥ 30 分钟不 crash
- [x] 连接失败有明确错误消息（不是 panic / 纯英文 stack trace）
- [x] 本地 build .dmg 能在另一台 Mac 跑起来
- [x] 已自测 ≥ 10 个不同 SQL（含 SELECT/JOIN/聚合）
- [x] 隧道断开能感知（FR-014 实测，180s 内）

**若不通过**：Week 5 推迟 1 周，Week 6 缓冲挪到 Week 5。

### 5.4 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| control pool 也走隧道，隧道卡死时 cancel 同样卡 | 20% | 中 | cancel 加超时；超时后前端仍结束等待 |
| 子查询包装语义微变的担忧已消除（改为顶层直接追加 LIMIT） | 10% | 低 | 顶层已含 LIMIT/FOR/LOCK/INTO/PROCEDURE 时不追加，靠客户端截断；单测覆盖 JOIN 重名列不包装 |
| 拓扑节点过多时横向溢出 | 10% | 低 | 当前线性布局支持横向滚动；v0.1 测试到 3 跳 |
| macOS Intel build crash（cross arch） | 15% | 高 | 矩阵原生 build，不 cross-compile |

---

## 6. Week 5 — dogfooding + 打磨 + 发布（目标 13h）

**目标**：作者 + 2 同事用 ≥ 1 周；修关键 bug；MySQL 5.7 兼容在此验证；README 与 GIF 就绪；tag v0.1.0。

### 6.1 任务

**T5.1 [自然 1 周，约 5h dev]** 作者自用，每次问题写一行 `docs/dogfooding-log.md`（不公开）。优先级：crash/数据错 > 连接失败 > UX 别扭 > 美化

**T5.2 [自然 1 周，约 0 dev]** 同事试用：找 2 位同事发对应系统安装包，配自己的 3 跳生产环境用 1 周，每人 ≥ 5 条反馈。**其中 1 位用 MySQL 5.7 验证 caching_sha2 兼容（CP-3 在此完成，非 CI）**

**T5.3 [4h] 修 critical bug**：仅修 dogfooding 暴露的 P0/P1，P2 推 v0.1.1

**T5.4 [2h] README + GIF**：顶部"右键打开"GIF；中部核心卖点 GIF（3 跳隧道 + 拓扑图 + 故意挂第 2 跳变红）；中文 README 为主，英文留 placeholder

**T5.5 [2h] 发布**：CHANGELOG 0.1.0 → bump version → tag v0.1.0 push → CI 出全平台桌面安装包 → GitHub Releases → Discussions 发帖

### 6.2 验收点

- [x] 作者 + 2 同事用 ≥ 1 周，0 数据丢失，0 不可恢复 crash（FR-041）
- [x] **CP-3**：MySQL 5.7 在同事环境验证通过
- [ ] README 含右键打开 GIF + 3 跳隧道 GIF
- [ ] tag v0.1.0 发布成功，下载的 macOS / Windows / Linux 安装包能跑

### 6.3 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 同事生产环境暴露未测的 SSH 配置（密码+key 混用 / GSSAPI） | 40% | 中 | 不在 v0.1 范围的认证方式直接拒绝并记 v0.2 |
| MySQL 5.7 caching_sha2 在老账号握手失败 | 15% | 高 | CP-3 在此验证；失败查 sqlx issue / 最坏 5.7 用 mysql_native_password 账号 |
| dogfooding 暴露 P0 bug 修不完 | 30% | 高 | Week 6 缓冲承接 |

---

## 7. Week 6 — 缓冲（目标 10h）

**用途**（按优先级）：1) 溢出工量承接 2) P0 bug 修复 3) 文档完善（ARCHITECTURE 细节 / 注释翻译）4) v0.2 预研（PG driver 摸底 / 实时延迟动画原型 / passphrase 加密 store）。若 Week 1-5 全部按时且 dogfooding 顺畅，全部投入 v0.2 预研。

---

## 8. Week 7 — launch 活动（不计 dev 工量）

V2EX + 掘金发帖（中文开发者）；HN 留 v0.2 多平台 + 英文 README 时；6 秒核心 GIF（多跳拓扑 + 挂第 2 跳变红）；24h 内首次回应评论与 issue。

---

## 9. 风险与缓解汇总

### 9.1 影响 ship 的风险（红灯）

| 风险 ID | 描述 | 概率 | 影响 | 触发条件 | 应对 |
|---|---|---|---|---|---|
| R-001 | Tauri+workspace 摩擦超 8h | 30% | 高 | Week 1 T1.1 验证失败 | 立刻退回扁平 mod 方案 |
| R-002 | caching_sha2_password 握手挂 | 15% | 高 | Week 5 CP-3 验证失败 | 升级 sqlx 0.8.x patch / 上游 issue / 最坏 5.7 用 native_password 账号 |
| R-003 | dogfooding 暴露 P0 数据 corruption | 5% | 极高 | Week 5 同事报告 | 立刻撤回 Release，根因分析后再发 |
| R-004 | 时间预算超 75h | 35% | 中 | 累计 Week 4 末 > 55h | Week 5 砍 FR-015 拓扑美化，保 FR-013/014 核心 |
| R-005 | macOS Intel build crash | 15% | 高 | Week 4 T4.5 验证 | 矩阵原生 build，不 cross-compile |
| R-006 | Week 1 vertical slice 没闭环就开 Week 2 | 20% | 高 | Week 1 末 SELECT 1 跑不通 | 不达成 CP-1 + SELECT 1 闭环，Week 2 不开工 |

### 9.2 不影响 ship 的风险（黄灯）

| 风险 ID | 描述 | 应对 |
|---|---|---|
| R-010 | 同事环境暴露 v0.1 未覆盖的 SSH 配置 | 拒绝并记 v0.2 |
| R-011 | 拓扑节点过多导致布局拥挤 | v0.1 测试到 3 跳；超长链路先横向滚动，v0.2 再评估折叠视图 |
| R-012 | 大表浏览卡顿 | 表浏览 `rowLimit=1000` + 顶层安全追加 LIMIT 已护栏 |
| R-013 | 同事不会"右键打开" | README GIF + 群消息教学 |
| R-014 | read-only 首 token 白名单只是 best-effort，`SELECT func_that_writes()` 等绕过 | 文案明示建议用只读账号（见 REQUIREMENTS FR-024）；v0.2 不强化 |

### 9.3 v0.2 待定项（codex review surface，实施期决定）

- KILL QUERY 取消 UI 是否细化为 4 状态（cancel_requested/killed/already_finished/failed）——v0.1 先 2 状态（requested/done），视 dogfooding 反馈决定
- SshTunnelError 三变体是否在 v0.2 重构为统一连接状态机（connecting/connected/degraded/reconnecting/lost/closed）——视 i18n key 是否膨胀决定

### 9.4 应对决策原则

- **保 ship 卖点**：FR-013（hop_index 归因）+ FR-014（keepalive lost 感知）是叙事核心，任何情况下不砍
- **可砍的**：FR-015 拓扑美化 / FR-026 连接池（降级单连接）/ FR-022 10w 截断（降级 1w）
- **必须当周决定**：每周末根据累计工时 + 进度判定降级，不拖到下周

---

## 10. 进度跟踪建议

### 10.1 周日 dev log

每周日发一篇简短 dev log（GitHub Discussion / 个人博客）：

```
# tiny-sql Week N 进度
本周完成：[x] T_.1 ... / [ ] T_.3 推迟
实际工时：12.5h（计划 12h）｜累计：26h / 60-75h
下周计划：T_.1 / T_.2
遇到的问题：问题 + 解决方式
```

目的：自我问责 / 同步同事 dogfooding 时间 / v0.2 复盘材料。

### 10.2 GitHub Project Board

Kanban：Backlog（v0.2）/ Week N / In Progress / Done。每个 task 关联 [REQUIREMENTS.md](./REQUIREMENTS.md) 的 FR ID。

### 10.3 commit 节奏

一个 task 一个 PR；PR 描述带 task ID + FR 链接；merge 前自己看一遍 diff。

---

## 11. 检查点机制汇总

| 检查点 | 时机 | 通过标准 | 不通过的应对 |
|---|---|---|---|
| **CP-1** Tauri+workspace 摩擦验证 | Week 1 T1.1 | `cargo tauri build` 成功 | 退回扁平 mod 方案 |
| **CP-1b** vertical slice 闭环 | Week 1 末 | 单跳 SSH → SELECT 1 → 前端显示成功 | Week 2 不开工，先打通 |
| **CP-2** 25h 累计工时检查 | Week 2 末 | ≤ 25h | 砍 FR-015 拓扑图细节 |
| **CP-3** MySQL 5.7 兼容验证 | Week 5 dogfooding | 同事 5.7 环境 SELECT 通过 | 升级 sqlx patch / native_password 账号 |
| **CP-4** dogfooding 准入 | Week 4 末 | 30 分钟不 crash + 错误消息可读 | Week 5 推迟 1 周 |
| **CP-5** 75h 上限 | Week 5 末 | ≤ 75h | Week 6 缓冲承接；Week 7 launch 延后 |
| **CP-6** dogfooding 验收 | Week 5 末 | 3 人 1 周 0 数据丢失 | 撤回 release，根因分析 |

---

## 12. eng-review 9 个 binding 决策落地表

本计划完全遵循[设计文档](/Users/kurisu/.gstack/projects/tiny-sql/kurisu-main-design-20260626-162200.md)及其 `/plan-eng-review 决策附录`。9 条决策在本计划的落地位置：

| # | 决策 | 落地位置 |
|---|---|---|
| 1 | keepalive 30s→60s + 3 次失败阈值（180s） | T3.2 / FR-014 / 验收"180s 内" |
| 2 | SQL 取消独立 control pool + KILL QUERY | T4.2 / FR-023 |
| 3 | SshTunnelError 加 ChannelDropped + AcceptLoopDied | T3.3 / FR-013 |
| 4 | trait Driver 推 v0.2，v0.1 具体 struct | T2.2 / ROADMAP v0.2 |
| 5 | 测试基础设施一次架齐（无 Docker，本地 MySQL） | T2.1 |
| 6 | sqlx 大结果集顶层安全追加 LIMIT（不用 regex；不用 derived table 包装） | T4.1 / FR-021 |
| 7 | **Week 1 改 vertical slice** | §2 整段重排 |
| 8 | read-only SQL best-effort（建议只读账号） | T4.2 / FR-024 / R-014 |
| 9 | Codex 4 条 tension surface（KILL 4 状态 / 状态机 / read-only / crate） | §9.3 / R-006 / R-014 |

---

## 13. v0.2 开发计划

**周期与预算**：8 周，约 96-100h（当前拆分约 98h）。

**定位**：v0.2 不是在 v0.1 上平铺功能，而是先把单一 MySQL 实现演进成稳定的多 driver 架构，再交付 PostgreSQL、凭据安全、TLS 验收、schema intelligence、查询工作台和 SSH 可观测性增强。完整范围以 [ROADMAP v0.2](./ROADMAP.md#v02--首发后-2-3-个月) 为准。

### 13.1 Phase 0：补发 v0.1 与启动准入

Phase 0 不计入 v0.2 的 8 周开发预算。现有实现与 dogfooding 验收不重做；先补发一个 v0.1 正式版，完成后即可进入 v0.2 Week 1：

- [x] §2.2 vertical slice、CP-3/CP-4/CP-5/CP-6、作者与同事试用已验收。
- [ ] `connection_test` passphrase、ChannelDropped / AcceptLoopDied 和查询错误契约等 v0.1 承诺缺口已补齐或正式降级。
- [ ] README 真实 GIF、`CHANGELOG.md` v0.1.0 段和版本号已收口。
- [ ] 推送 `v0.1.0` tag；全平台安装包、签名更新包、`latest.json` 与应用内更新链路完成真实验收。
- [ ] PostgreSQL 最低支持版本与测试版本矩阵已记录到 `techContext.md`；本地测试继续不依赖 Docker。

发布后的社区反馈量和稳定运行时长继续记录，用于调整 v0.2 的 P2 优先级，但不再作为 Week 1 的硬阻塞条件。

v0.2 必须交付全部 P0/P1。FR-107 / FR-108 / FR-109 / FR-111 等 P2 若超过时间预算，可整体推到 v0.2.1，不得挤压 PostgreSQL、凭据安全、TLS、schema-aware、RTT、重连、column 树和 SQL 历史。

明确不进入 v0.2：安全表格编辑、对象设计、CSV 导入、SQL dump、备份同步、用户权限和 ER/BI/AI；这些分别留在 v0.3-v0.5+。

### 13.2 时间线与依赖顺序

```text
Phase 0  前置  补发 v0.1.0 + 安装/更新验收（不计入 8 周）
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
4. 用户主密码与存储迁移 → passphrase 持久化；安全迁移失败时不能覆盖原文件。
5. RTT 探测语义与连接状态机决策 → 重连按钮和拓扑动画，避免先做 UI 再返工事件契约。

### 13.3 分周任务与验收

#### v0.2 Week 1 — Driver 契约与 PostgreSQL vertical slice（12h）

- **V2-T1.1 [4h]** 从现有 `MySqlDriver` 的真实调用面提取最小 `Driver` 契约；共享类型只包含 connect/ping、metadata、query、cancel、close，不提前抽象 v0.3 对象编辑能力。
- **V2-T1.2 [3h]** 给连接配置增加显式 `driver` 类型并设计向后兼容迁移：旧记录缺字段时默认 MySQL；迁移失败保留原加密文件。
- **V2-T1.3 [3h]** 增加 PostgreSQL 最窄 vertical slice：直连 → `SELECT 1` → 稳定 i18n key；SSH 仍复用通用 TCP 隧道，不在 `ssh-multihop` 引入数据库依赖。
- **V2-T1.4 [2h]** MySQL 全量单测 / integration 回归，确认 extract trait 没有改变 SQL guard、LIMIT、取消与连接行为。

验收：MySQL 现有测试全绿；PostgreSQL `SELECT 1` 通过；旧 `connections.enc` 无损读取；**V2-CP1** 通过后才进入 Week 2。

#### v0.2 Week 2 — PostgreSQL 后端闭环（13h）

- **V2-T2.1 [5h]** 实现 PostgreSQL database/schema/table/column metadata；不得把 MySQL 的 database/schema 同义模型硬套到 PostgreSQL。
- **V2-T2.2 [4h]** 实现 PostgreSQL query、结果解码、行数上限与取消；标识符引用、SQL dialect、连接取消机制按 PostgreSQL 独立实现。
- **V2-T2.3 [2h]** 增加 `TINY_SQL_TEST_POSTGRES_URL` integration 测试，与 MySQL 一样连接用户本地数据库，不起 Docker。
- **V2-T2.4 [2h]** 为 MySQL/PostgreSQL 共用错误定义稳定 i18n key，原始 driver 错误只进入脱敏日志或结构化安全字段。

验收：两个 driver 均通过 ping、metadata、SELECT、写确认、取消与 NULL/日期/数值/JSON 基本解码。

#### v0.2 Week 3 — 多 driver 应用接线（12h）

- **V2-T3.1 [4h]** `AppState` 活跃连接注册表从具体 `MySqlDriver` 改为多 driver 容器；隧道生命周期继续由 `OpenConnection` 持有。
- **V2-T3.2 [3h]** 泛化 Tauri commands 与前端 API，但保留稳定 command 名和错误 key，避免无必要的大规模 IPC 改名。
- **V2-T3.3 [3h]** 连接表单增加数据库类型和 PostgreSQL 参数；schema 树按 driver 语义展示 database/schema，不伪造不存在的层级。
- **V2-T3.4 [2h]** 真实验证 MySQL 与 PostgreSQL 的直连、1 跳 SSH 和连接切换；3 跳 PostgreSQL 留 Week 8 dogfooding。

验收：同一应用能保存并分别打开 MySQL/PostgreSQL；关闭、切换、取消不会串 driver；**V2-CP2** 双 driver 端到端闭环。

#### v0.2 Week 4 — 凭据安全与 TLS（13h）

- **V2-T4.1 [5h]** 设计用户主密码派生密钥与 passphrase 加密格式；新 KDF / secret 依赖须先做安全和 license 审计，不自创密码算法。
- **V2-T4.2 [3h]** 实现旧连接文件到新格式的可恢复迁移、锁定/解锁 UX、错误密码与忘记主密码路径；迁移采用临时文件 + 原子替换。
- **V2-T4.3 [3h]** 在真实 TLS MySQL 上验收 Preferred / Required / Verify CA / Verify Identity 及双向证书，补证书文件选择与可行动错误提示。
- **V2-T4.4 [2h]** 安全测试：passphrase 不出现在明文文件、日志、崩溃信息和导出内容；旧文件迁移失败可原样恢复。

验收：重启后可用主密码解锁 passphrase；错误主密码不会破坏数据；真实 TLS 正反例通过；**V2-CP3** 安全迁移门槛通过。

#### v0.2 Week 5 — Schema intelligence（13h）

- **V2-T5.1 [3h]** 前端接入现有 `db_list_columns`，展示列类型、nullable、key、default 与 comment（FR-112）。
- **V2-T5.2 [3h]** 增加按 connection/driver/schema 分区的 LRU metadata cache、刷新与失效策略（FR-108），切换连接不得串缓存。
- **V2-T5.3 [5h]** CodeMirror 补全从 database/table 扩展到 column、alias 与 JOIN 候选；MySQL/PostgreSQL 各自使用正确 dialect（FR-104）。
- **V2-T5.4 [2h]** 大 schema 性能与并发请求回归，旧请求不得覆盖新选中 schema。

验收：常用列补全无需手写；DDL/手动刷新后 cache 可失效；大 schema 不阻塞 UI；MySQL/PostgreSQL 补全结果不串库。

#### v0.2 Week 6 — 查询工作台（13h）

- **V2-T6.1 [3h]** SQL 历史最近 100 条，记录 driver/connection/schema/时间/成功状态；SQL 可能含敏感字面量，必须加密落盘并支持清空（FR-106）。
- **V2-T6.2 [4h]** 多查询 tab：每 tab 独立 SQL、结果、query_id、取消 token、driver/schema 与 dirty state；关闭运行中 tab 必须先确认（FR-109）。
- **V2-T6.3 [3h]** CSV / Excel 导出从后端流式写文件，区分 SQL NULL 与空字符串，避免复制 10 万行到前端再序列化（FR-107）。
- **V2-T6.4 [2h]** 结果列宽拖拽、恢复默认与持久化（FR-111）。
- **V2-T6.5 [1h]** 并发 tab 取消回归：取消 A 不能终止 B；关闭连接时全部 query 有明确终态。

验收：历史加密且可清除；至少 3 个 tab 并发互不污染；大结果导出内存稳定；**V2-CP4** 查询工作台通过。

#### v0.2 Week 7 — SSH 可观测性与连接恢复（10h）

- **V2-T7.1 [3h]** 先定义 RTT 测量对象和噪声边界（SSH request / channel 探测，不冒充 ICMP）；拓扑显示采样值与超时状态（FR-105）。
- **V2-T7.2 [3h]** 增加重连按钮与幂等连接恢复，重连前清理旧 pool、tunnel、query 和状态订阅（FR-110）。
- **V2-T7.3 [2h]** 把 keepalive 间隔和失败阈值接到高级配置，保持 60s / 3 次为默认值。
- **V2-T7.4 [2h]** 根据 v0.1 反馈决定 KILL QUERY 四状态与 SSH 统一状态机是否实施；没有证据就保留现有公共契约，不为重构而重构。

验收：断开中间跳后能看到 lost 并成功重连；RTT 不阻塞连接主链路；配置重启后生效；无旧 task / event 泄漏。

#### v0.2 Week 8 — Dogfooding 与发布（12h）

- **V2-T8.1 [4h]** MySQL/PostgreSQL 各完成直连、1 跳与真实 3 跳回归；覆盖 metadata、查询、取消、历史、tab、导出、TLS 与重连。
- **V2-T8.2 [3h]** 作者 + 至少 2 位试用者使用 v0.2 RC ≥ 1 周；至少 1 人以 PostgreSQL 为主，0 数据丢失、0 凭据泄露、0 不可恢复 crash。
- **V2-T8.3 [3h]** 更新 ARCHITECTURE 的多 driver / 加密格式章节，补英文 README 与 CONTRIBUTING；新增 v0.2 Release Checklist。
- **V2-T8.4 [2h]** `just check`、双 driver integration、本机安装包、全平台 RC 下载验收；P0/P1 清零后才切 CHANGELOG 并发布 v0.2.0。

验收：**V2-CP5** 发布门槛全部通过；P2 未完成项明确移入 v0.2.1，不得在 Release notes 中虚假承诺。

### 13.4 v0.2 检查点与降级规则

| 检查点 | 时机 | 通过标准 | 不通过的应对 |
|---|---|---|---|
| **V2-CP0** 启动准入 | 开工前 | §13.1 的 v0.1 补发与 PostgreSQL 版本基线全部完成 | 继续收口 v0.1，不创建 v0.2 功能分支 |
| **V2-CP1** Driver 抽象 | Week 1 末 | MySQL 零回归 + PostgreSQL SELECT 1 + 配置迁移通过 | 收窄 trait；不得继续铺 PG 全功能 |
| **V2-CP2** 双 driver 闭环 | Week 3 末 | 两 driver connect/metadata/query/cancel/UI 可用 | Week 4 延后，先修状态与 dialect 边界 |
| **V2-CP3** 安全迁移 | Week 4 末 | 旧配置无损、错误密码不破坏文件、真实 TLS 通过 | 停止发布；保留会话 passphrase，不强推持久化 |
| **V2-CP4** 查询工作台 | Week 6 末 | history/tab/export 隔离正确，无明显内存回归 | P2 整体推 v0.2.1，保 P1 SQL 历史 |
| **V2-CP5** 发布 | Week 8 末 | 双 driver dogfood + P0/P1 清零 + RC 安装通过 | 延后正式版，不降低凭据与数据安全标准 |

范围超时时按以下顺序降级：FR-111 列宽 → FR-108 LRU cache → FR-107 Excel（保 CSV）→ FR-109 多 tab。FR-100/102/103/104/105/106/110/112 不降级；如果它们未完成，版本继续延期。

### 13.5 测试矩阵

- **静态质量**：每组改动至少跑 `just lint`；合并前跑 `just check`。
- **driver integration**：`TINY_SQL_TEST_MYSQL_URL` + `TINY_SQL_TEST_POSTGRES_URL`，均连接用户本地实例，不引入 Docker；CI 继续只跑无外部数据库的单元测试。
- **兼容回归**：MySQL 5.7 / 8.x 与 PostgreSQL 的最低支持版本 / 最新稳定版本；具体版本在启动时固化到 `techContext.md`。
- **隧道矩阵**：MySQL/PostgreSQL × 0/1/3 跳；认证覆盖密码、无口令私钥、带口令私钥。
- **安全矩阵**：旧加密文件迁移、错误主密码、损坏文件、TLS CA/hostname/客户端证书正反例、历史与 passphrase 明文扫描。
- **并发矩阵**：多 tab 同时查询、分别取消、连接关闭、重连、cache 切换和大结果导出。

### 13.6 主要风险

| 风险 ID | 描述 | 影响 | 缓解 |
|---|---|---|---|
| V2-R01 | 为 PostgreSQL 过度抽象 Driver，反而破坏 MySQL | 高 | 只从现有调用面 extract；Week 1 设零回归门槛 |
| V2-R02 | MySQL database 与 PostgreSQL schema 语义混淆 | 高 | 公共模型显式表达层级；driver 负责 dialect 和引用规则 |
| V2-R03 | 用户主密码迁移失败导致连接配置不可恢复 | 极高 | 临时文件 + 原子替换 + 原文件备份；失败不覆盖 |
| V2-R04 | SQL 历史或导出意外泄露敏感字面量 | 高 | 历史加密、显式清空、导出由用户选择路径、日志不记录 SQL 全文 |
| V2-R05 | 多 tab 的 query_id / cancel token 串线 | 高 | tab-local state + 并发单测；关闭连接统一收敛终态 |
| V2-R06 | RTT 数字被误解为真实网络 ICMP 延迟 | 中 | 文案标注 SSH 探测 RTT；采样失败不改变连接状态 |
| V2-R07 | 8 周范围再次膨胀 | 中 | Week 6 按 §13.4 降级 P2；禁止提前做 v0.3 数据编辑 |

---

## 附录 A：每周快速 checklist

### Week 1（vertical slice）
- [x] **CP-1** Tauri+workspace 摩擦验证（最先做）
- [x] 单跳 SSH 隧道实现
- [x] sqlx 桥接 SELECT 1
- [x] Next.js 前端骨架
- [x] tauri.conf + CI
- [x] **CP-1b** 端到端闭环

### Week 2（测试 + driver + 连接管理）
- [x] 测试基础设施一次架齐（无 Docker）
- [x] 具体 struct MySqlDriver（不抽 trait）
- [x] connection_* commands
- [x] 加密 store（passphrase 不落盘）
- [x] 连接列表/编辑 UI
- [ ] **CP-2** 25h 累计检查

### Week 3（多跳 + keepalive + 错误模型）
- [x] 单跳 → N 跳实现（真实 3 跳已由 CP-4 验收）
- [x] russh keepalive 60s + 3 次阈值
- [x] SshTunnelError 三变体 + hop_index
- [x] TOFU 流程
- [x] SshHop 配置表单
- [x] schema/table 树 + 1000 行表格

### Week 4（SQL + 拓扑 + dmg）
- [x] 顶层安全追加 LIMIT 防 OOM + 拒多语句
- [x] control pool + KILL QUERY
- [x] 纯 CSS 拓扑图
- [x] ssh:hop-status + 错误高亮
- [x] macOS / Windows / Linux Release 构建链路（v0.0.3 已验证）
- [x] **CP-4** dogfooding 准入

### Week 5（dogfooding + 发布，当前阶段）
- [x] 作者自用 1 周
- [x] 2 同事试用 1 周（含 5.7 验证 CP-3）
- [x] 已知 P0 修复与真实 MySQL 回归（2026-07-13）
- [x] README 文字说明
- [ ] README 真实 GIF
- [ ] tag v0.1.0（远端 tag 与应用版本仍为 v0.0.3）
- [x] **CP-5** 75h 上限 / **CP-6** dogfooding 验收

### Week 6（缓冲）/ Week 7（launch）
- [x] 溢出承接 / v0.2 预研
- [x] V2EX + 掘金发帖
