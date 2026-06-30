---
title: tiny-sql 架构设计
version: 0.1.0-draft-2
status: draft
last_updated: 2026-06-26
---

# tiny-sql 架构设计

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [PLAN.md](./PLAN.md) · [ROADMAP.md](./ROADMAP.md)

## 0. 阅读指南

本文回答四件事：

1. **代码怎么分层**（§1 / §3）：3 个 Rust crate + Tauri 壳 + Next.js 前端
2. **一条 SQL 怎么跑完全链路**（§2 数据流图）
3. **SSH 多跳隧道的协议机制、状态机、错误模型**（§4）
4. **前后端怎么对话**（§7 事件契约）

不在本文范围：v0.2+ 的扩展（见 [ROADMAP.md](./ROADMAP.md)）；具体代码实现（去看 PR）。

---

## 1. 总体架构

### 1.1 仓库布局

```
tiny-sql/
├── Cargo.toml                     # workspace 根，列 members
├── crates/
│   ├── ssh-multihop/              # SSH 多跳隧道 crate（fork 自 redis-desktop-client）
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── db-driver/                 # 数据库 driver 抽象 crate
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs             # pub struct MySqlDriver（v0.2 extract trait）
│           ├── mysql.rs           # MySqlDriver 实现
│           └── tunneled.rs        # MySqlDriverViaSshTunnel 包装层
├── src-tauri/                     # Tauri 壳（Cargo.toml 是 workspace 成员）
│   ├── Cargo.toml                 # 依赖 ssh-multihop + db-driver
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── commands/              # tauri command 层
│       │   ├── connection.rs      # connection_create / list / update / delete / test
│       │   ├── query.rs           # query_execute / query_cancel
│       │   └── ssh_tofu.rs        # ssh_tofu_decision
│       ├── config/
│       │   ├── encryption.rs      # AES-GCM 加密 store
│       │   ├── store.rs           # 连接配置序列化
│       │   └── ssh_known_hosts.rs # 自有 known_hosts.json
│       └── state.rs               # AppState（连接池注册表 / TOFU manager）
├── src/                           # Next.js 16 前端
│   ├── app/                       # App Router pages
│   ├── components/
│   ├── lib/
│   └── stores/                    # zustand
├── public/
├── package.json
└── docs/                          # 本目录
```

### 1.2 三 crate 的职责分工

```
┌─────────────────────────────────────────────────────────────┐
│                       src-tauri (壳)                          │
│  - Tauri runtime + plugins                                   │
│  - commands 层把前端调用转给 db-driver                          │
│  - AppState 持有所有活跃连接的 pool 与隧道                       │
│  - 加密 store / known_hosts / TOFU manager                    │
└──────────────┬─────────────────────────┬─────────────────────┘
               │                         │
               ▼                         ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│   crates/db-driver       │  │   crates/ssh-multihop         │
│                          │  │                                │
│  pub struct MySqlDriver  │  │  pub async fn open(           │
│   - connect              │  │    ssh: &SshConfig,           │
│   - list_databases       │  │    target_host: &str,         │
│   - list_tables          │  │    target_port: u16,          │
│   - list_columns         │  │    ctx: &SshTunnelContext,    │
│   - query (取 cancel_token)│  │  ) -> Result<SshTunnel, ...>  │
│   - cancel (control conn)│  │                                │
│   (v0.1 具体 struct       │  │  - 逐跳 SSH session 建立        │
│    v0.2 extract trait)   │  │  - 每跳 keepalive 60s/3 次      │
│   (用 sqlx::MySqlPool)   │  │  - TOFU 流程                   │
│                          │  │  - 本地 127.0.0.1:0 listener   │
│  MySqlDriverViaSshTunnel │  │  - copy_bidirectional 桥接     │
│   (组合 ssh-multihop)    │  │  - SshTunnelError 含 hop_index │
└──────────────────────────┘  └──────────────────────────────┘
```

**分工原则**：

- `ssh-multihop` **完全不知道 MySQL 存在**。它只知道"在本地监听一个端口，把流量转发到远端 host:port"。这是它未来能独立 publish 的前提。
- `db-driver` **完全不知道 SSH 存在**（除了 `MySqlDriverViaSshTunnel` 这个组合层）。v0.1 是具体 `struct MySqlDriver`，只关心"给我一个 URL，我返回 Connection"；v0.2 加 PG 时再 extract `trait Driver`。
- `src-tauri` 是组装层：把上面两块拼起来，加 Tauri 的 IPC + 持久化。

### 1.3 Tauri + workspace 摩擦兜底

Tauri 2 + workspace 已知有路径解析 corner case（`src-tauri/Cargo.toml` 作为 workspace 成员引用其他 crate 时，部分版本的 `tauri build` 会出错）。

Week 1 末若 `cargo tauri build` 跑不通，立刻退回扁平 mod 方案：

```
src-tauri/src/
├── ssh_multihop/       # 原 crate 内容挪到这里作为 mod
│   └── mod.rs
├── db_driver/
│   └── mod.rs
└── ...
```

功能等价。开源解耦弱一点（`ssh-multihop` 不能独立 publish）但保 ship。详见 [PLAN.md §2.1 T1.6](./PLAN.md#21-任务) 与 [PLAN.md §9.1 R-001](./PLAN.md#91-影响-ship-的风险红灯)。

---

## 2. 数据流

### 2.1 一条 SQL 的完整链路

用户在前端 SQL textarea 点"执行"开始，到结果回到 UI 表格，全链路如下。**实线**是数据/调用方向，**虚线**是错误回流方向。

```
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js 16 前端 (WebView)                                            │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ <textarea> SQL ───click执行──> queryStore.execute(sql)          │  │
│  │                                          │                     │  │
│  │                                          ▼                     │  │
│  │   invoke('query_execute', { connection_id, sql, query_id })    │  │
│  │                                          │                     │  │
│  └──────────────────────────────────────────┼─────────────────────┘  │
└─────────────────────────────────────────────┼─────────────────────────┘
                                              │ Tauri IPC
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src-tauri (commands 层)                                              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #[tauri::command]                                              │  │
│  │ async fn query_execute(state, conn_id, sql, query_id) {        │  │
│  │   let driver = state.drivers.get(&conn_id)?;                   │  │
│  │   let cancel_token = state.queries.register(query_id);         │  │
│  │   tokio::select! {                                             │  │
│  │     res = driver.query(sql, cancel_token) => res,              │  │
│  │     _ = cancel_token.cancelled() => Err(QueryCancelled),       │  │
│  │   }                                                            │  │
│  │ }                                                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────┬─────────────────────────┘
                                              │ trait call
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  crates/db-driver                                                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ MySqlDriverViaSshTunnel::query(sql, cancel_token)              │  │
│  │   ├─ self.pool: MySqlPool（max=5）                              │  │
│  │   ├─ sqlx::query(sql).fetch(&self.pool)                        │  │
│  │   └─ 客户端 10w 行截断 / RowSet 组装                              │  │
│  └─────────────────────────────────┬──────────────────────────────┘  │
└────────────────────────────────────┼─────────────────────────────────┘
                                     │ 通过 mysql:// URL
                                     │ 实际是 TCP write
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  本地 listener  127.0.0.1:54321  (ssh-multihop 起的)                  │
│         │                                                             │
│         │ accept(); spawn { copy_bidirectional(socket, ssh_stream) }  │
│         ▼                                                             │
└────────┬────────────────────────────────────────────────────────────┘
         │
         │ 流量写入到 hop[0] session 的某个 direct-tcpip channel
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SSH hop[0] session (本地 → 堡垒机)                                   │
│  channel_open_direct_tcpip("127.0.0.1", 0, hop[1].host, hop[1].port) │
│         │                                                             │
│         │ 流量包在 SSH packet 里走出本机                                │
└────────┬────────────────────────────────────────────────────────────┘
         │
         │ TCP 加密包到堡垒机的 sshd                                       │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  hop[0] (堡垒机) sshd 解包                                            │
│  内部 direct-tcpip channel → 起到 hop[1].host:22 的 TCP 连接           │
└────────┬────────────────────────────────────────────────────────────┘
         │
         │ TCP 连接到 hop[1] 的 sshd
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SSH hop[1] session (堡垒机 → 内网堡垒)                                │
│  （在 hop[0] 的 channel stream 上跑 SSH 协议，嵌套加密）                  │
│         │                                                             │
│         │ channel_open_direct_tcpip("127.0.0.1", 0, hop[2].host, ...) │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  hop[1] sshd 解包 → TCP 到 hop[2]:22                                  │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SSH hop[2] session (内网堡垒 → 业务跳板)                              │
│  在 hop[2] (最后一跳) 上开 direct-tcpip 到 MySQL                       │
│  channel_open_direct_tcpip("127.0.0.1", 0, mysql.host, 3306)         │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  hop[2] sshd 解包 → TCP 到 mysql.host:3306                            │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  MySQL 8.0 (caching_sha2_password)                    │
│                  执行 SQL，返回行集                                     │
└────────┬────────────────────────────────────────────────────────────┘
         │ 行集原路返回 (TCP)
         ▼
        ......（每一跳反向解包）......
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  本地 127.0.0.1:54321 收到行集                                         │
│         │                                                             │
│         ▼ sqlx 解析 MySQL protocol → Rust 类型                          │
│  MySqlDriverViaSshTunnel::query 返回 RowSet                          │
│         │                                                             │
│         ▼ tauri command 返回                                          │
│  前端 zustand store 收到 RowSet → react-virtuoso 渲染                   │
└─────────────────────────────────────────────────────────────────────┘
```

**错误回流路径**（虚线）：

- MySQL 服务端错误 → sqlx → `Driver::query` 返回 `Err(QueryError::MySql(...))` → command 层 → 前端 toast
- 隧道断开（hop[i] keepalive 失败）→ `ssh-multihop` 内部 task emit `ssh:hop-status` event（**不经 query 返回路径**，直接走事件总线）→ 前端 zustand 更新 hop 状态 → 拓扑节点变红
- 同时：正在进行的 query 会因为 TCP RST 而失败，回到前端 toast"连接已断开"

### 2.2 关键设计决策

- **本地 listener + sqlx**：sqlx 不支持注入自定义 `TcpStream`，所以必须走"本地端口 + URL"模式。详见 §4.5。
- **多 MySQL 连接复用同一隧道**：1 个 tiny-sql 连接 = 1 个本地端口 = 1 个 MySqlPool（max=5）。Pool 里 5 条 TCP 都走同一个本地端口；每条 TCP 触发 listener accept 一次，spawn 一个 channel_open_direct_tcpip。所以**首跳 SSH session 上会有 5 个 direct-tcpip channel**（不是 5 个 SSH session）。
- **隧道生命周期绑定 pool**：tunnel drop → listener drop → sqlx 连接全部报 connection refused → pool drop → AppState 清掉 driver。

### 2.3 前端依赖

| 依赖 | 用途 |
|---|---|
| `next` 16.1.6 | App Router |
| `react` 19.2.x | UI |
| `@tauri-apps/api` 2.10.x | IPC + event |
| `@tauri-apps/plugin-{store,dialog,fs,log,opener,process}` 2.x | Tauri 插件 |
| `@xyflow/react` ^12 | 拓扑图（react-flow 改名后） |
| `react-virtuoso` ^4.18 | 1000 行/10w 行虚拟滚动 |
| `i18next` + `react-i18next` | i18n（v0.1 仅 zh-CN） |
| `zustand` ^5 | 全局状态 |
| `shadcn` + `radix-ui` + `tailwindcss` 4 | UI 组件 |
| `lucide-react` | 图标 |
| `sonner` | toast |

---

## 3. crate 详解

### 3.1 crates/ssh-multihop

**职责**：建立 N 跳 SSH 隧道，在本地暴露一个 TCP 端口，把流量桥接到远端 host:port。完全不知道上层应用是什么。

**导出 API**（Rust 伪签名，公共类型用中文 doc comment）：

```rust
/// SSH 多跳配置 — 一条隧道对应一个 SshConfig，含 1..N 个跳板节点
pub struct SshConfig {
    pub enabled: bool,
    pub hops: Vec<SshHop>,
}

/// 单跳信息 — 顺序敏感：hops[0] 是本地直连的第一跳，hops[N-1] 是出口
pub struct SshHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,           // "password" | "privateKey"
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,  // 仅会话内存，不持久化
}

/// 建立隧道所需的运行时上下文 — 由 src-tauri 注入
pub struct SshTunnelContext {
    pub known_hosts: Arc<SshKnownHostsStore>,
    pub tofu_manager: Arc<SshTofuManager>,
    pub app_handle: tauri::AppHandle,
    pub connection_id: String,
}

/// SSH 隧道错误 — 每个变体对应一个稳定的前端 i18n key
#[derive(Debug, thiserror::Error)]
pub enum SshTunnelError {
    /// 配置中 hops 为空
    NoHops,
    /// TCP 层连接失败（含 DNS 解析失败 / refused / timeout）
    ConnectFailed { hop_index: usize, reason: String },
    /// 认证失败（密码错 / 私钥无权限）
    AuthFailed { hop_index: usize },
    /// 私钥 passphrase 错
    InvalidPassphrase { hop_index: usize },
    /// 私钥文件不存在或不可读
    KeyNotFound { hop_index: usize },
    /// SSH direct-tcpip channel 开启失败
    ChannelOpenFailed { hop_index: usize, reason: String },
    /// 本地 listener 绑定失败
    LocalListenFailed,
    /// 配置里 auth_type 字段不是合法值
    InvalidAuthType { hop_index: usize },
    /// 已信任 host 的公钥指纹被改 — 硬拒绝，不允许 UI 忽略
    HostKeyMismatch { hop_index: usize, host: String, port: u16 },
    /// 用户在 TOFU 弹窗里选了"拒绝"
    HostKeyRejected { hop_index: usize },
    /// 已建立的隧道因为 keepalive 连续 3 次失败而断开（FR-014）
    TunnelLost { hop_index: usize, reason: String },
    /// 运行中某跳的 channel 被对端主动关闭（可能跳板重启），需人工重连
    ChannelDropped { hop_index: usize },
    /// 运行中某跳的 accept loop panic（代码 bug），需上报
    AcceptLoopDied { hop_index: usize },
}

/// 隧道句柄 — drop 时关闭 listener 与所有跳板 session
pub struct SshTunnel { /* ... */ }

impl SshTunnel {
    /// 本地绑定的 127.0.0.1:port，可直接传给上层 driver 构造 URL
    pub fn local_addr(&self) -> std::net::SocketAddr;
}

/// 主入口：建立 N 跳隧道
pub async fn open(
    ssh: &SshConfig,
    target_host: &str,
    target_port: u16,
    context: &SshTunnelContext,
) -> Result<SshTunnel, SshTunnelError>;
```

**实现要点**（来自 redis-desktop-client 复用 + tiny-sql 扩展）：

1. **逐跳建立**：hops[0] 用 `TcpStream::connect` 直连；hops[1..] 用前一跳的 channel `into_stream()` 当 transport，给 `client::connect_stream` 用。
2. **每跳认证**：`authenticate_hop()` 按 `auth_type` 分支调 password 或 publickey；publickey 自动协商 RSA 最佳 hash 算法。
3. **session 全链路保活**：`SshTunnel._sessions: Vec<SharedSession>` 持有所有中间跳板的 session 引用，中间任何一跳 drop 都会导致下一跳的 channel stream 失活，所以必须整链保活。
4. **本地 listener loop**：`tokio::spawn` 的循环里 accept → `tokio::spawn` 一个新 task → 在最后一跳 session 上开 direct-tcpip → `copy_bidirectional(socket, stream)`。
5. **keepalive task**（**FR-014 新增**）：每跳的 session 建立后，再 spawn 一个 `tokio::interval(60s)` 循环调 `session.send_keepalive()`，**连续 3 次失败（≈180s）才判定断开** emit `ssh:hop-status` `{status: "lost"}` event（避免弱网/bastion ratelimit 误报）。task handle 存到 `SshTunnel.keepalive_tasks: Vec<JoinHandle<()>>`，drop 时一起 abort。channel 被对端主动关 → `ChannelDropped`；accept loop panic → `AcceptLoopDied`。

**known_hosts 存储**：自有 store，路径 `~/Library/Application Support/tiny-sql/known_hosts.json`。结构为 `{ "host:port": "sha256:xxx", ... }`。**不读、不写** `~/.ssh/known_hosts`（NFR-012）。

**单测覆盖**：
- `SshTunnelError::i18n_key()` 稳定性（公开 API 契约）
- `expand_home_path` 各种 ~ 前缀
- keepalive task 在 SshTunnel drop 后被 abort（验证 task count 回零）

### 3.2 crates/db-driver

**职责**：给上层 commands 层一个统一的数据库访问接口。**v0.1 不抽 `trait Driver`——直接写具体 `struct MySqlDriver`**，方法是 inherent impl。单实现 trait 是 premature abstraction（trait 签名只能凭猜 PG 需要什么、v0.2 大概率返工），所以 v0.2 加 PostgreSQL 时再用 rust-analyzer extract trait（两个实现在手才设计接口）。下面的方法签名是 `impl MySqlDriver` 的，extract trait 后原样变成 `trait Driver` 的方法。

**核心方法**（v0.1 具体 struct）：

```rust
/// MySQL driver — v0.1 具体实现，v0.2 extract 为 trait Driver
///
/// 加 PG 时：rust-analyzer extract trait → 新增 PostgresDriver 文件，
/// commands 调用点从 MySqlDriver 换成 Box<dyn Driver>（一次 refactor）。
impl MySqlDriver {
    /// 列出所有可见 database（MySQL 叫 schema）
    async fn list_databases(&self) -> Result<Vec<DatabaseMeta>, DriverError>;

    /// 列出指定 database 下的所有 table
    async fn list_tables(&self, database: &str) -> Result<Vec<TableMeta>, DriverError>;

    /// 列出指定 table 的所有 column（v0.1 仅用于浏览，v0.2 用于智能联想）
    async fn list_columns(&self, database: &str, table: &str)
        -> Result<Vec<ColumnMeta>, DriverError>;

    /// 执行任意 SQL，返回结果集
    ///
    /// - `cancel_token`：取消机制，用 tokio_util::sync::CancellationToken
    /// - 拒多语句（用 sqlparser-rs 解析或分号拆解后拒绝），v0.1 只允许单条 SELECT
    /// - LIMIT 防护用**子查询包装**：SELECT * FROM (<user_sql>) AS tiny_sql_limited LIMIT 1000
    ///   （MySQL 原生语义、零误判；不改写原 SQL，不用 regex 检测 LIMIT 关键字）
    /// - 后端 fetch_many 流式取 + 客户端 take(100000) 硬上限，防 OOM
    async fn query(
        &self,
        sql: &str,
        cancel_token: tokio_util::sync::CancellationToken,
    ) -> Result<RowSet, DriverError>;

    /// 主动 KILL 远端正在执行的 query（与 cancel_token 配合）
    ///
    /// 从**独立 control connection**（主 MySqlPool 之外、同一隧道独立本地端口）
    /// 发 KILL QUERY <connection_id>，保证 pool 满时 KILL 仍能发出，不留服务端幽灵查询。
    async fn cancel(&self, query_id: &str) -> Result<(), DriverError>;
}

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("error.driver.connect_failed")]
    ConnectFailed(String),
    #[error("error.driver.auth_failed")]
    AuthFailed,
    #[error("error.driver.sql_error")]
    SqlError(String),  // MySQL 服务端原文错误（含行号）
    #[error("error.driver.cancelled")]
    Cancelled,
    #[error("error.driver.truncated")]
    Truncated { limit: usize },  // 提示用，不是真错误
    #[error("error.driver.tunnel_lost")]
    TunnelLost,  // 隧道挂了导致 connection refused
}
```

**MySqlDriver 实现**：内部用 `sqlx::MySqlPool`（max_connections = 5），构造时传入 `mysql://user:pass@127.0.0.1:port/db?...` URL。`list_databases` 查 `information_schema.schemata`，`list_tables` 查 `information_schema.tables`。

**取消的独立 control connection**：除主 pool 外，MySqlDriver 额外持有一条 control connection（同一隧道、独立本地端口）。`cancel(query_id)` 从这条 conn 发 `KILL QUERY <connection_id>`。理由：若从主 pool 借连接发 KILL，pool 满时会卡在 acquire——恰恰是最需要取消（库被打满）的时候发不出 KILL。control conn 与主 pool 状态解耦。

**结果集防 OOM 三道闸**（FR-021/022）：(1) 拒多语句、对单条 SELECT 用子查询包装 `SELECT * FROM (<user_sql>) AS tiny_sql_limited LIMIT 1000`；(2) 后端 `fetch_many` 流式逐行取，不用 `fetch_all` 缓冲；(3) 客户端 `take(100000)` 硬上限，超出 toast 提示。三层叠加后，同事在大表上随手 `SELECT *` 也不会把 Rust 进程内存打爆。

**MySqlDriverViaSshTunnel**（组合层）：

```rust
/// MySQL driver + SSH 多跳隧道的组合层
///
/// 生命周期：tunnel 在 driver 之前 drop 会导致 pool 失效，所以两者绑定。
pub struct MySqlDriverViaSshTunnel {
    /// 隧道 handle — drop 时关闭 listener
    tunnel: SshTunnel,
    /// MySQL 连接池 — 走本地 listener 端口
    pool: sqlx::MySqlPool,
}
```

构造函数大致：

```
1. ssh_multihop::open(&ssh_config, mysql_host, mysql_port, ctx)
   → 拿到 tunnel，local_addr = 127.0.0.1:54321
2. let url = format!("mysql://{}:{}@127.0.0.1:{}/{}?...",
                     user, pass, tunnel.local_addr().port(), db)
3. let pool = MySqlPool::connect(&url).await?
4. 返回 MySqlDriverViaSshTunnel { tunnel, pool }
```

### 3.3 src-tauri/commands

每个 tauri command 都是 `async fn`，签名 `(state: tauri::State<AppState>, ...) -> Result<Output, String>`。错误统一返回 `i18n_key` 字符串，前端用 i18next 翻译。

| Command | 输入 | 输出 | 描述 |
|---|---|---|---|
| `connection_create` | `(name, config)` | `connection_id` | 加密落盘 |
| `connection_update` | `(id, config)` | `()` | 同上 |
| `connection_list` | - | `Vec<ConnectionMeta>` | 列表（不含敏感字段） |
| `connection_delete` | `id` | `()` | 加密落盘后删 |
| `connection_test` | `config` | `()` | 完整建立 → SELECT 1 → 销毁 |
| `connection_open` | `id` | `()` | 建立持久连接，注册到 AppState |
| `connection_close` | `id` | `()` | 关闭并清理 |
| `query_execute` | `(id, sql, query_id)` | `RowSet` | 执行 SQL |
| `query_cancel` | `query_id` | `()` | 取消正在跑的 query |
| `ssh_tofu_decision` | `(connection_id, hop_index, accept)` | `()` | TOFU 弹窗回调 |

### 3.4 AppState

`src-tauri` 的全局状态，注入到所有 command：

```rust
pub struct AppState {
    /// 已打开连接的 driver 注册表（connection_id → driver）
    pub drivers: dashmap::DashMap<String, Arc<dyn Driver>>,
    /// 正在执行的 query 注册表（query_id → cancel_token）
    pub queries: dashmap::DashMap<String, CancellationToken>,
    /// 加密 store（连接配置）
    pub config_store: Arc<ConfigStore>,
    /// SSH known_hosts store
    pub known_hosts: Arc<SshKnownHostsStore>,
    /// TOFU 决策 manager（前端弹窗响应回调通道）
    pub tofu_manager: Arc<SshTofuManager>,
}
```

---

## 4. SSH 多跳隧道详解

### 4.1 协议机制

OpenSSH ProxyJump 的等效实现：

```
本地                hop[0]             hop[1]             hop[2]            MySQL
 │                   │                  │                  │                 │
 │── TCP 22 ────────>│                  │                  │                 │
 │<── SSH handshake ─│                  │                  │                 │
 │── auth ──────────>│                  │                  │                 │
 │  (hops[0] session 建立完成)            │                  │                 │
 │                   │                  │                  │                 │
 │── direct-tcpip ──>│                  │                  │                 │
 │   (hop[1]:22)     │                  │                  │                 │
 │<── channel open ──│                  │                  │                 │
 │                   │── TCP 22 ───────>│                  │                 │
 │                   │<── SSH ──────────│                  │                 │
 │   嵌套 SSH handshake (在 channel 流上)                                       │
 │── auth ──────────>│─── forward ─────>│                  │                 │
 │  (hops[1] session 建立完成)                                                  │
 │                   │                  │                  │                 │
 │── direct-tcpip ──>│── forward ─────>│                  │                 │
 │   (hop[2]:22)     │                  │                  │                 │
 │                   │                  │── TCP 22 ───────>│                 │
 │   嵌套 SSH handshake                                                         │
 │── auth ──────────>│─── forward ─────>│─── forward ─────>│                 │
 │  (hops[2] session 建立完成)                                                  │
 │                   │                  │                  │                 │
 │── direct-tcpip ──>│── forward ─────>│─── forward ─────>│── TCP 3306 ────>│
 │   (mysql:3306)    │                  │                  │                 │
 │                                                                            │
 │   MySQL protocol（在 N 层 SSH 嵌套加密内）                                     │
 │<══════════════════════════════════════════════════════════════════════════>│
```

关键点：

- **每跳都是独立的 SSH session**，但 transport 不同：hops[0] 直接走 TCP，hops[i] 走 hops[i-1] 上的 channel stream
- **direct-tcpip channel** 是 SSH 协议标准 channel 类型，用途是 "本地端口转发到 SSH server 能访问的任意 TCP 地址"
- **最后一跳的 direct-tcpip 指向 MySQL**，而不是下一跳的 sshd:22
- **流量加密层数 = 跳数**：3 跳就是 3 层 SSH 嵌套加密，CPU 开销不可忽略（实测 3 跳下大约 60-80MB/s 单连接吞吐，对 SQL 浏览场景足够）

### 4.2 状态机

每跳的生命周期状态机：

```
                        ┌─────────────────────┐
                        │      pending        │（初始状态，UI 灰色）
                        └──────────┬──────────┘
                                   │ ssh-multihop 开始建立这一跳
                                   ▼
                        ┌─────────────────────┐
                        │     connecting      │（UI 灰色 + spinner）
                        └──┬───────────────┬──┘
                           │               │
                connect 成功 / auth 通过      │ connect 失败 / auth 失败 /
                           │               │ channel 开启失败 / TOFU 拒绝
                           ▼               ▼
                ┌─────────────────────┐  ┌─────────────────────┐
                │     connected       │  │      failed         │（红，终态）
                │  (UI 绿色)           │  └─────────────────────┘
                └──────────┬──────────┘
                           │ keepalive 循环启动
                           ▼
                ┌─────────────────────┐
                │   keepalive_ok      │（与 connected 视觉等价）
                └──┬───────────────┬──┘
                   │               │
   keepalive 成功（60s 一次）       │ 连续 3 次失败（≈180s）
                   │               │
                   └─►─►─►─┘       ▼
                                ┌─────────────────────┐
                                │  keepalive_lost     │（红色闪烁，区别 failed）
                                │  TunnelLost { hop } │
                                └──────────┬──────────┘
                                           │ 用户点重连
                                           ▼
                                ┌─────────────────────┐
                                │     reconnecting    │（与 connecting 等价）
                                └─────────────────────┘
                                   │            │
                                   ▼            ▼
                              connected      failed
```

**说明**：

- `pending → connecting → connected` 是首次建立的正常路径
- `connected → keepalive_lost` 是 FR-014 keepalive 检测出来的断开
- v0.1 **不做自动重连**：lost 状态等用户手动点"重连"，进入 reconnecting
- `failed` 与 `keepalive_lost` 都是红色，但视觉区分：failed = 静态红边、lost = 闪烁红边 + toast

### 4.3 错误模型

`SshTunnelError` 全变体（v0.1）与对应 i18n key：

| 变体 | i18n key | 触发条件 | UI 表现 |
|---|---|---|---|
| `NoHops` | `error.ssh.no_hops` | hops 数组为空 | 配置错误 toast |
| `ConnectFailed { hop_index, reason }` | `error.ssh.connect_failed` | TCP connect 失败 / DNS 失败 | hop[i] 红边 |
| `AuthFailed { hop_index }` | `error.ssh.auth_failed` | 密码错 / 私钥无权限 | hop[i] 红边 |
| `InvalidPassphrase { hop_index }` | `error.ssh.invalid_passphrase` | passphrase 错 | hop[i] 红边 + 重新弹 passphrase |
| `KeyNotFound { hop_index }` | `error.ssh.key_not_found` | 私钥文件不存在 | hop[i] 红边 |
| `ChannelOpenFailed { hop_index, reason }` | `error.ssh.channel_open_failed` | direct-tcpip 开启失败 | hop[i] 红边 |
| `LocalListenFailed` | `error.ssh.local_listen_failed` | 本地端口绑定失败 | 全局错误 toast |
| `InvalidAuthType { hop_index }` | `error.ssh.invalid_auth_type` | auth_type 不是 password/privateKey | 配置错误 toast |
| `HostKeyMismatch { hop_index, host, port }` | `error.ssh.host_key_mismatch` | 已信任 host 公钥变更 | 硬拒绝，警告对话框 |
| `HostKeyRejected { hop_index }` | `error.ssh.host_key_rejected` | 用户 TOFU 弹窗拒绝 / 120s 超时 | hop[i] 红边 |
| **`TunnelLost { hop_index, reason }`** | `error.ssh.tunnel_lost` | keepalive 连续 3 次失败（**FR-014**） | hop[i] 闪烁红边 + toast |
| **`ChannelDropped { hop_index }`** | `error.ssh.channel_dropped` | 某跳 channel 被对端主动关闭（可能跳板重启） | hop[i] 红边 + toast"第 N 跳已断开，请重连" |
| **`AcceptLoopDied { hop_index }`** | `error.ssh.accept_loop_died` | 某跳 accept loop panic（代码 bug） | hop[i] 红边 + toast"遇到内部错误，请上报" |

> 三个 mid-session 变体（TunnelLost / ChannelDropped / AcceptLoopDied）覆盖运行中断开的三种 failure mode，重试策略独立：keepalive 超时可调阈值、channel drop 多半是跳板重启需人工重连、accept panic 是 bug 需上报。codex review 曾建议合并为统一连接状态机，v0.1 先用三个独立公共变体，若 dogfooding 发现 i18n key 膨胀，v0.2 重构（见 [ROADMAP v0.2 待定项](./ROADMAP.md#v02-待定项codex-review-surface实施期决定)）。

**稳定 i18n key 契约**（NFR-041）：每个变体的 i18n key 是公开 API 的一部分。新增变体可以加新 key，但已有 key 不能改名。前端翻译表向后兼容。

### 4.4 keepalive 机制（FR-014 详解）

```
SshTunnel 建立后:

┌──────────────────────────────────────────────────────────────┐
│ ssh-multihop::open() 返回 SshTunnel 之前，为每跳起 keepalive   │
│                                                                │
│  for (i, session) in sessions.iter().enumerate() {            │
│    let task = tokio::spawn(async move {                       │
│      let mut interval = tokio::time::interval(60s);           │
│      let mut fails = 0u8;                                       │
│      loop {                                                    │
│        interval.tick().await;                                  │
│        let guard = session.lock().await;                       │
│        match guard.send_keepalive().await {                    │
│          Ok(_) => { fails = 0; continue; }                     │
│          Err(e) => {                                           │
│            fails += 1;                                          │
│            if fails < 3 { continue; }  // 连续 3 次才判定断开    │
│            app_handle.emit("ssh:hop-status", payload {        │
│              connection_id, hop_index: i,                      │
│              status: "lost", reason: e.to_string()             │
│            });                                                  │
│            break;  // 退出循环，task 自然结束                    │
│          }                                                      │
│        }                                                        │
│      }                                                          │
│    });                                                          │
│    tunnel.keepalive_tasks.push(task);                         │
│  }                                                              │
└──────────────────────────────────────────────────────────────┘

SshTunnel::drop():

┌──────────────────────────────────────────────────────────────┐
│ impl Drop for SshTunnel {                                     │
│   fn drop(&mut self) {                                        │
│     self.accept_task.abort();                                 │
│     for t in &self.keepalive_tasks { t.abort(); }            │
│   }                                                            │
│ }                                                              │
└──────────────────────────────────────────────────────────────┘
```

**为什么 60s + 连续 3 次阈值**（eng review T2 调整，原 draft 是 30s + 1 次）：

- 30s 太激进：3 跳就是每 30s 三个 ping，多个连接窗口叠加；公司 bastion / VPN / 审计设备可能把高频 ping 当异常流量
- 1 次失败即报会误报：弱网偶尔丢包、bastion 短暂 ratelimit 都会触发假 lost
- 60s 间隔 + 连续 3 次失败（≈180s）才判定断开，平衡了"误报"和"感知速度"
- 180s 感知边界仍远胜 DBeaver/TablePlus 的"下次 query 才发现"（NFR-003）
- keepalive 间隔与失败阈值 v0.1 是常量，v0.2 做成可配置（见 [ROADMAP v0.2 工程](./ROADMAP.md#工程)）
- v0.2 可加"连续 2 次失败"作为更稳重的策略

### 4.5 与 sqlx 的桥接模式

**问题**：sqlx 的 `MySqlConnectOptions` 不支持注入自定义 `TcpStream`，只能给 URL。

**方案**：

1. SSH 隧道在 `127.0.0.1:0`（随机端口）起 listener，记录实际端口 P
2. 把 P 写到 `mysql://user:pass@127.0.0.1:P/db` URL 里
3. sqlx 用这个 URL 建 pool，每条 connection 会真的 TCP 连到 `127.0.0.1:P`
4. listener accept 一次 → spawn 一个 task → 在最后一跳 SSH session 上开 direct-tcpip channel 指向 MySQL → `copy_bidirectional(socket, ssh_stream)`

**多 connection 复用同一隧道**：

```
sqlx::MySqlPool (max_connections = 5)
   ├── connection 1 → TCP to 127.0.0.1:54321 ─┐
   ├── connection 2 → TCP to 127.0.0.1:54321 ─┤
   ├── connection 3 → TCP to 127.0.0.1:54321 ─┼─► local listener accept loop
   ├── connection 4 → TCP to 127.0.0.1:54321 ─┤
   └── connection 5 → TCP to 127.0.0.1:54321 ─┘
                                                 │
                                                 ▼
                                       每条 accept 后 spawn 一个 task：
                                       channel_open_direct_tcpip
                                       到 MySQL，然后 copy_bidirectional
                                                 │
                                                 ▼
                            首跳 SSH session 上有 5 个并发的 direct-tcpip channel
                            （不是 5 个 SSH session）
```

**生命周期绑定**：

- `MySqlDriverViaSshTunnel` 结构里同时持有 `tunnel: SshTunnel` 和 `pool: sqlx::MySqlPool`
- struct drop 时：先 drop pool（让正在用的连接被回收），再 drop tunnel（关 listener）
- 反过来不行：tunnel 先 drop 会导致 listener 关，pool 里的连接报 EOF，sqlx 会刷一堆错误日志

---

## 5. 加密 store 设计

### 5.1 连接配置加密

**目的**：用户的 host/user/password/private_key_path/SshHop 数组不能明文落盘。

**实现**：复用 redis-desktop-client 的 `config::encryption` 模块。

**算法**：AES-GCM-256。

**密钥派生**：v0.1 用应用内置的固定 key（**注意：这不是强安全，只是防止"打开文件就看到明文"的低门槛保护**）。理由：

- v0.1 用户多是技术人员，攻击场景是"别人短暂能看到我的硬盘"而不是"专业逆向工程"
- 用户主密码（更强方案）推 v0.2 一起跟 passphrase 加密做（FR-102）
- 现状定位：等同 macOS Keychain 用户体验，无需输密码即可使用

**文件格式**：

```
~/Library/Application Support/tiny-sql/connections.enc

文件内容（base64 编码）：
[12 字节 nonce] + [N 字节 AES-GCM ciphertext] + [16 字节 tag]

明文 JSON 结构：
{
  "version": 1,
  "connections": [
    {
      "id": "uuid",
      "name": "生产读库 RO",
      "mysql": { "host": "...", "port": 3306, "user": "...", "password": "..." },
      "ssh": {
        "enabled": true,
        "hops": [
          { "host": "...", "port": 22, "username": "...", "auth_type": "privateKey", "private_key_path": "~/..." },
          ...
        ]
      },
      "last_used_at": "2026-06-20T10:00:00Z"
    },
    ...
  ]
}
```

### 5.2 passphrase 不持久化

v0.1 SSH 私钥 passphrase **不写入 connections.enc**，也不写任何其他文件。

**生命周期**：

```
首次连接 → 前端弹 PassphraseDialog → invoke('ssh_set_passphrase', {connection_id, hop_index, passphrase})
                                          │
                                          ▼
src-tauri 把 passphrase 写到 AppState 的内存 HashMap<(conn_id, hop_index), String>
                                          │
                                          ▼
ssh-multihop::open 调用时从 ctx 里读 passphrase 用于这次握手
                                          │
                                          ▼
进程退出 → AppState drop → HashMap 释放 → passphrase 消失
```

**已知风险**：

- macOS 不阻止内存被换出到 swap，passphrase 可能短暂出现在 swap 文件里
- v0.1 不做 `mlock` 等防换出保护（best effort）
- v0.2 加用户主密码后，passphrase 可加密存盘，避免每次启动重新输

---

## 6. TOFU 流程时序图

```
前端                       src-tauri                  ssh-multihop              远端 SSH server
 │                            │                            │                          │
 │ invoke(connection_open, id)│                            │                          │
 │───────────────────────────>│                            │                          │
 │                            │ ssh_multihop::open(...)    │                          │
 │                            │───────────────────────────>│                          │
 │                            │                            │ TCP connect              │
 │                            │                            │─────────────────────────>│
 │                            │                            │<── SSH version exchange ─│
 │                            │                            │<── server pubkey ────────│
 │                            │                            │                          │
 │                            │                            │ KnownHostsValidator      │
 │                            │                            │ ::check_server_key       │
 │                            │                            │                          │
 │                            │                            │ known_hosts.find(host)   │
 │                            │                            │  → None (未知主机)        │
 │                            │                            │                          │
 │                            │                            │ tofu_manager.register    │
 │                            │                            │  (conn_id, hop_index)    │
 │                            │                            │  → oneshot::Receiver     │
 │                            │                            │                          │
 │ ssh:tofu-request event     │                            │                          │
 │<───────────────────────────────────────────────────────│                          │
 │ payload: {                  │                            │                          │
 │   connection_id,            │                            │                          │
 │   hop_index,                │                            │                          │
 │   host, port,               │                            │                          │
 │   fingerprint               │                            │                          │
 │ }                           │                            │                          │
 │                            │                            │ rx.await (含 120s 超时)   │
 │ 弹 SshTofuDialog            │                            │  ← (阻塞等待)             │
 │ "信任并继续 / 拒绝"            │                            │                          │
 │                            │                            │                          │
 │ 用户点"信任并继续"             │                            │                          │
 │ invoke('ssh_tofu_decision',│                            │                          │
 │   {conn_id, hop_idx, true})│                            │                          │
 │───────────────────────────>│                            │                          │
 │                            │ tofu_manager.respond(true) │                          │
 │                            │   通过 oneshot sender 唤醒  │                          │
 │                            │───────────────────────────>│                          │
 │                            │                            │ 写 known_hosts.trust(    │
 │                            │                            │   host, port, fingerprint│
 │                            │                            │ )                        │
 │                            │                            │                          │
 │                            │                            │ 返回 Ok(true)             │
 │                            │                            │ check_server_key 完成     │
 │                            │                            │                          │
 │                            │                            │ 继续 SSH 握手 + auth      │
 │                            │                            │─────────────────────────>│
 │                            │                            │<─── connected ───────────│

超时分支（用户 120s 不响应）：

 │ (无响应)                    │                            │                          │
 │                            │                            │ tokio::time::timeout(    │
 │                            │                            │   120s, rx) → Err(Elapsed│
 │                            │                            │                          │
 │                            │                            │ tofu_manager.cleanup     │
 │                            │                            │ check_server_key → false │
 │                            │                            │ 整个 open() 返回         │
 │                            │                            │   HostKeyRejected         │
 │                            │ Err(HostKeyRejected)       │                          │
 │<───────────────────────────│                            │                          │
 │ toast: "TOFU 决策超时"       │                            │                          │
```

**关键点**：

- 弹窗 120s 超时由后端控制，前端不需要自己起 timer（避免前端 unmount 后超时机制丢失）
- 用户拒绝、超时、网络错误三种情况都走 `HostKeyRejected`（不再细分，前端不需要区分用户拒绝 vs 超时）
- known_hosts 写入失败也按拒绝处理（避免"已用户同意但没存盘"的不一致状态）

---

## 7. 前后端事件契约

### 7.1 invoke command 列表

详见 §3.3 表格。

### 7.2 event 列表

事件流向：**src-tauri → 前端**（前端 listen，没有反向）。

| Event 名 | Payload | 触发时机 | 前端处理 |
|---|---|---|---|
| `ssh:tofu-request` | `{connection_id, hop_index, host, port, fingerprint}` | 后端遇到未知 host key | 弹 `SshTofuDialog` |
| `ssh:hop-status` | `{connection_id, hop_index, status, latency_ms?, reason?}` | 隧道每跳状态变化 | zustand store 更新 hop 状态 → 拓扑节点重渲染 |
| `query:result-chunk` | `{query_id, rows_partial, done: false}` | （v0.2 才用）流式结果 | v0.1 不用此 event，query 全量返回 |
| `app:log` | `{level, message, target}` | 后端日志同步（tauri-plugin-log） | DevTools console |

### 7.3 ssh:hop-status 详细 schema

```typescript
type SshHopStatus = "pending" | "connecting" | "connected" | "failed" | "lost";

interface SshHopStatusPayload {
  /** 哪个连接的哪一跳 */
  connection_id: string;
  hop_index: number;        // 0-based

  /** 状态枚举 */
  status: SshHopStatus;

  /** 仅 connected 状态下有意义；v0.1 暂不实现（推 v0.2 实时延迟动画） */
  latency_ms?: number;

  /** 仅 failed/lost 状态下有值；带 i18n key 或具体描述 */
  reason?: string;
}
```

**状态对应的 UI**：

| status | 节点颜色 | 边动效 | 旁注 |
|---|---|---|---|
| `pending` | 灰色 | 无 | - |
| `connecting` | 灰色 | 流动 | spinner |
| `connected` | 绿色 | 静态绿 | - |
| `failed` | 红色 | 静态红 | tooltip 显示 reason |
| `lost` | 红色 | **闪烁红**（区别 failed） | toast + tooltip 显示 reason |

### 7.4 连接配置 schema（落盘前）

```typescript
interface ConnectionConfig {
  id: string;            // uuid
  name: string;
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;   // 默认 database
  };
  ssh: {
    enabled: boolean;
    hops: SshHop[];
  };
  last_used_at?: string; // ISO 8601
}

interface SshHop {
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "privateKey";
  password?: string;            // 落盘
  private_key_path?: string;    // 落盘
  // passphrase 字段不落盘；前端表单字段在保存时被剥离
}
```

---

## 8. 安全考虑

### 8.1 仅本地业务通信

- tiny-sql 不上传连接配置、SQL、查询结果或错误日志。
- 业务通信只访问用户配置的 SSH/MySQL 目标；自动更新只访问 GitHub Release 的正式版更新清单。
- 无遥测、无错误上报。
- 这是开源信任的前提

### 8.2 known_hosts 隔离

- tiny-sql 的 SSH known_hosts 写到 `~/Library/Application Support/tiny-sql/known_hosts.json`
- **不读、不写** `~/.ssh/known_hosts`（NFR-012）
- 理由：不污染用户的 OpenSSH 信任域，避免"在 tiny-sql 上信任了某 host 后，cli ssh 也莫名其妙能连"

### 8.3 host key 变更硬拒绝

- 已信任主机的公钥指纹变化 → `SshTunnelError::HostKeyMismatch`
- UI 显示明确的中间人攻击警告对话框
- **不提供"忽略"按钮**（不能让用户因为方便就降低安全）
- 用户必须手动删 known_hosts.json 对应条目后重新 TOFU

### 8.4 SQL 写操作二次确认

FR-024 描述。正则 `/^\s*(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|GRANT|CREATE|REPLACE)\b/i`。

预处理：去掉 SQL 注释（`-- ...` 和 `/* ... */`）和字符串字面量（`'...'` / `"..."`）后再匹配，避免伪命中。

### 8.5 进程隔离

- Tauri 默认 webview 与 native 隔离，前端 JS 不能直接调 native API（必须通过 invoke）
- `capabilities/default.json` 写最小集，只授权用得到的 plugin commands
- 不开启 `withGlobalTauri`，避免 webview 全局污染

### 8.6 加密 store 的不强但够用承诺

§5.1 已说明：v0.1 用内置固定 key，**不是强加密**，定位等同"防止打开文件就看到明文"。用户应该理解这一点：

- 物理拿到笔记本 → 用 strings 命令在 connections.enc 上看不到明文，但用 grep 在二进制 tiny-sql 里能拿到 key（然后解密 .enc）
- 这个等级足够防同事偷瞄屏幕、防误拷贝硬盘到云盘
- 不足以防针对性攻击（v0.2 上用户主密码后增强）

---

## 9. 性能与扩展性预期

| 维度 | v0.1 假设 | v0.2 规划 |
|---|---|---|
| schema 数量 | ≤ 30 | LRU cache + 搜索 |
| 表数量/schema | ≤ 200 | 同上 + 分页 |
| 单 query 结果集 | ≤ 10w 行（客户端截断） | 流式 chunk + 分页 |
| 连接池大小 | 5（max_connections） | 用户可配置 |
| SSH 跳数 | 测试到 3 跳（无硬上限） | 同 v0.1 |
| 隧道吞吐 | 3 跳 ~60-80MB/s 单连接 | 不优化 |
| 隧道断开感知 | 180s（keepalive 60s × 连续 3 次） | 间隔 + 阈值可配置 |

---

## 10. 测试策略

### 10.1 单元测试

| crate | 重点 |
|---|---|
| `ssh-multihop` | SshTunnelError i18n key 稳定性 / expand_home_path / keepalive task 在 SshTunnel drop 时被 abort |
| `db-driver` | MySqlDriver 各方法 / 子查询包装 LIMIT（含 ORDER BY/UNION/CTE 不破坏语义）/ 10w 行截断阈值 / cancel_token + control conn KILL QUERY |
| `src-tauri` | 加密 store round-trip / known_hosts.json 读写 / TOFU manager 超时清理 |

### 10.2 集成测试（不用 Docker，连用户本地 MySQL）

- integration 通过 `TINY_SQL_TEST_MYSQL_URL` env var 连**用户本地 MySQL 服务器**（不起 Docker），本地跑：
  ```bash
  TINY_SQL_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/test cargo test -p db-driver
  ```
- 测试用例：单跳 + MySQL SELECT 1 / 子查询包装 LIMIT / KILL QUERY 后 processlist 消失 / 故意挂 SSH 端口验 hop_index 错误
- **CI 不跑 integration**（无 MySQL 服务器）；MySQL 5.7 兼容验证推到 dogfooding 期找用 5.7 的同事验证
- 3 跳故障测试 + 嵌入式 russh-server 测试推到连接核心稳定后（Week 3），v0.1 Week 2 先 mock 或单跳

### 10.3 端到端测试

- Week 2 一次架齐 `playwright`（Tauri 2 模式）+ `vitest` 前端单测，CI 跑 playwright headless
- dogfooding（FR-041）作为补充 E2E 验证

---

## 11. 与现有项目的关系

### 11.1 与 redis-desktop-client 的复用面

| 模块 | 复用方式 |
|---|---|
| `ssh_tunnel.rs` | 整个复制到 `crates/ssh-multihop`，扩展 hop_index + 三个 mid-session 变体（TunnelLost/ChannelDropped/AcceptLoopDied）+ keepalive |
| `config/encryption.rs` | 复制到 `src-tauri/src/config/encryption.rs`（无修改） |
| `config/ssh_known_hosts.rs` | 复制（无修改） |
| `config/store.rs` | 改造：把 RedisConnection 换成 MySqlConnection |
| 前端 connection-dialog | 改造：SshHop 数组编辑器复用，MySQL 字段重写 |
| 前端 ssh-tofu-dialog | 直接复用 |
| Next.js + Tauri 集成配置 | 直接复用（next.config.ts / tsconfig.json / postcss.config.mjs） |

### 11.2 与 redis-desktop-client 的不同

- tiny-sql 是 workspace；redis-desktop-client 是单 crate
- tiny-sql v0.1 用具体 `struct MySqlDriver`（v0.2 加 PG 时 extract trait）；redis-desktop-client 直接用 `redis` crate
- tiny-sql 引入 `@xyflow/react` 拓扑图；redis-desktop-client 无此组件
- tiny-sql 加 SSH keepalive 60s + 3 次阈值（FR-014）；redis-desktop-client 仅靠 russh 3600s inactivity timeout

---

## 附录 A：术语对照

| 术语 | 同义词 | 备注 |
|---|---|---|
| schema | database | MySQL 里这俩是同义词 |
| hop | jump / bastion | 一跳 SSH 节点 |
| TOFU | first-use trust | Trust On First Use |
| direct-tcpip | port forwarding | SSH 协议标准 channel 类型 |
| keepalive | heartbeat | russh 的 `send_keepalive()` |
| TunnelLost | dead tunnel | 已建立隧道因 keepalive 失败而失活 |

## 附录 B：与设计文档的对齐

本架构遵循 [设计文档](/Users/kurisu/.gstack/projects/tiny-sql/kurisu-main-design-20260626-162200.md) 的 Approach B（Clean Workspace），并补充：

1. **SSH keepalive 机制**（§4.4，FR-014）：设计文档未写，eng review 拍板加入
2. **状态机 lost 状态**（§4.2）：keepalive 失败的视觉区分
3. **每个 SshTunnelError 变体都带 hop_index**（§4.3）：FR-013 完整实现
