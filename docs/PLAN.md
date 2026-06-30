---
title: tiny-sql 开发计划
version: 0.1.0-draft-2
status: draft
last_updated: 2026-06-26
---

# tiny-sql 开发计划

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md)
>
> **draft-2 变更**：本版按 `/plan-eng-review` 的 9 个 binding 决策重排。最大变化是 **Week 1 改为 vertical slice**（只证明端到端最小链路 work），keepalive/错误模型细分/测试基础设施/拓扑图全部下放到 Week 2-4。决策全表见 §12。

## 1. 时间线总览

v0.1 = **5-6 周 × 12-13 小时/周 = 60-75 小时**。Week 6 是缓冲、Week 7 是 launch 活动，不算 dev 工量。

```
Week 1   12h   vertical slice（workspace + 单跳 ssh + sqlx SELECT 1 + hello 页，端到端打通）
Week 2   12h   测试基础设施 + MySqlDriver（具体 struct）+ 加密 store + 连接管理 UI（无 SSH）
Week 3   13h   多跳 SSH + keepalive + 错误模型三变体 + TOFU + 表浏览
Week 4   13h   SQL 执行（子查询包装 + KILL QUERY）+ 拓扑图 + 错误高亮 + .dmg
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
- 跑 `cargo tauri build` 验证 workspace 成员引用能走通
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
- GitHub Actions：仅 macOS arm64，跑 `cargo check --workspace` + `cargo tauri build`
- 完整测试矩阵留 Week 2

**T1.6 [0.5h] 收尾**
- 确认 `cargo tauri dev` 启窗口 → 点按钮 → 单跳隧道 → SELECT 1 → 前端显示成功

### 2.2 验收点（vertical slice 闭环）

- [ ] **CP-1**：`cargo tauri build` 在 workspace 布局下成功（或已决定退回扁平 mod）
- [ ] `cargo tauri dev` 启窗口，点按钮经单跳 SSH 连上 MySQL，`SELECT 1` 返回
- [ ] 前端 hello 页显示"连接成功"
- [ ] GitHub Actions（仅 arm64 cargo check + build）跑通

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
- 前端：`vitest` + `@testing-library/react`；`playwright`（Tauri 2 模式）
- CI：unit + 前端单测 + playwright headless。**CI 不跑 integration**（无 MySQL 服务器），README 写本地运行命令
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

- [ ] `cargo test` + `pnpm test` + `pnpm e2e` 本地全绿，CI unit + 前端 + playwright 跑通
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
- 每跳起一个 `tokio::spawn` 循环：每 **60s** 调 `session.send_keepalive()`（russh 0.54）
- **连续 3 次失败（≈180s）才判定断开**，emit `ssh:hop-status` payload `{status: "lost", reason}`，避免弱网/bastion ratelimit 误报
- keepalive 间隔 + 失败阈值留为常量（v0.2 做成可配置）
- `SshTunnel` 的 Drop 里 abort 所有 keepalive task（避免 leak）

**T3.3 [1.5h] SshTunnelError 三个 mid-session 变体（FR-013）**
- 现有 10 个变体补 `hop_index: usize`（每个能定位哪一跳）
- 新增三件 mid-session 变体，各有独立 i18n key：
  - `TunnelLost { hop_index, reason }` → `error.ssh.tunnel_lost`（keepalive 超时）
  - `ChannelDropped { hop_index }` → `error.ssh.channel_dropped`（对端主动关 channel，可能是跳板重启）
  - `AcceptLoopDied { hop_index }` → `error.ssh.accept_loop_died`（accept loop panic，代码 bug 需上报）
- 三种 failure mode 重试策略独立

**T3.4 [2h] TOFU 流程接通**
- 后端：`KnownHostsValidator` emit `ssh:tofu-request`（复用代码）
- 前端：抄 redis-desktop-client `ssh-tofu-dialog.tsx`
- 回传：`ssh_tofu_decision(connection_id, hop_index, accept)`，120s 超时后端已实现

**T3.5 [2.5h] 前端 — SSH 多跳配置表单**
- 连接编辑对话框加"SSH 跳板"折叠区
- SshHop 数组编辑器：动态加减、调顺序
- 单 hop：host/port/username/auth_type（password|privateKey）/password?/private_key_path?（fs picker）/passphrase?（仅会话）

**T3.6 [2h] 前端 — schema/table 左侧树 + 1000 行表格**
- 连接成功 → `list_databases` → 点 schema → `list_tables`（v0.1 无搜索，FR-020 小库假设）
- 点 table → `SELECT * FROM ${db}.${table}`（走 Week 4 的子查询包装 LIMIT）
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

**目标**：SQL 执行带子查询包装防 OOM + KILL QUERY 取消；拓扑图能画能高亮；macOS .dmg 能 build；本周末进入 dogfooding。

### 5.1 任务

**T4.1 [2.5h] SQL 执行 — 子查询包装防 OOM（FR-021/022）**
- v0.1 **拒多语句**（用 sqlparser-rs 解析或分号拆解后拒绝），只允许单条 SELECT
- LIMIT 防护**用子查询包装，不用 regex 检测**：`SELECT * FROM (<user_sql>) AS tiny_sql_limited LIMIT 1000`（MySQL 原生语义，零误判；用户手写 LIMIT 5 装在内部，取小意图一致）
- 后端 `fetch_many` 流式取 + 客户端 `take(100000)` 硬上限，超出 toast 提示

**T4.2 [2h] SQL 取消 — 独立 control connection + KILL QUERY（FR-023）**
- MySqlDriver 在主 MySqlPool 外额外起一个 **control connection**（同一隧道、独立本地端口）
- cancel 时从 control conn 发 `KILL QUERY <connection_id>`，pool 满时 KILL 仍能发出
- 前端取消按钮 → tokio abort 客户端等待 + control conn KILL 服务端 query
- 只读保护正则（`DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|GRANT|CREATE|REPLACE`）保留作为低成本一道闸，弹确认对话框（FR-024，注意 best-effort 语义见 REQUIREMENTS）

**T4.3 [3h] react-flow 拓扑图组件（FR-015）**
- `@xyflow/react v12` 画 N+2 节点（本地 / hop[0..N-1] / MySQL）
- 自定义 node：标题 + 状态徽章（pending/connected/failed/lost）+ host:port 副文本
- 边默认 bezier，连接成功变绿；**不实现** v0.2 的实时延迟动画

**T4.4 [2.5h] ssh:hop-status event 接线 + 错误高亮**
- 后端每跳不同阶段 emit `ssh:hop-status` `{connection_id, hop_index, status, latency_ms?}`
- 前端 subscribe → zustand 更新 → 拓扑节点 reactive 重渲染
- status=failed/lost 节点红边 + tooltip 用 `i18n.t(error.i18n_key)`，全部 SshTunnelError 变体（含三件 mid-session）有 zh-CN 翻译

**T4.5 [1.5h] macOS .dmg build**
- GitHub Actions release job：tag `v0.1.*` 触发 → `cargo tauri build` 出 .dmg → `gh release create` 上传
- 本地验证：.dmg 在另一台 Mac 右键打开 → 运行

**T4.6 [1.5h] CP-4 dogfooding 准入自查（见 §5.3）**

### 5.2 验收点

- [ ] SQL 执行：子查询包装生效，手写 LIMIT 与外层取小，10w 截断提示
- [ ] 长查询取消：control conn KILL QUERY 发出，`SHOW PROCESSLIST` 中 query 消失
- [ ] 只读保护：DROP/DELETE/UPDATE 命中弹确认
- [ ] 拓扑图按"本地 → hop[..] → MySQL"画对，节点状态实时变化
- [ ] tag `v0.1.0-rc1` 后 GitHub Releases 出现 macOS / Windows / Linux 桌面安装包
- [ ] **CP-4 dogfooding 准入**

### 5.3 Week 4 末检查点（CP-4，dogfooding 准入）

- [ ] 应用稳定运行 ≥ 30 分钟不 crash
- [ ] 连接失败有明确错误消息（不是 panic / 纯英文 stack trace）
- [ ] 本地 build .dmg 能在另一台 Mac 跑起来
- [ ] 已自测 ≥ 10 个不同 SQL（含 SELECT/JOIN/聚合）
- [ ] 隧道断开能感知（FR-014 实测，180s 内）

**若不通过**：Week 5 推迟 1 周，Week 6 缓冲挪到 Week 5。

### 5.4 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| control conn 也走隧道，隧道卡死时 cancel 同样卡 | 20% | 中 | cancel 加超时；超时后前端仍 abort 客户端等待 |
| 子查询包装在某些 SQL（含 ORDER BY/UNION）上语义微变 | 10% | 低 | 单测覆盖 ORDER BY/UNION/CTE；外层 LIMIT 不改内部排序 |
| react-flow bundle 过大影响启动 | 10% | 低 | bundle ~300KB 桌面端可接受 |
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

- [ ] 作者 + 2 同事用 ≥ 1 周，0 数据丢失，0 不可恢复 crash（FR-041）
- [ ] **CP-3**：MySQL 5.7 在同事环境验证通过
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
| R-011 | react-flow bundle 拖慢启动 | ~300KB 可接受；超 5MB 才换实现 |
| R-012 | 大表浏览卡顿 | 子查询包装 LIMIT 1000 已护栏 |
| R-013 | 同事不会"右键打开" | README GIF + 群消息教学 |
| R-014 | read-only 正则只是 best-effort，`SELECT func_that_writes()` 等绕过 | 文案明示建议用只读账号（见 REQUIREMENTS FR-024）；v0.2 不强化 |

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
| 2 | SQL 取消独立 control conn + KILL QUERY | T4.2 / FR-023 |
| 3 | SshTunnelError 加 ChannelDropped + AcceptLoopDied | T3.3 / FR-013 |
| 4 | trait Driver 推 v0.2，v0.1 具体 struct | T2.2 / ROADMAP v0.2 |
| 5 | 测试基础设施一次架齐（无 Docker，本地 MySQL） | T2.1 |
| 6 | sqlx 大结果集子查询包装替代 regex | T4.1 / FR-021 |
| 7 | **Week 1 改 vertical slice** | §2 整段重排 |
| 8 | read-only SQL best-effort（建议只读账号） | T4.2 / FR-024 / R-014 |
| 9 | Codex 4 条 tension surface（KILL 4 状态 / 状态机 / read-only / crate） | §9.3 / R-006 / R-014 |

---

## 附录 A：每周快速 checklist

### Week 1（vertical slice）
- [ ] **CP-1** Tauri+workspace 摩擦验证（最先做）
- [ ] 单跳 SSH 隧道复制 + 跑通
- [ ] sqlx 桥接 SELECT 1
- [ ] Next.js hello 页
- [ ] tauri.conf + 最小 CI
- [ ] **CP-1b** 端到端闭环

### Week 2（测试 + driver + 连接管理）
- [ ] 测试基础设施一次架齐（无 Docker）
- [ ] 具体 struct MySqlDriver（不抽 trait）
- [ ] connection_* commands
- [ ] 加密 store（passphrase 不落盘）
- [ ] 连接列表/编辑 UI（无 SSH）
- [ ] **CP-2** 25h 累计检查

### Week 3（多跳 + keepalive + 错误模型）
- [ ] 单跳 → 3 跳
- [ ] keepalive 60s + 3 次阈值
- [ ] SshTunnelError 三变体 + hop_index
- [ ] TOFU 流程
- [ ] SshHop 配置表单
- [ ] schema/table 树 + 1000 行表格

### Week 4（SQL + 拓扑 + dmg）
- [ ] 子查询包装防 OOM + 拒多语句
- [ ] control conn + KILL QUERY
- [ ] react-flow 拓扑图
- [ ] ssh:hop-status + 错误高亮
- [ ] macOS .dmg
- [ ] **CP-4** dogfooding 准入

### Week 5（dogfooding + 发布）
- [ ] 作者自用 1 周
- [ ] 2 同事试用 1 周（含 5.7 验证 CP-3）
- [ ] 修 P0/P1
- [ ] README + GIF
- [ ] tag v0.1.0
- [ ] **CP-5** 75h 上限 / **CP-6** dogfooding 验收

### Week 6（缓冲）/ Week 7（launch）
- [ ] 溢出承接 / v0.2 预研
- [ ] V2EX + 掘金发帖
