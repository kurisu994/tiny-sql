---
name: 00-project
description: 项目定位、领域语言、技术栈与架构分工铁律（开局必读）
---

# 项目定位（00-project）

> 开局必读。给第一次接触 tiny-sql 的人：这是什么、做什么、给谁用、交付什么。

## 一句话

**tiny-sql** 是一款**多级跳板机友好的 MySQL / PostgreSQL / SQLite 桌面客户端**——把 SSH 跳板从「雾中一根管子」变成「可观测的路由器」。

## 核心愿景

主流 SQL 客户端（DBeaver / TablePlus / Navicat / DataGrip / Sequel Ace）把 SSH 隧道当作单跳、黑盒的「一根管子」，出错无法定位是第几跳挂了。tiny-sql 把**每一跳都做成 UI 上的一等公民节点**：独立连接状态与错误归因。连接失败时拓扑图高亮断点那一跳，隧道任意一跳挂掉 180s 内推送 lost 状态到 UI；已支持累计到每跳 SSH session 的协议 RTT / 超时显示，以及进入数据库那条边的 `SELECT 1` 累计延迟。

这是把 SSH 从「网络层」提升到「数据模型层」的理念差距，而非单纯 feature 差距。

## 目标用户（三类，需求高度重叠）

| 画像 | 身份 | 关键诉求 |
|---|---|---|
| A 作者自用 | 每天连 4 层堡垒生产 MySQL 的工程师 | 高频连接免手动 `ssh -L`；故障时一眼看出哪跳挂 |
| B 同事推广 | 同公司面对多级堡垒的运维 / 后端 / 数据 | 不会配 ProxyJump；无 $99 苹果账号也能用 |
| C 开源社区 | V2EX / 掘金 / GitHub 上的中文开发者 | 1-2 跳常见；首发 zh-CN；issue/PR 24h 内回应 |

## 架构总览与分工铁律

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js 16 前端（WebView）— src/app                          │
│  invoke(command) ──IPC──► / listen(event) ◄──emit──          │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri IPC
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  src-tauri（壳）— 组装层                                       │
│  commands 层 + AppState（pool/隧道注册表）+ 加密 store/TOFU    │
└──────────────┬─────────────────────────┬─────────────────────┘
               ▼                         ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│  crates/db-driver        │  │  crates/ssh-multihop          │
│  Driver + MySQL/PG/SQLite │  │  open() → N 跳隧道 + 本地端口  │
│  不知道 SSH 存在          │  │  完全不知道 MySQL 存在         │
└──────────────────────────┘  └──────────────────────────────┘
```

**分工铁律**（三条都是「不变量」，破坏了要当架构问题处理）：

- `ssh-multihop` **只知道**「本地监听一个端口，把流量转发到远端 host:port」，不知道上层是 MySQL → 这是它未来能独立 publish 的前提。
- `db-driver` **只知道**数据库连接与查询，不知道 SSH。通用调用通过对象安全的 `Driver` 契约；连接创建和方言专属配置仍由具体 driver 负责。
- `src-tauri` 把两者拼起来 + Tauri IPC + 持久化；走 SSH 时先打开隧道拿本地端口，再按连接配置创建 `MySqlDriver` / `PostgresDriver` / SqliteDriver 连本地端口（SQLite 是文件型，不走隧道），最后包装为 `ActiveDriver`。

## 关键产品决策

- **Approach B（Clean Workspace）**：独立 crate（`ssh-multihop` / `db-driver`），未来可独立 publish，仓库诞生即干净。
- **对象安全 Driver 契约**（v0.2 落地，v0.8 三实现）：从真实调用面提取最小对象安全契约，统一承载 MySQL、PostgreSQL 与 SQLite，支持独立取消与 database/schema 隔离。
- **best-effort 只读保护**：首 token 白名单二次确认，真正只读建议用 MySQL 只读账号。
- **仅本地数据**：无遥测、无错误上报；自动更新只访问 GitHub Release 的正式版更新清单。

## 范围与交付物（v0.1 已交付，保留作历史锚点）

- **范围**：MySQL only（5.7 + 8.0）+ 3 跳 SSH + 拓扑图 + macOS arm64/x64、Windows x64、Linux x64 打包 + zh-CN only + 正式版自动更新；v0.1 无 Apple Developer 代码签名 / notarization。
- **预算**：5-6 周 × 12-13 小时/周 = 60-75 小时。
- **交付物**：GitHub Releases 上的 `.dmg` / `.exe` / `.AppImage`、Tauri updater artifact / `.sig` 与正式版 `latest.json`；`v*` tag 触发 Release workflow 自动构建上传。v0.1.0 已于 2026-08-18 完成全平台正式发布。
- **发布门槛**：作者 + 2 同事 dogfooding ≥ 1 周，0 数据丢失、0 不可恢复 crash。

## 核心用户流

### 流 1：高频日常查询（画像 A 主场景）

```
开机 → 30s 内打开 tiny-sql
   │
   ▼
连接列表第一个 = "生产读库 RO"（按用户手动拖拽的顺序，见 active/main.md）
   │ 双击
   ▼
3 跳隧道自动建立（拓扑图节点依次 pending → connected 变绿）
   │
   ▼
左侧树列出所有 schema → 点 orders → 点 t_order 表
   │
   ▼
右侧「数据」标签按服务端分页显示表数据（默认可选 100/500/1000 行）
   预期全流程 ≤ 15s
```

### 流 2：故障排查（画像 A 的差异化卖点）

```
线上告警 → 点开 "生产读库 RO"
   │
   ▼
第 2 跳堡垒机网络抖动连不上
   │
   ▼
拓扑图 hop[1] 节点变红 + tooltip "connection timeout"
hop[0] 仍绿 → 立刻判定是堡垒机问题
   （DBeaver 只会报 "connection refused"，无法定位第几跳）
```

### 流 3：执行修复 SQL（写操作二次确认）

```
粘贴 UPDATE t_order SET ... WHERE id IN (...) → 点执行
   │
   ▼
首 token 白名单分类（SELECT/WITH 读、SHOW/EXPLAIN/DESC/DESCRIBE 元数据免确认、其余一律弹确认）→ 二次确认
   │ 二次确认
   ▼
执行成功，显示影响行数
```

### 流 4：首次连接 TOFU（画像 B 上手 5 分钟）

```
新建连接 → 填 3 跳 SSH + MySQL 信息 → 测试连接
   │
   ▼
首跳未知 host → 弹 TOFU 对话框（显示 SHA256 指纹）
   │ 信任并继续
   ▼
指纹写入自有 known_hosts.json（不污染 ~/.ssh）
   │
   ▼
后续连接静默通过；指纹被改 → 硬拒绝（MITM 警告）
```

## 领域约束（业务侧，代码必须遵守）

| 约束 | 内容 | 理由 |
|---|---|---|
| 多级跳板 | 生产环境 4 层堡垒是常态（办公网 → VPC → DB 跳板 → MySQL） | 这是产品存在的根本动机 |
| MySQL 版本 | 必须同时支持 5.7（`mysql_native_password`）和 8.0（`caching_sha2_password`） | 5.7 EOL 但国内仍大量在用 |
| PostgreSQL 版本 | 正式支持 15-18，最低支持 15；14 及以下 best-effort | 见 13 号规范的测试矩阵 |
| passphrase | 未启用主密码时仅会话内存（Zeroizing 包装）；启用主密码并解锁后可加密持久化至 secrets.enc | 安全平衡（FR-102） |
| 小库假设 | v0.1 不做 cache；v0.2 起用 128 项、5 分钟 TTL 分区内存 LRU metadata cache（FR-108） | 兼顾响应性能与内存 |
| 无 Apple Developer 代码签名 | 无苹果开发者证书，README 教 `xattr -cr`；Tauri updater 签名只校验更新包完整性 | 避免 $99/年阻塞首发 |

## 交互逻辑（具体规则）

- **结果集防 OOM 三道闸**：拒多语句 + 顶层安全追加 LIMIT（顶层无 LIMIT/FOR/LOCK/INTO/PROCEDURE 时末尾追加 `LIMIT n+1`，不做 derived table 包装避免 JOIN 重名列 1060） + `rowLimit` 后端 clamp 到 100000（表浏览 1000，SQL 编辑器 100000）。
- **SQL 取消**：`tokio::select!` + cancel token 中止客户端等待，**同时**从独立 control pool 发 `KILL QUERY` 中止远端，不留服务端幽灵查询。
- **隧道断开感知**：每跳 keepalive 60s 一次，**连续 3 次失败（≈180s）才判定断开**（防弱网 / bastion ratelimit 误报）。
- **错误归因**：每个 `SshTunnelError` 变体带 `hop_index`，从后端原样透传到前端拓扑节点。
- **错误展示**：所有用户可见错误用稳定 i18n key（`error.ssh.*` / `error.driver.*`）翻译成中文，禁止显示原始 Rust 错误。

## 数据安全约束

- 连接配置（含 SSH password）AES-GCM 加密落盘到 `~/Library/Application Support/tiny-sql/connections.enc`，明文 grep 必须 0 命中。
- known_hosts 写自有 store，**不读不写** `~/.ssh/known_hosts`。
- host key 变更**硬拒绝**，UI 不提供「忽略」按钮。

## 配套文档

详细需求 / 计划 / 架构 / 路线见 `docs/`：[REQUIREMENTS](../docs/REQUIREMENTS.md) · [PLAN](../docs/PLAN.md) · [ARCHITECTURE](../docs/ARCHITECTURE.md) · [ROADMAP](../docs/ROADMAP.md)。历史里程碑见 [archive/](./archive/)。
