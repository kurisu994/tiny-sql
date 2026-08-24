---
title: tiny-sql 架构设计
version: 0.7.0
status: awaiting-acceptance
last_updated: 2026-08-24
---

# tiny-sql 架构设计

> 配套文档：[REQUIREMENTS.md](./REQUIREMENTS.md) · [PLAN.md](./PLAN.md) · [ROADMAP.md](./ROADMAP.md)

## 0. 阅读指南

本文回答四件事：

1. **代码怎么分层**（§1 / §3）：3 个 Rust crate + Tauri 壳 + Next.js 前端
2. **一条 SQL 怎么跑完全链路**（§2 数据流图）
3. **SSH 多跳隧道的协议机制、状态机、错误模型**（§4）
4. **前后端怎么对话**（§7 事件契约）

不在本文范围：具体代码实现（去看 PR）；后续版本规划见 [ROADMAP.md](./ROADMAP.md)。

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
│       ├── src/lib.rs             # 公共契约 + MySqlDriver + SQL guard + 多语句拆分器
│       ├── src/postgres.rs        # PostgresDriver metadata/query/cancel/browse/session
│       ├── src/session.rs         # DriverSession 独占 session 契约（FR-244）
│       └── tests/                 # MySQL/PostgreSQL 本地 integration（#[ignore]）
├── src-tauri/                     # Tauri 壳（Cargo.toml 是 workspace 成员）
│   ├── Cargo.toml                 # 依赖 ssh-multihop + db-driver
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── lib.rs                # Tauri 入口 + 全部 #[tauri::command] 注册
│       ├── commands/             # tauri command 层
│       │   ├── connection.rs     # connection_create / list / update / delete / test / open / reconnect / close
│       │   ├── query.rs          # db_list_* / db_query / db_query_many / db_browse_table / db_apply_table_edits / db_create_database
│       │   ├── transaction.rs    # transaction_begin / query / commit / rollback / close（FR-244）
│       │   ├── import.rs         # csv_import_preview / db_import_csv（FR-252）
│       │   ├── dump.rs           # db_export_dump / db_import_dump（FR-252）
│       │   ├── backup.rs         # backup_probe_tools / db_backup_export / db_backup_restore（FR-260）
│       │   ├── copy.rs           # db_copy_preview / db_copy_table_rows（FR-266）
│       │   ├── privilege.rs      # db_list_accounts / db_show_grants（FR-262）
│       │   ├── share.rs          # connection_share_export / preview / import（FR-221）
│       │   ├── sql_file.rs       # sql_file_read / write / recent_list / touch / remove（FR-240）
│       │   ├── security.rs       # security_status / setup / unlock / lock / disable / reset（FR-102）
│       │   ├── history.rs        # history_list / history_clear（FR-106）
│       │   ├── export.rs         # db_export_query（CSV / Excel 流式导出，FR-107）
│       │   └── ssh_tofu.rs       # ssh_tofu_decision
│       ├── config/
│       │   ├── encryption.rs     # AES-GCM 加密 + master key / Argon2id 主密码 KDF
│       │   ├── store.rs          # 连接配置序列化（扁平 Vec<StoredConnection>，v1/v2 envelope 嗅探）
│       │   ├── history.rs        # SQL 历史加密落盘（history.enc，100 条上限）
│       │   ├── recent_files.rs   # 最近 SQL 文件列表（recent_files.json 明文，FR-240）
│       │   └── ssh_known_hosts.rs # 自有 known_hosts.json
│       ├── security.rs           # SecurityManager（主密码状态机 / 迁移回滚 / secrets map）
│       ├── tofu.rs               # SshTofuManager（TOFU 决策通道）
│       └── state.rs              # AppState（连接注册表 / 事务 session / passphrase 缓存 / security / history / recent_files）
├── src/                           # Next.js 16 前端
│   ├── app/                       # App Router pages
│   ├── components/                # 含 compare-view / er-view / privilege-view / alter-table / backup / share
│   ├── lib/                       # tauri-api / ddl / schema-diff / schema-sync / schema-er / table-copy / privilege / explain
│   ├── stores/                    # session.openSessions：切换焦点不关旧连接
│   └── hooks/
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
│  pub trait Driver        │  │  pub async fn open(           │
│  pub struct MySqlDriver  │  │    hops: &[SshHop],           │
│  pub struct PostgresDriver│ │    target_host: &str,         │
│   - ping                 │  │    target_port: u16,          │
│   - list_databases       │  │    ctx: &TunnelContext,       │
│   - list_schemas         │  │  ) -> Result<SshTunnel, ...>  │
│   - list_tables          │  │                                │
│   - list_columns         │  │                                │
│   - list_indexes         │  │                                │
│   - list_constraints     │  │                                │
│   - query (可取消)        │  │                                │
│   - query_many (多语句)   │  │  - 逐跳 SSH session 建立        │
│   - browse_table         │  │  - 每跳 keepalive 60s/3 次      │
│   - begin_session (事务)  │  │  - TOFU 流程                   │
│   - apply_table_edits    │  │  - 本地 127.0.0.1:0 listener   │
│   - bulk_insert_rows     │  │  - copy_bidirectional 桥接     │
│   (对象安全装箱 Future)   │  │  - SshTunnelError 含 hop_index │
│   (sqlx MySql/Pg pool)   │  │                                │
│   (不知道 SSH 存在)      │  │                                │
└──────────────────────────┘  └──────────────────────────────┘
```

**分工原则**：

- `ssh-multihop` **完全不知道 MySQL 存在**。它只知道"在本地监听一个端口，把流量转发到远端 host:port"。这是它未来能独立 publish 的前提。
- `db-driver` **完全不知道 SSH 存在**。已从 MySQL 真实调用面提取对象安全的最小 `Driver` 契约，`MySqlDriver` 与 `PostgresDriver` 双实现落地；连接创建和方言专属配置仍由具体 driver/factory 负责。
- `src-tauri` 是组装层：走 SSH 时先打开隧道拿本地端口，再按配置创建 `MySqlDriver` 或 `PostgresDriver` 连 `127.0.0.1:port`，并在 `OpenConnection` 里绑定 driver 与 tunnel 生命周期。

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

功能等价。开源解耦弱一点（`ssh-multihop` 不能独立 publish）但保 ship。该兜底已在 CP-1 验证后关闭，不再列入当前待办计划；历史记录见 [progress.md](../memory-bank/progress.md)。

---

## 2. 数据流

### 2.1 一条 SQL 的完整链路

用户在前端 SQL 编辑器点"执行"或按 `Cmd/Ctrl+Enter` 开始，到结果回到 UI 表格，全链路如下。**实线**是数据/调用方向，**虚线**是错误回流方向。

```
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js 16 前端 (WebView)                                            │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ CodeMirror SQL ───执行/快捷键──> sessionStore.executeSql(sql)    │  │
│  │                                          │                     │  │
│  │                                          ▼                     │  │
│  │   invoke('db_query', { id, sql, query_id,                    │  │
│  │                        row_limit, allow_write })              │  │
│  │                                          │                     │  │
│  └──────────────────────────────────────────┼─────────────────────┘  │
└─────────────────────────────────────────────┼─────────────────────────┘
                                              │ Tauri IPC
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src-tauri (commands 层)                                              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #[tauri::command]                                              │  │
│  │ async fn db_query(state, id, sql, query_id,                  │  │
│  │                   row_limit, allow_write) {                  │  │
│  │   let driver = driver_of(&state, &id).await?;                  │  │
│  │   let token = CancellationToken::new();                        │  │
│  │   state.queries.lock().await.insert(query_id, token.clone());  │  │
│  │   Driver::query(&driver, sql, QueryOptions {                   │  │
│  │     row_limit, allow_write                                     │  │
│  │   }, token).await                                              │  │
│  │ }                                                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────┬─────────────────────────┘
                                              │ Driver 契约调用
                                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  crates/db-driver                                                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Driver::query → MySqlDriver::query_with_options               │  │
│  │   (sql, options, cancel_token)                                 │  │
│  │   ├─ self.pool: MySqlPool（max=5）                              │  │
│  │   ├─ prepare_query_sql：拒多语句 / 写确认 / 顶层安全追加 LIMIT       │  │
│  │   ├─ sqlx::query(prepared.sql).fetch(&self.pool)               │  │
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
│  MySqlDriver::query_with_options 返回 RowSet                          │
│         │                                                             │
│         ▼ tauri command 返回                                          │
│  前端 zustand store 收到 RowSet → react-virtuoso 渲染                   │
└─────────────────────────────────────────────────────────────────────┘
```

**错误回流路径**（虚线）：

- MySQL 服务端错误 → sqlx → `MySqlDriver::query_with_options` 返回 `Err(DriverError::QueryFailed)` → command 层 → 前端提示
- 隧道断开（hop[i] keepalive 失败）→ `ssh-multihop` 内部 task emit `ssh:hop-status` event（**不经 query 返回路径**，直接走事件总线）→ 前端 zustand 更新 hop 状态 → 拓扑节点变红
- 同时：正在进行的 query 会因为 TCP RST 而失败，回到前端 toast"连接已断开"

### 2.2 关键设计决策

- **本地 listener + sqlx**：sqlx 不支持注入自定义 `TcpStream`，所以必须走"本地端口 + URL"模式。详见 §4.5。
- **多连接复用同一隧道**：1 个 tiny-sql 连接 = 1 个本地端口 = 1 个 pool（`MySqlPool` / `PgPool`，max=5）。Pool 里 5 条 TCP 都走同一个本地端口；每条 TCP 触发 listener accept 一次，spawn 一个 channel_open_direct_tcpip。所以**首跳 SSH session 上会有 5 个 direct-tcpip channel**（不是 5 个 SSH session）。
- **隧道生命周期绑定 pool**：tunnel drop → listener drop → sqlx 连接全部报 connection refused → pool drop → AppState 清掉 driver。

### 2.3 前端依赖

| 依赖 | 用途 |
|---|---|
| `next` 16.1.6 | App Router |
| `react` 19.2.x | UI |
| `@tauri-apps/api` 2.10.x | IPC + event |
| `@tauri-apps/plugin-{process,dialog,updater}` 2.x | 重启应用 + 文件选择器 + 自动更新 |
| `codemirror` + `@codemirror/lang-sql` / `lint` / `state` / `view` | SQL 编辑器、双方言高亮、schema/table 补全和错误 gutter |
| `sql-formatter` ^15 | SQL 格式化（按连接方言） |
| `react-virtuoso` ^4.18 | 1000 行/10w 行虚拟滚动 |
| `zustand` ^5 | 全局状态 |
| `shadcn` + `radix-ui` + `tailwindcss` 4 | UI 组件 |
| `lucide-react` | 图标 |

> 拓扑图当前用纯 CSS 线性布局，不引入 `@xyflow/react`；错误翻译 v0.1 用前端静态 `ERROR_ZH` map，完整 i18next runtime 留后续英文 UI 时接入。

### 2.4 前端 metadata cache（v0.2）

`src/lib/metadata-cache.ts` 提供纯内存 LRU，默认最多 128 项、TTL 5 分钟。key 固定包含 `connectionId + driver + database + schema + resource + table?`，其中 resource 为 schemas / tables / columns / indexes / constraints；不能以同名 database/schema/table 复用其他连接或 driver 的结果。读取命中会提升最近使用顺序，过期项在读取时删除，进程退出后不保留。

`session-store` 在 schema、table、column 按需加载时先查 cache；连接重开/关闭、新建 database 及成功执行 CREATE / ALTER / DROP / TRUNCATE / RENAME / COMMENT 后清除该连接的全部 metadata。树顶部“刷新”会失效当前 database 下的分区并重新请求 database、schema、table 和当前展开列。

所有 metadata 操作共享单调递增的 request epoch。每次选择 database/schema/table、刷新、建库或 DDL 失效都会开始新 epoch 或使旧 epoch 失效；异步响应在写 UI 和 cache 前必须同时核对 epoch 与 connection/database/schema/table。仅比较名称不能防住 A→B→A：最早的 A 返回时名称再次相同，仍会覆盖最新 A；epoch 用于消除该 ABA 竞态。

### 2.5 Schema-aware SQL completion（v0.2）

`src/lib/sql-completion.ts` 是 React/CodeMirror 组件之外的纯 metadata 适配层。编辑器按连接 driver 选择 `MySQL` 或 `PostgreSQL` dialect；MySQL 以 database、PostgreSQL 以 schema 作为 CodeMirror `defaultSchema`。用户在对象树展开过的列会按 table 累积在当前 session，CodeMirror 原生 schema completion 据此提供 column 与 alias 补全，列候选附带类型、nullable、key 和 comment。

JOIN 候选不读取或假造 FOREIGN KEY：只使用实际加载的列元数据，按 `target_id → target.id`、反向关系或同名 key/id 列做保守启发式。输入 `JOIN <prefix>` 时，自定义 completion source 返回 `target ON source.column = target.column` 片段；目标列元数据未加载或关系不明确时不提供候选。解析器跳过字符串/注释并支持 MySQL 反引号、PostgreSQL 双引号及 schema-qualified table。

---

## 3. crate 详解

### 3.1 crates/ssh-multihop

**职责**：建立 N 跳 SSH 隧道，在本地暴露一个 TCP 端口，把流量桥接到远端 host:port。完全不知道上层应用是什么。

**导出 API**（Rust 伪签名，公共类型用中文 doc comment）：

```rust
/// 单跳信息 — 顺序敏感：hops[0] 是本地直连的第一跳，hops[N-1] 是出口
pub struct SshHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

/// 单跳认证方式
pub enum SshAuth {
    Password(String),
    PrivateKey { path: String, passphrase: Option<String> },
}

/// 建立 / 运行隧道所需的回调上下文 — 保持 ssh-multihop 不依赖 Tauri
pub struct TunnelContext {
    pub status_cb: Option<HopStatusCallback>,
    pub rtt_cb: Option<HopRttCallback>,
    pub verifier: Option<HostKeyVerifier>,
    pub keepalive: KeepaliveConfig,
}

/// 单次 SSH 协议 RTT 采样；多跳时是本机累计到对应 session 的往返时间
pub enum HopRttSample {
    Measured(std::time::Duration),
    TimedOut,
    Unavailable,
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
    hops: &[SshHop],
    target_host: &str,
    target_port: u16,
    ctx: &TunnelContext,
) -> Result<SshTunnel, SshTunnelError>;
```

**实现要点**（来自 redis-desktop-client 复用 + tiny-sql 扩展）：

1. **逐跳建立**：hops[0] 用 `TcpStream::connect` 直连；hops[1..] 用前一跳的 channel `into_stream()` 当 transport，给 `client::connect_stream` 用。
2. **每跳认证**：`authenticate_hop()` 按 `auth_type` 分支调 password 或 publickey；publickey 自动协商 RSA 最佳 hash 算法。
3. **session actor 全链路保活**：russh `Handle` 含非 `Sync` receiver，每跳由一个 session actor 独占；调用方只持可 clone 的 `SharedSession` 命令端。`SshTunnel._sessions` 保持整条链的 actor 引用，中间任何一跳提前结束都会使后续 transport channel 失活。
4. **本地 listener loop**：`tokio::spawn` 的循环里 accept → `tokio::spawn` 一个新 task → 通过最后一跳 actor 打开 direct-tcpip → `copy_bidirectional(socket, stream)`。
5. **keepalive task**（**FR-014**）：`TunnelContext.keepalive` 把高级设置转换为 russh `keepalive_interval` / `keepalive_max`，默认 60s / 连续 3 次；关闭时 interval 为 `None`。每跳另起轻量监控 task 周期只读 actor 的 `closed` 原子标记，session 退出后 emit `ssh:hop-status` `{status: "lost"}`，不会额外发送心跳。监控 task handle 存到 `SshTunnel.keepalive_tasks`，drop 时一起 abort；`TunnelHandler::disconnected`、accept monitor 与每跳原子标记分别覆盖 channel/首跳/worker 故障、正常关闭抑制和重复事件去重。
6. **RTT task**（**FR-105**）：仅在 `TunnelContext.rtt_cb` 存在时为每跳启动低频采样；actor 调 russh `send_ping()` 测量 SSH global-request 往返时间。探测等待期间用有偏 `select!` 优先处理 direct-tcpip 命令，避免 RTT 超时阻塞数据库新连接；采样结果只走独立指标事件，不改变连接四态。

**known_hosts 存储**：自有 store，路径 `~/Library/Application Support/tiny-sql/known_hosts.json`。结构为 `{ "host:port": "sha256:xxx", ... }`。**不读、不写** `~/.ssh/known_hosts`（NFR-012）。

**单测覆盖**：
- `SshTunnelError::i18n_key()` 稳定性（公开 API 契约）
- `error_reports_hop_index`：各变体带/不带 `hop_index` 的归因
- `KeepaliveConfig`：默认值、关闭状态、0 值归一化与 russh `N-1` 阈值换算
- `HopRttEvent`：按跳携带 measured / timeout / unavailable 采样，Tauri payload 保留 connection/session 边界
- `expand_home_path` 各种 ~ 前缀

### 3.2 crates/db-driver

**职责**：给上层 commands 层一个统一的数据库访问接口。v0.2 已从 `MySqlDriver` 的真实调用面提取对象安全的最小 `Driver` 契约，使用装箱 Future 避免新增 `async-trait` 依赖。连接创建和方言专属对象操作留在具体实现；通用契约只覆盖 ping、metadata、query/取消与 close。

**核心契约**（v0.2 V2-T1.1）：

```rust
pub trait Driver: Send + Sync {
    fn kind(&self) -> DriverKind;
    fn ping(&self) -> DriverFuture<'_, i64>;

    /// 列出所有可见 database，并标记当前连接所在 database
    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>>;

    /// 列出指定 database 下的 schema
    fn list_schemas<'a>(&'a self, database: &'a str)
        -> DriverFuture<'a, Vec<SchemaMeta>>;

    /// MetadataScope 显式携带 database + 可选 schema
    fn list_tables<'a>(&'a self, scope: &'a MetadataScope)
        -> DriverFuture<'a, Vec<TableMeta>>;

    fn list_columns<'a>(&'a self, scope: &'a MetadataScope, table: &'a str)
        -> DriverFuture<'a, Vec<ColumnMeta>>;

    /// 执行任意 SQL，支持 row_limit、写操作确认和取消
    ///
    /// - `cancel_token`：由 command 注册表保存，取消时触发
    /// - 拒空 SQL / 多语句；非 SELECT/WITH/元数据 需 allow_write=true
    /// - SELECT/WITH 顶层安全时在末尾追加 `LIMIT <row_limit + 1>`
    ///   （多取 1 行用于判断 truncated；返回前丢弃第 limit+1 行）。
    ///   顶层已含 LIMIT/FOR/LOCK/INTO/PROCEDURE 时不追加，靠客户端截断兜底
    /// - row_limit 后端 clamp 到 1..=100000，防 OOM
    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: tokio_util::sync::CancellationToken,
    ) -> DriverFuture<'a, RowSet>;

    /// v0.3（FR-241）：列出表的索引与约束
    fn list_indexes<'a>(&'a self, scope: &'a MetadataScope, table: &'a str)
        -> DriverFuture<'a, Vec<IndexMeta>>;
    fn list_constraints<'a>(&'a self, scope: &'a MetadataScope, table: &'a str)
        -> DriverFuture<'a, Vec<ConstraintMeta>>;

    /// v0.3（FR-242）：服务端筛选 / 排序 / 分页浏览表数据；
    /// 列白名单在 command 层强制，driver 负责标识符转义 + 值参数化
    fn browse_table<'a>(&'a self, scope: &'a MetadataScope, table: &'a str,
        query: &'a TableBrowseQuery, cancel_token: CancellationToken)
        -> DriverFuture<'a, TableBrowseResult>;

    /// v0.3（FR-244）：建立独占 session（已 BEGIN），事务内语句固定同一物理连接
    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>>;

    /// v0.3（FR-243）：多语句脚本拆分逐条执行，首错/取消中止；事务语句整体拒绝
    fn query_many<'a>(&'a self, sql: &'a str, options: QueryOptions,
        cancel_token: CancellationToken) -> DriverFuture<'a, MultiQueryResult>;

    /// v0.4（FR-250）：短事务批量应用表编辑；后端权威校验主键，
    /// 失败整体回滚并定位语句序号；影响行数 ≠ 1 报冲突
    fn apply_table_edits<'a>(&'a self, scope: &'a MetadataScope, table: &'a str,
        pk_columns: &'a [String], edits: &'a [TableEdit], cancel_token: CancellationToken)
        -> DriverFuture<'a, ApplyEditsResult>;

    /// v0.4（FR-252）：批量插入（不要求主键）；中止模式批内事务回滚，
    /// 跳过模式逐行 autocommit 收集失败行号
    fn bulk_insert_rows<'a>(&'a self, scope: &'a MetadataScope, table: &'a str,
        columns: &'a [String], rows: &'a [Vec<Option<String>>], transactional: bool,
        cancel_token: CancellationToken) -> DriverFuture<'a, BulkInsertResult>;

    /// 关闭主 pool 和 control pool
    fn close(&self) -> DriverCloseFuture<'_>;
}

/// v0.3（FR-244）：绑定单条物理连接的独占 session
pub trait DriverSession: Send {
    fn query<'a>(&'a mut self, sql: &'a str, options: QueryOptions,
        cancel_token: CancellationToken) -> DriverFuture<'a, RowSet>;
    fn commit(&mut self) -> DriverFuture<'_, ()>;
    fn rollback(&mut self) -> DriverFuture<'_, ()>;
    /// 结束 session：未提交事务先回滚再归还/销毁连接；幂等
    fn close(&mut self) -> DriverCloseFuture<'_>;
    /// 含 PostgreSQL aborted 状态（需 ROLLBACK 恢复）
    fn in_transaction(&self) -> bool;
}

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("error.driver.connect_failed")]
    ConnectFailed(String),
    #[error("error.driver.query_failed")]
    QueryFailed(String),
    #[error("error.driver.invalid_sql")]
    InvalidSql,
    #[error("error.driver.multiple_statements")]
    MultipleStatements,
    #[error("error.driver.write_requires_confirmation")]
    WriteRequiresConfirmation,
    #[error("error.driver.query_cancelled")]
    QueryCancelled,
    #[error("error.driver.invalid_identifier")]
    InvalidIdentifier,
    #[error("error.driver.database_switch_required")]
    DatabaseSwitchRequired,
    #[error("error.driver.schema_required")]
    SchemaRequired,
    // v0.2：MySQL TLS 握手 / 证书校验失败（仅在用户显式启用 TLS 时分类）
    #[error("error.driver.tls_handshake_failed")]
    TlsHandshakeFailed,
    #[error("error.driver.tls_verify_failed")]
    TlsVerifyFailed,
    // v0.3：事务控制语句必须走独占 session
    #[error("error.driver.tx_requires_session")]
    TxRequiresSession,
    #[error("error.driver.session_not_in_transaction")]
    SessionNotInTransaction,
    #[error("error.driver.session_broken")]
    SessionBroken,
    // v0.4：表格编辑与批量导入
    #[error("error.driver.no_primary_key")]
    NoPrimaryKey,
    #[error("error.driver.edit_apply_failed")]
    EditApplyFailed { index: usize, detail: String },
    #[error("error.driver.edit_conflict")]
    EditConflict { index: usize },
}

**v0.3 扩展点说明**：

- **独占 session 事务模型（FR-244）**：`begin_session` 从主 pool 取一条连接并立即
  BEGIN；session 内语句通过 `&mut self` 编译期互斥串行。MySQL 结束用
  `RESET CONNECTION`（5.7.3+）一次性清理会话状态归还 pool；PostgreSQL 用
  `ROLLBACK` + `RESET ALL; CLOSE ALL; DISCARD TEMP`（刻意避开 `DISCARD ALL`，
  它会清空 sqlx 的 prepared statement cache）。清理失败统一 `close_on_drop`
  销毁连接，由服务端在连接关闭时兜底回滚。事务控制语句（BEGIN/COMMIT/ROLLBACK/
  SAVEPOINT）在 guard 单独分类：pool 路径拒绝（`tx_requires_session`），session
  路径免写确认并跟踪 `in_transaction`（含 `COMMIT AND CHAIN` 与
  `ROLLBACK TO SAVEPOINT` 边界）。事务/会话管理语句必须走 text/simple protocol
  （MySQL prepared 协议报 1295），实现用 `sqlx::raw_sql` + `Executor::execute`
  规避装箱 Future 的 HRTB 推导限制。PG session 取消/客户端截断后先发 `SELECT 1`
  验证协议干净再继续，验证失败销毁连接报 `session_broken`。
- **多语句脚本（FR-243）**：`split_statements` 是方言状态机拆分器——字符串、
  标识符引号、行/块注释与 dollar-quoted body 内的分号不切；未闭合即 `InvalidSql`
  拒绝。`query_many` 先逐条过 guard 预检（任一失败/写未确认/含事务语句整体拒绝，
  不执行任何语句），再顺序执行，首错或取消中止、后续语句标记 `skipped`。
- **服务端浏览（FR-242）**：`browse_table` 生成 WHERE（列引用转义 + 值参数化，
  数值智能绑定适配 PG 严格类型）/ ORDER BY（列白名单）/ LIMIT+1 / OFFSET；
  COUNT 走独立连接并行查询，5s 超时降级 `total = None`。

**v0.4 扩展点说明**：

- **表格安全编辑（FR-250）**：`apply_table_edits` 以短事务批量应用编辑——后端权威
  校验 `pk_columns` 与表真实主键一致（不一致 / 无主键返回 `no_primary_key`），
  `BEGIN → 逐条参数化 DML → COMMIT`，任一失败整体 `ROLLBACK` 并返回
  `edit_apply_failed { index }`（index 可安全暴露给前端定位 dirty 行）；
  UPDATE / DELETE 影响行数 ≠ 1 返回 `edit_conflict { index }` 并回滚（0 行即
  他端并发改动，>1 行说明定位条件不唯一）。编辑期不持有事务：dirty 暂存前端，
  提交才短暂占用一条连接，与 FR-244 长事务 session 互不占用；关闭 / 断链时
  dirty 丢失由 UI 确认拦截，绝不向新 session 隐式重放。失败路径 `ROLLBACK`
  失败则 `close_on_drop` 销毁连接，杜绝脏连接回池（MySQL）与协议残留（PG 取消
  后直接销毁）。
- **批量插入（FR-252）**：`bulk_insert_rows` 参数化逐行 INSERT，不要求表有主键
  （CSV 导入无主键表合法）。中止模式批内单事务、失败回滚并定位批内行号；
  跳过模式逐行 autocommit、失败行收集行号继续。值统一文本由数据库隐式转换，
  不做类型推断。
- **SQL dump（FR-252）**：导出为 command 层组合（`list_tables` / `list_columns` /
  `browse_table` 分页 + MySQL `SHOW CREATE TABLE` / PG 简化重建 DDL），后端流式
  写文件；字符串转义按方言——PG `standard_conforming_strings=on` 时反斜杠是普通
  字符不转义（integration 实测修正），MySQL 转义反斜杠 + 单引号双写。导入侧
  `StatementSplitter` 是流式增量分句器（`split_statements` 状态机的逐字符可挂起
  版本，跨块 lookahead 用字符队列等待），64KiB 块读取逐条执行，禁止整文件载入；
  失败中止并返回语句序号（原始错误不外泄）。

**v0.5 扩展点说明**：

- **列级 ALTER（FR-253）**：差量生成是前端纯函数（`src/lib/ddl.ts`），不新开
  DDL 契约。ADD / 改类型 / 改空性 / 默认值 / DROP 各自独立成句；执行走现有
  `db_query` + 写确认。不支持 RENAME COLUMN，不能删除主键列。
- **官方备份（FR-260）**：`src-tauri/commands/backup.rs` 编排本机 mysqldump/mysql
  与 pg_dump/pg_restore。凭据写入 0600 临时 defaults / pgpass，禁止出现在 argv。
  SSH 连接使用隧道 `local_addr`。找不到工具返回 `error.backup.tool_not_found`，
  禁止回退成 FR-252 dump。恢复必须手输目标库名。
- **连接分享（FR-221）**：独立口令 Argon2id + AES-GCM 自描述信封（盐在文件内），
  不含 master.key。默认不打包私钥内容；导入一律新 id，不写 known_hosts。

**v0.6 扩展点说明**：

- **结构 diff（FR-220）**：纯前端组合已有 metadata 命令。`diffSchemas` 对比两份
  快照；切换工作台焦点不再 `connection_close` 旧连接，便于两侧同时在线。
  不新开同步协议契约。
- **结构同步（FR-261）**：`buildSyncStatements` 复用 `ddl.ts` 生成可审阅 SQL，
  经 `db_query_many` 写确认执行。跨 driver 拒绝生成。DDL 失败不假装整体回滚。
- **只读 ER（FR-263）**：解析 MySQL `schema.table(cols)` 与 PG `REFERENCES`
  文本构图，SVG 分层布局，无新依赖。

**v0.7 扩展点说明**：

- **表拷贝（FR-266）**：`copy.rs` 只接受两条已打开、同方言连接。源侧
  `browse_table` 分页，目标侧 `bulk_insert_rows`。replace 预览 TRUNCATE，
  必须手输 `database.table`。进度事件 `copy:progress`。跨 driver 拒绝。
- **权限（FR-262）**：`privilege.rs` 只查 `mysql.user` 的 User/Host 或
  `pg_roles`；MySQL `SHOW GRANTS` 文本。变更 SQL 由前端白名单生成，走
  `db_query` 写确认。密码哈希不进 IPC。
- **EXPLAIN（FR-222）**：无新 command。前端包装 `EXPLAIN` / `EXPLAIN ANALYZE`
  走现有 `db_query`；ANALYZE 单独确认。MySQL 行转树，PG 解析 FORMAT JSON。

**v0.8 扩展点说明**：

- **只读 / 环境（FR-270 / FR-271）**：`StoredConnection.read_only` / `env`，serde 缺省兼容。
  写 command 与 ANALYZE 认只读。环境只做展示。
- **复制新表（FR-272）**：前端生成 CREATE，执行走 `db_query`；灌数复用拷贝内核。
- **检查器 / FK（FR-273）**：纯前端；跳转复用 `browse_table` 筛选。
- **RENAME / EXPLAIN 提示（FR-274 / FR-275）**：`ddl.ts` 增 RENAME COLUMN；树节点加 hint。

`DatabaseMeta.is_current` 与 `SchemaMeta.is_default` 是不同语义；`MetadataScope` 不把 MySQL 的 database/schema 同义关系强加给 PostgreSQL。MySQL scope 只携带 database，PostgreSQL scope 必须同时携带当前 database 与 schema。PostgreSQL 无法在一条连接上切换 database，请求非当前 database 时返回 `error.driver.database_switch_required`，由应用层重建目标连接。

`DriverError` 的原始 sqlx 信息只保存在后端变体字段中，`Display` 与 Tauri IPC 均只输出稳定 i18n key；前端不得依赖或展示 driver 原文。这样调试信息不会因 `to_string()` 被意外带到用户界面，公共 key 仍保持只能新增、不能改名。

**MySqlDriver 实现**：内部用 `sqlx::MySqlPool`（max_connections = 5）。`connect_with_settings` 用 `MySqlConnectOptions` 分字段传参（host/port/user/password/database + SSL + 超时），避免 URL 拼接带来的密码特殊字符编码问题；SSL 默认禁用，但用户显式选择 Preferred / Required / Verify CA / Verify Identity 时会把模式和证书路径传给 sqlx。该链路已有单元测试与配置接线；真实 TLS MySQL 服务器（含双向证书）正反例已于 v0.2 验收通过（V2-T4.3）。`connect_url` 接受 `mysql://` URL，仅用于 integration 测试等场景。`list_databases` 查 `information_schema.schemata`，`list_tables` 查 `information_schema.tables`。

**PostgresDriver 实现**：位于独立 `src/postgres.rs`。显式连接使用 `PgConnectOptions::new_without_pgpass()`，不会在密码为空时静默读取用户 `~/.pgpass`；metadata 分别查询 `pg_database`、`pg_namespace`、`pg_class` 与 `pg_attribute`，保留 database/schema 两层语义。query 支持 PostgreSQL `TABLE` / `VALUES`、dollar-quoted body、数据修改 CTE 与 DML `RETURNING`；结果覆盖 NULL、日期时间、整数/浮点/NUMERIC、JSON/JSONB、文本与 BYTEA。后端契约与 AppState/Tauri/UI 已接线；真实 Tauri 直连和 1 跳 SSH 验收已通过（V2-T3.4）。

**取消的独立 control pool**：两个 driver 都在主 pool 外持有 max=1 的 control pool。MySQL 记录 `CONNECTION_ID()` 后发 `KILL QUERY <id>`；PostgreSQL 记录 `pg_backend_pid()` 后由同账号调用 `pg_cancel_backend($1)`。取消或客户端无服务端 LIMIT 截断后，PostgreSQL 将执行连接标为 `close_on_drop`，避免未消费协议消息污染 pool。control pool 与主 pool 使用同一连接参数/隧道本地端口，但状态解耦，主 pool 满时仍能取消。

**结果集防 OOM 三道闸**（FR-021/022）：(1) 拒多语句；读查询在方言允许时追加 `LIMIT <row_limit + 1>`。MySQL 遇到顶层 `LIMIT/FOR/LOCK/INTO/PROCEDURE` 不追加；PostgreSQL 遇到 `LIMIT/FOR/INTO/OFFSET/FETCH` 不追加，`TABLE`/`VALUES` 也按读查询处理。两边都不做 derived table 包装。(2) 后端用 sqlx stream 逐行取，不用 `fetch_all` 缓冲；(3) row_limit clamp 到 1..=100000，超出后返回 truncated，未服务端限流时通过原生 cancel 止损。SQL guard 会识别数据修改 CTE，不能用外层 SELECT 绕过写确认；PostgreSQL dollar-quoted body 内分号不误判为多语句。

**src-tauri OpenConnection 生命周期绑定（组合层）**：

```rust
/// 一条已打开的活跃连接 —— driver（pool）与隧道生命周期绑定。
///
/// 字段声明顺序即 drop 顺序：driver 在前先 drop，tunnel 在后。
pub struct OpenConnection {
    pub driver: ActiveDriver,
    pub tunnel: Option<SshTunnel>,
    pub session_id: String,
}

impl OpenConnection {
    pub async fn close(self) {
        self.driver.close().await;
        drop(self.tunnel);
    }
}
```

构造函数大致：

```
1. 若 connection.ssh.enabled：
   ssh_multihop::open(&hops, database_host, database_port, ctx)
   → 拿到 tunnel.local_addr()，运行时 host/port 改为 127.0.0.1:local_port
2. 若直连：直接使用连接配置里的 host/port
3. 按 DriverKind 创建 MySqlDriver 或 PostgresDriver，包装为 ActiveDriver
4. driver.ping().await? 确认隧道桥接 + 数据库认证成功
5. 生成新的 session_id，AppState.connections.insert(id, OpenConnection { driver, tunnel, session_id })
```

### 3.3 src-tauri/commands

当前前后端各注册 **54** 个 command（以 `src-tauri/src/lib.rs` 的 `generate_handler!` 与 `src/lib/tauri-api.ts` 为准）。多数查询/编辑/备份/拷贝/权限命令返回 `Result<T, QueryCommandError>`，载荷为 `{ key, line?, editIndex? }`；部分连接/元数据路径仍返回稳定 i18n key 字符串。前端用 `ERROR_ZH` map 翻译，禁止展示 sqlx/数据库原文。

| Command | 输入 | 输出 | 描述 |
|---|---|---|---|
| `connection_create` | `(name, config)` | `StoredConnection` | 后端生成 uuid，返回完整记录 |
| `connection_update` | `(connection)` | `()` | 同上 |
| `connection_list` | - | `Vec<StoredConnection>` | 按最近使用倒序（从未使用排最后）；返回完整配置（含解密后的 password）供前端编辑回显，落盘已整体加密 |
| `connection_delete` | `id` | `()` | 加密落盘后删 |
| `connection_test` | `(config, passphrase?)` | `()` | 建立链路（同样走 TOFU 校验）→ SELECT 1 → 销毁；passphrase 只用于本次测试，不持久化或缓存 |
| `connection_open` | `(id, passphrase?, remember_passphrase?)` | `session_id` | 建立持久连接并注册到 AppState；remember_passphrase 在主密码解锁时加密持久化 passphrase |
| `connection_reconnect` | `(id, expected_session_id?, passphrase?, database_override?)` | `session_id` | 仅在期望 session 仍为当前值时取消旧查询、关闭旧 pool/tunnel 并建立新 session；`database_override` 仅本次 session 生效 |
| `connection_close` | `(id, expected_session_id?)` | `()` | 仅关闭匹配 session；迟到关闭幂等忽略 |
| `db_create_database` | `(id, name, charset?, collation?)` | `()` | MySQL 专属创建 database；其他 driver 返回不支持 |
| `db_list_databases` | `id` | `Vec<DatabaseMeta>` | 列出 database |
| `db_list_schemas` | `(id, database)` | `Vec<SchemaMeta>` | 列出 schema |
| `db_list_tables` | `(id, database, schema?)` | `Vec<TableMeta>` | 列出 table |
| `db_list_columns` | `(id, database, schema?, table)` | `Vec<ColumnMeta>` | 列出 column |
| `db_query` | `(id, sql, query_id?, row_limit?, allow_write?, schema?)` | `RowSet` | 执行 SQL，结束时自动写入 SQL 历史（FR-106） |
| `db_query_cancel` | `query_id` | `()` | 取消正在跑的 query |
| `db_query_many` | `(id, sql, query_id?, allow_write?, schema?)` | `MultiQueryResult` | 多语句脚本逐条执行（FR-243）；首错/取消中止，后续 skipped |
| `db_browse_table` | `(id, database, schema?, table, filters, order?, limit?, offset?)` | `TableBrowseResult` | 服务端筛选/排序/分页浏览表数据（FR-242）；列名白名单强制校验 |
| `db_apply_table_edits` | `(id, database, schema?, table, pk_columns, edits)` | `ApplyEditsResult` | 短事务批量应用表编辑（FR-250）；列白名单强制，失败/冲突错误携带 `editIndex` |
| `csv_import_preview` | `(path, has_header, max_rows?)` | `CsvPreview` | CSV 解析预览（表头 + 前 N 行 + 总行数，FR-252） |
| `db_import_csv` | `(id, database, schema?, table, path, mapping, has_header, skip_errors)` | `CsvImportResult` | CSV 分批导入（FR-252）；中止模式批内事务回滚，跳过模式收集失败行号 |
| `db_export_dump` | `(id, database, schema?, table?, path)` | `ExportDumpResult` | SQL dump 导出：DDL + 多行 VALUES INSERT 流式写文件（FR-252） |
| `db_import_dump` | `(id, database, schema?, path)` | `ImportDumpResult` | SQL dump 导入：流式分句逐条执行（FR-252）；失败返回语句序号 + 截断预览 |
| `backup_probe_tools` | `(id, dump_path?, client_path?)` | `BackupProbeResult` | 探测官方备份/恢复工具（FR-260） |
| `db_backup_export` | `(id, database, schema?, table?, path, dump_path?, query_id?)` | `BackupJobResult` | 官方工具导出备份，进度事件 `backup:progress` |
| `db_backup_restore` | `(id, database, confirm_database, path, client_path?, query_id?)` | `BackupJobResult` | 官方工具恢复；库名不一致拒绝 |
| `connection_share_export` | `(ids, password, path, include_private_keys)` | `()` | 独立口令导出连接分享文件（FR-221） |
| `connection_share_preview` | `(path, password)` | `SharePreviewResult` | 预览分享文件（无 secret） |
| `connection_share_import` | `(path, password)` | `usize` | 导入分享连接，生成新 id |
| `db_copy_preview` | `(source, dest)` | `CopyPreviewResult` | 表拷贝预览：列映射与行数（FR-266） |
| `db_copy_table_rows` | `(source, dest, mode, confirm_target, query_id?)` | `CopyTableResult` | 分页拷贝；replace 先 TRUNCATE |
| `db_list_accounts` | `id` | `PrivilegeListResult` | MySQL 账号 / PG 角色（不含哈希，FR-262） |
| `db_show_grants` | `(id, name, host?)` | `Vec<String>` | MySQL SHOW GRANTS |
| `db_list_indexes` | `(id, database, schema?, table)` | `Vec<IndexMeta>` | 列出表的索引（FR-241） |
| `db_list_constraints` | `(id, database, schema?, table)` | `Vec<ConstraintMeta>` | 列出表的约束（FR-241） |
| `transaction_begin` | `(id)` | `session_id` | 建立独占 session 并 BEGIN（FR-244） |
| `transaction_query` | `(id, session_id, sql, query_id?, row_limit?, allow_write?, schema?)` | `TxQueryResult` | 事务 session 内执行 SQL，返回最新事务状态 |
| `transaction_commit` / `transaction_rollback` | `(id, session_id)` | `()` | 提交 / 回滚事务 |
| `transaction_close` | `(id, session_id)` | `()` | 结束 session（未提交自动回滚）；连接关闭/重连时后端统一清理 |
| `sql_file_read` / `sql_file_write` | `(path, content?)` | `String` / `()` | SQL 文件 UTF-8 读写（8MB 上限、原子替换，FR-240） |
| `sql_file_recent_list` / `sql_file_recent_touch` / `sql_file_recent_remove` | `(path?)` | `Vec<RecentFileEntry>` / `()` | 最近文件列表（明文 recent_files.json，仅路径+时间） |
| `db_export_query` | `(id, sql, format, path)` | `ExportResult` | 重新执行只读 SQL 并流式写文件（CSV/XLSX，FR-107） |
| `security_status` | - | `SecurityStatusPayload` | 查询主密码状态（disabled/locked/unlocked）与是否可持久化 passphrase |
| `security_setup` | `password` | `()` | 设置主密码并把现有配置迁移到 v2 envelope（FR-102） |
| `security_unlock` | `password` | `()` | 校验主密码并派生数据 key 驻留内存 |
| `security_lock` | - | `()` | 清空内存派生 key，置为 Locked |
| `security_disable` | `password` | `()` | 校验后迁回 v1 本地 key 加密并删除 secrets.enc |
| `security_reset` | - | `()` | 忘记主密码重置：删除全部加密数据回到 Disabled |
| `history_list` | - | `Vec<HistoryEntry>` | 列出最近 100 条 SQL 执行历史（FR-106） |
| `history_clear` | - | `()` | 清空全部 SQL 历史 |
| `ssh_tofu_decision` | `(connection_id, hop_index, accept)` | `()` | TOFU 弹窗回调 |

### 3.4 AppState

`src-tauri` 的全局状态，注入到所有 command：

```rust
pub struct AppState {
    /// 连接配置加密存储，串行化 load→改→save
    pub store: Mutex<ConnectionStore>,
    /// 已打开连接注册表（connection_id → driver + optional tunnel）
    pub connections: AsyncMutex<HashMap<String, OpenConnection>>,
    /// 每个 connection_id 独立的生命周期互斥锁
    connection_lifecycles: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// 正在执行的 query 注册表（query_id → connection_id + cancel_token）
    pub queries: AsyncMutex<HashMap<String, ActiveQuery>>,
    /// 活跃事务 session 注册表（session_id → session 句柄，FR-244）
    pub sessions: AsyncMutex<HashMap<String, Arc<ActiveSession>>>,
    /// SSH known_hosts store
    pub known_hosts: Arc<SshKnownHostsStore>,
    /// TOFU 决策 manager（前端弹窗响应回调通道）
    pub tofu: Arc<SshTofuManager>,
    /// 会话内 passphrase 缓存（connection_id → passphrase，Zeroizing 内存清零）
    pub passphrases: Mutex<HashMap<String, Zeroizing<String>>>,
    /// 用户主密码与派生 key 状态机（FR-102）
    pub security: Arc<SecurityManager>,
    /// SQL 历史加密存储（FR-106，history.enc）
    pub history: HistoryStore,
    /// 最近打开的 SQL 文件列表（FR-240，明文路径）
    pub recent_files: RecentFilesStore,
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

v0.1 每跳的生命周期简化为 **4 态**（FR-015），与 `ssh:hop-status` 实际 payload 对齐：

```
                         ┌─────────────────────┐
                         │      pending        │（初始状态，UI 灰色）
                         └──────────┬──────────┘
                                    │ 建立成功 / 失败
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
              ┌────────────┐  ┌────────────┐  ┌────────────┐
              │ connected  │  │   failed   │  │   lost     │
              │(UI 绿色)    │  │(红，终态)   │  │(红闪烁，终态)│
              └────────────┘  └────────────┘  └────────────┘
                    │                                ▲
                    │  keepalive 连续失败（≈180s）     │
                    └───────────►──────►────────────┘
```

**说明**：

- `pending → connected` 是首次建立的正常路径；任一跳建立失败（TCP 连不上 / 认证失败 / TOFU 拒绝）→ 该跳 `failed`，后续跳保持 `pending`。
- `connected → lost` 是 FR-014 keepalive 检测出来的运行中断开。
- `failed` 与 `lost` 都是红色，但视觉区分：failed = 静态红边、lost = 闪烁红边 + toast。
- v0.2 仍**不做自动重连**；lost 后用户点击「重连」，显式触发清理与 pending → connected。重连不是新增隐式 reconnecting 状态，也不做指数退避。

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
| **`ChannelDropped { hop_index }`** | `error.ssh.channel_dropped` | 嵌套跳 transport channel 被对端关闭（可能跳板重启） | `TunnelHandler::disconnected` + keepalive fallback 去重上报 |
| **`AcceptLoopDied { hop_index }`** | `error.ssh.accept_loop_died` | 出口跳 accept worker panic / 意外退出 | 独立 monitor 等待 worker；正常 drop 先置 shutdown，不误报 |

> 三个 mid-session 变体（TunnelLost / ChannelDropped / AcceptLoopDied）稳定覆盖三类 failure mode，并统一映射为前端 `lost` 状态，`reason` 保留具体 i18n key。每跳的原子标记负责断链去重，`SshTunnel::drop` 先设置 shutdown 再终止 worker/monitor，避免主动关闭触发红色故障态。

**稳定 i18n key 契约**（NFR-041）：每个变体的 i18n key 是公开 API 的一部分。新增变体可以加新 key，但已有 key 不能改名。前端翻译表向后兼容。

### 4.4 keepalive 机制（FR-014 详解）

```
SshTunnel 建立时:

┌──────────────────────────────────────────────────────────────┐
│ 1. 每跳 session 都用同一份 russh Config（以下为默认值）：        │
│    keepalive_interval: Some(60s)                              │
│    keepalive_max: 2   // 第 3 次未收到数据即断                  │
│    inactivity_timeout: Some(3600s)  // 空闲兜底                 │
│    → russh 内置 keepalive 完成「60s×3≈180s」死链判定            │
│      （russh 判据是 alive_timeouts > keepalive_max，            │
│        故配置值取 3-1=2）                                      │
│                                                              │
│ 2. 每跳再 spawn 一个 keepalive 监控 task（spawn_keepalive_    │
│    monitor，每 20s 轮询一次）：                                │
│      session.is_closed()  // 读取 actor 的 closed 原子标记      │
│      → session 任务已退出（russh 判定断开）→ status_cb 上报     │
│        HopStatus::Lost → src-tauri emit ssh:hop-status         │
│      只读检查，不额外发心跳或干扰用户配置的间隔                   │
└──────────────────────────────────────────────────────────────┘

SshTunnel::drop():

┌──────────────────────────────────────────────────────────────┐
│ impl Drop for SshTunnel {                                     │
│   fn drop(&mut self) {                                        │
│     self.accept_abort.abort();                                │
│     self.accept_monitor.abort();                              │
│     for t in &self.keepalive_tasks { t.abort(); }            │
│     for t in &self.rtt_tasks { t.abort(); }                  │
│     for t in &self.session_tasks { t.abort(); }              │
│   }                                                          │
│ }                                                             │
└──────────────────────────────────────────────────────────────┘
```

**为什么 60s + 连续 3 次阈值**（eng review T2 调整，原 draft 是 30s + 1 次）：

- 30s 太激进：3 跳就是每 30s 三个 ping，多个连接窗口叠加；公司 bastion / VPN / 审计设备可能把高频 ping 当异常流量
- 1 次失败即报会误报：弱网偶尔丢包、bastion 短暂 ratelimit 都会触发假 lost
- 60s 间隔 + 连续 3 次失败（≈180s）才判定断开，平衡了"误报"和"感知速度"
- 180s 感知边界仍远胜 DBeaver/TablePlus 的"下次 query 才发现"（NFR-003）
- 死链判定交给 russh 内置 keepalive，自建 task 只做「发现 session 已死 → 上报」，不主动发包
- v0.2 已把启用状态、间隔与失败阈值接入连接高级配置；新建和缺失整个高级配置的旧记录默认 60s / 3 次，已有显式值保持不变
- 后端把 0 归一化为 1；阈值 N 按 russh 的 `alive_timeouts > keepalive_max` 换算为 `keepalive_max=N-1`

### 4.4.1 SSH RTT 采样（FR-105）

- **测量对象**：调用 russh `Handle::send_ping()`，等待 SSH global-request 回复；多跳中的每个数值是“本机累计到第 N 跳 SSH session”的协议 RTT，不是 ICMP RTT，也不能用相邻数值相减推导单段网络延迟。
- **频率与超时**：隧道打开返回 1 秒后首次采样，之后每次完成再等待 10 秒；单次等待最多 2 秒。超时上报 `timeout`，session 已不可用则上报 `unavailable`。
- **不阻塞主链路**：每跳 russh `Handle` 由 session actor 独占。actor 等待 ping 时用有偏 `select!` 优先处理 `OpenDirectTcpip` 命令，因此 sqlx 新建连接不必等待 RTT 回复或超时；同一 session 的重复探测直接返回 unavailable，避免堆积。
- **不污染连接状态**：RTT 通过独立 `ssh:hop-rtt` 事件更新边指标，timeout / unavailable 不会把节点从 connected 改为 failed/lost；断链仍只由 FR-014 的运行期状态通道判定。
- **零流量边界**：`TunnelContext.rtt_cb=None` 时不创建采样 task，`connection_test` 因而不会产生额外探测流量。
- **生命周期**：`SshTunnel::drop` 先置 shutdown，再中止 accept monitor、keepalive、RTT 与 session actor tasks，避免后台任务或旧 session 事件泄漏。

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

- `src-tauri::state::OpenConnection` 同时持有 `driver: ActiveDriver` 和 `tunnel: Option<SshTunnel>`
- 同 connection_id 的 open/close/reconnect 与 query 注册使用同一生命周期锁；不同连接不互相阻塞
- `connection_close/reconnect` 先取消并移除该连接的 query token，再从注册表移除并调用 `OpenConnection::close()`：先 `driver.close().await`（关 pool），再 `drop(tunnel)`（关 listener / session）
- 每次成功打开生成 `session_id`；重连与关闭携带 expected_session_id，旧命令和旧 `ssh:hop-status` 事件不能作用于新 session
- 异常 drop 时字段顺序兜底：`driver` 声明在前先 drop，`tunnel` 在后
- 反过来不行：tunnel 先 drop 会导致 listener 关，pool 里的连接报 EOF，sqlx 会刷一堆错误日志

---

## 5. 加密 store 设计

### 5.1 连接配置加密

**目的**：用户的 host/user/password/private_key_path/SshHop 数组不能明文落盘。

**实现**：复用 redis-desktop-client 的 `config::encryption` 模块，v0.2 扩展为双时代格式。

**算法**：AES-GCM-256；v0.2 主密码模式用 Argon2id（v19，19 MiB / t=2 / p=1，RFC 9106 第二推荐档）从主密码派生 32 字节数据 key。

**密钥管理**：两种模式由 `security.json` 是否存在决定——

- **v1（默认，未启用主密码）**：首次运行随机生成 32 字节 master key，以 base64 落盘到 `~/Library/Application Support/tiny-sql/master.key`（0600 权限）。**这不是强安全，只是防止“打开文件就看到明文”的低门槛保护**，等同 macOS Keychain 用户体验。
- **v2（FR-102，启用主密码后）**：主密码只用于派生 key，本身不落盘；派生 key 用 `Zeroizing` 包装仅驻留内存，锁定即清零。`security.json` 是明文元信息（KDF 参数 + base64 盐 + verifier 密文），verifier 用于区分「密码错误」与「数据损坏」。KDF 参数被篡改（如降级为弱参数）会直接拒绝解锁，不自创密码算法、不静默降级。

**文件格式**：

```
~/Library/Application Support/tiny-sql/
├── security.json      # v2 才存在：明文 KDF 元信息 + verifier
├── connections.enc    # 连接配置（v1 纯密文 或 v2 envelope JSON）
├── secrets.enc        # v2 才存在：SSH 私钥 passphrase map（FR-102）
└── history.enc        # SQL 历史（FR-106，最近 100 条）

v1 文件内容（base64）：[12 字节 nonce] + [N 字节 ciphertext] + [16 字节 tag]
v2 envelope（自描述 JSON）：{ "v": 2, "nonce": "<base64 12B>", "data": "<base64 ct+tag>" }
```

明文 JSON 结构：扁平 Vec<StoredConnection>（camelCase 字段，无 version 包装、无 mysql 嵌套）

```
[
  {
    "id": "uuid",
    "name": "生产读库 RO",
    "driver": "mysql",
    "host": "...", "port": 3306, "user": "...", "password": "...", "database": "...",
    "ssh": { "enabled": true, "hops": [ { "host": "...", "port": 22, "username": "...", "authType": "privateKey", "privateKeyPath": "~/.ssh/id_rsa", "password": "..." }, ... ] },
    "ssl": { "mode": "disabled", "caPath": "", "clientCertPath": "", "clientKeyPath": "" },
    "advanced": { "keepAliveEnabled": false, "connectTimeoutSeconds": 30, "readTimeoutSeconds": 30, "writeTimeoutSeconds": 30, "compressionEnabled": false, "autoConnect": false, ... },
    "lastUsedAt": "2026-06-20T10:00:00Z"
  },
  ...
]
```

`driver` 的稳定值为 `mysql` / `postgresql`。v0.1 旧记录缺少该字段时，反序列化只在内存中补为 `mysql`，启动读取不会重写 `connections.enc`；用户后续显式保存连接时才落成新格式。解密、JSON 或 driver 枚举迁移失败时直接返回错误，不覆盖原密文。

**读写与锁定语义**：读取按文件实际格式自动嗅探（`{` 开头且含 `"v":2` → v2），v1 文件在解锁后仍可读；写入跟随当前模式（v1 模式写 v1，v2 解锁写 v2）。Locked 状态下一切加密文件读写返回稳定 key `error.security.locked`。

**v1 → v2 迁移（V2-R03）**：`.bak` 备份 → 逐文件临时写 + `rename` 原子替换 → 最后写 `security.json` 作为提交点。任一步失败用 `.bak` 回滚；迁移中断（崩溃）后下次启动发现无 `security.json` 但存在 `.bak` 会自动还原，保证旧配置无损。关闭主密码则把数据迁回 v1 并删除 `secrets.enc`；「忘记主密码」的重置路径会删除全部加密数据文件，前端必须明确告知不可恢复。

### 5.2 passphrase 存储（v0.2 起可选持久化）

默认（未启用主密码）SSH 私钥 passphrase **不写入 connections.enc**，也不写任何其他文件，仅会话内存（NFR-011）。启用主密码并解锁后，用户可在 passphrase 弹窗勾选「记住 passphrase」，后端把 connection_id → passphrase 以 v2 envelope 加密落盘 `secrets.enc`（FR-102）。

**生命周期**：

```
首次连接 → 前端弹 PassphraseDialog → invoke('connection_open', {id, passphrase, rememberPassphrase})
                                          │
                                          ▼
打开时取值优先级：本次传入 → 会话缓存（Zeroizing）→ secrets.enc（需已解锁）
                                          │
                                          ▼
ssh-multihop::open 调用时从 hops 构造里带出 passphrase 用于这次握手
                                          │
                                          ▼
进程退出 → AppState drop → 会话缓存清零；secrets.enc 仅在主密码保护下存在
```

> 注意：**没有**独立的 `ssh_set_passphrase` command，passphrase 直接作为 `connection_open` 的 `passphrase?` 参数传入；缓存按 connection_id 而非 (conn_id, hop_index)。删除连接会同步清理会话缓存与已持久化 secret；关闭主密码会删除整个 `secrets.enc`。

**已知风险**：

- macOS 不阻止内存被换出到 swap，passphrase 可能短暂出现在 swap 文件里；会话缓存用 `Zeroizing` 包装，drop 即清零
- 不做 `mlock` 等防换出保护（best effort）
- passphrase 永不进入日志、崩溃信息与导出内容（T4.4 明文扫描测试守护）

### 5.3 SQL 历史加密（FR-106）

`db_query` 结束后（成功 / 失败都记）由后端写入 `history.enc`：扁平 `Vec<HistoryEntry>` 整体加密，最多保留最近 100 条，单条 SQL 文本截断到 4000 字符。加密器与连接配置同一套（v1 本地 key / v2 派生 key），Locked 状态不可读写。前端只读列表与显式清空；历史不进入日志，导出功能不读取历史。

### 5.4 最近 SQL 文件列表（FR-240）

`recent_files.json` 明文存储（最多 20 条，置顶去重，原子写入）：只记录用户显式打开 / 保存的文件路径与时间戳。路径不属于敏感信息（与编辑器最近文件惯例一致）；SQL 内容永不随列表落盘。打开失败（文件已删除 / 无权限）时前端调 `sql_file_recent_remove` 清理失效项。

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
 │                            │                            │ tofu.request(...)         │
 │                            │                            │  emit + oneshot::Receiver │
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
 │                            │ tofu.resolve(true)         │                          │
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
 │                            │                            │ tofu request cleanup      │
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
- known_hosts 写入失败**按忽略处理**（`let _ = known_hosts.insert(...)`），会话内仍继续握手返回 Trust；下次连接会重新走 TOFU（理想实现应「写入失败按拒绝处理」避免"已同意但没存盘"的不一致，v0.1 留作已知限制）

---

## 7. 前后端事件契约

### 7.1 invoke command 列表

详见 §3.3 表格。

### 7.2 event 列表

事件流向：**src-tauri → 前端**（前端 listen，没有反向）。

| Event 名 | Payload | 触发时机 | 前端处理 |
|---|---|---|---|
| `ssh:tofu-request` | `{connectionId, hopIndex, host, port, fingerprint}` | 后端遇到未知 host key | 弹 `SshTofuDialog` |
| `ssh:hop-status` | `{connectionId, sessionId, hopIndex, status, reason?}`（status ∈ pending/connected/failed/lost） | 隧道每跳状态变化 | zustand 只接收当前 session 事件 → 拓扑节点重渲染 |
| `ssh:hop-rtt` | `{connectionId, sessionId, hopIndex, state, rttMs}`（state ∈ measured/timeout/unavailable） | 每跳低频 SSH 协议探测完成 | zustand 只接收当前 session 事件 → 更新进入该跳的边指标，不改变节点状态 |
| `query:result-chunk` | `{query_id, rows_partial, done: false}` | （规划未用）流式结果 | 各版本 query 均全量返回 RowSet；文件导出采用后端流式写出（db_export_query / db_export_dump），不经 IPC |
| `backup:progress` | `{queryId, bytes}` | 官方备份/恢复子进程写出数据 | 备份对话框进度 |
| `copy:progress` | `{queryId, copied}` | 表拷贝每批插入后 | 对比台拷贝进度 |
| `app:check-update` | `{}` | macOS 应用菜单「Check for Updates...」 | 触发手动检查更新 |

### 7.3 ssh:hop-status 详细 schema

```typescript
type SshHopStatus = "pending" | "connected" | "failed" | "lost";

interface SshHopStatusPayload {
  /** 哪个连接的哪一跳 */
  connectionId: string;
  /** 每次打开的新代号；重连后拒绝旧事件 */
  sessionId: string;
  hopIndex: number;        // 0-based

  /** 状态枚举（v0.1 简化 4 态，FR-015） */
  status: SshHopStatus;

  /** 仅 failed/lost 状态下有值；带 i18n key 或具体描述 */
  reason?: string;
}
```

**状态对应的 UI**：

| status | 节点颜色 | 边动效 | 旁注 |
|---|---|---|---|
| `pending` | 灰色 | 无 | - |
| `connected` | 绿色 | 静态绿 | - |
| `failed` | 红色 | 静态红 | tooltip 显示 reason |
| `lost` | 红色 | **闪烁红**（区别 failed） | toast + tooltip 显示 reason |

### 7.4 ssh:hop-rtt 详细 schema

```typescript
type SshHopRttState = "measured" | "timeout" | "unavailable";

interface SshHopRttPayload {
  connectionId: string;
  /** 每次打开的新代号；重连后拒绝旧采样 */
  sessionId: string;
  hopIndex: number;        // 0-based
  state: SshHopRttState;
  /** 仅 state=measured 时有值；毫秒，可包含小数 */
  rttMs: number | null;
}
```

前端把采样显示在“进入对应 SSH hop”的边上：低于 1ms 显示 `SSH <1 ms`，其余四舍五入为整数毫秒，超时和不可用分别显示 `SSH 超时` / `SSH 不可用`。tooltip 必须说明这是累计 SSH 协议 RTT，不是 ICMP 或单段延迟。payload 的 `connectionId + sessionId` 必须同时匹配当前连接；迟到的旧 session 采样直接丢弃。

### 7.5 连接配置 schema（落盘前）

与 `StoredConnection` 序列化一致（扁平 camelCase，整体文件加密后明文落盘）：

```typescript
interface StoredConnection {
  id: string;            // uuid
  name: string;
  driver: "mysql" | "postgresql";
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;     // 默认 database，可空串
  ssh: SshConfig;
  ssl: SslConfig;
  advanced: AdvancedConfig;
  lastUsedAt?: string;   // ISO 8601
}

interface SshConfig {
  enabled: boolean;
  hops: SshHop[];
}

interface SshHop {
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string;            // 落盘
  privateKeyPath?: string;      // 落盘
  // passphrase 字段不落盘（NFR-011）
}

interface SslConfig {
  mode: "disabled" | "preferred" | "required" | "verify_ca" | "verify_identity";
  caPath: string;
  clientCertPath: string;
  clientKeyPath: string;
}

interface AdvancedConfig {
  keepAliveEnabled: boolean;
  keepAliveIntervalSeconds: number;
  keepAliveFailureThreshold: number;
  connectTimeoutEnabled: boolean;
  connectTimeoutSeconds: number;
  readTimeoutEnabled: boolean;
  readTimeoutSeconds: number;
  writeTimeoutEnabled: boolean;
  writeTimeoutSeconds: number;
  compressionEnabled: boolean;
  autoConnect: boolean;
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

FR-024 描述。实现为**首 token 白名单分类**（前后端同一套规则，`db-driver::prepare_query_sql` 与 `src/lib/sql-guard.ts` 同构）：

- 首 token ∈ `SELECT / WITH` → 读，免确认
- 首 token ∈ `SHOW / DESC / DESCRIBE / EXPLAIN` → 元数据，返回结果集、免确认；`EXPLAIN ANALYZE` 分析写语句时仍需确认（ANALYZE 变体会真正执行被分析语句）
- 其余一律视为写，需 `allow_write=true` 才执行（`USE`、`SET`、`CALL` 等保守地也会弹确认）

预处理：用 `strip_literals_and_comments` 剥离 SQL 注释（`-- ...` / `# ...` / `/* ... */`）和字符串字面量（`'...'` / `"..."`）后再做首 token 判定，避免字符串/注释内关键字误判。

> 注意：黑名单正则（`/^\s*(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|GRANT|CREATE|REPLACE)\b/i`）是早期设计，已被首 token 白名单替代——白名单对未知语句更保守（宁可多弹一次确认）。

### 8.5 进程隔离

- Tauri 默认 webview 与 native 隔离，前端 JS 不能直接调 native API（必须通过 invoke）
- `capabilities/default.json` 写最小集，只授权用得到的 plugin commands
- 不开启 `withGlobalTauri`，避免 webview 全局污染

### 8.6 加密 store 的两档安全承诺

§5.1 已说明两档模式。用户应该理解这一点：

- **v1 默认档**：master key 落盘 `master.key`（0600），**不是强加密**，定位等同"防止打开文件就看到明文"。物理拿到笔记本 → 用 strings 命令在 connections.enc 上看不到明文，但拿到 `master.key` 后即可解密 .enc（`master.key` 与数据同机存储，防不了本机攻击者）。这个等级足够防同事偷瞄屏幕、防误拷贝硬盘到云盘。
- **v2 主密码档（v0.2 已实现，FR-102）**：数据 key 由主密码经 Argon2id 现场派生，主密码与派生 key 均不落盘；拿到硬盘文件后的攻击面只剩暴力破解主密码（19 MiB 内存硬参数显著提高成本）。锁定时所有加密文件不可读写；启用后 SSH passphrase 与 SQL 历史同样受其保护。

---

## 9. 性能与扩展性预期

| 维度 | 现状（v0.4） |
|---|---|
| schema 数量 | 无硬上限；128 项 LRU cache + 对象搜索（v0.2 FR-108 / v0.3 FR-241） |
| 表数量/schema | 服务端筛选 / 排序 / 分页浏览（v0.3 FR-242） |
| 单 query 结果集 | ≤ 10w 行（服务端 LIMIT 或客户端截断）；导出后端流式写文件 |
| 连接池大小 | 5（max_connections，固定） |
| SSH 跳数 | 测试到 3 跳（无硬上限） |
| 隧道吞吐 | 3 跳 ~60-80MB/s 单连接（不优化） |
| 隧道断开感知 | 默认 180s（keepalive 60s × 连续 3 次），间隔 + 阈值可配置（v0.2） |

---

## 10. 测试策略

### 10.1 单元测试

| crate | 重点 |
|---|---|
| `ssh-multihop` | SshTunnelError i18n key 稳定性 / hop_index 归因 / expand_home_path |
| `db-driver` | 双 Driver 对象安全契约 / database-schema scope / 方言化 LIMIT 与写确认 / CTE、dollar quote、多语句 guard / 10w 行截断 / 双 control pool 原生取消 / JSON 等动态类型解码 / CREATE DATABASE 标识符校验 |
| `src-tauri` | 加密 store round-trip / known_hosts.json 读写 / TOFU manager 超时清理 |

### 10.2 集成测试（不用 Docker，连用户本地数据库）

- integration 通过 `TINY_SQL_TEST_MYSQL_URL` / `TINY_SQL_TEST_POSTGRES_URL` 连接用户本地数据库（不起 Docker），测试均标记 `#[ignore]`：
  ```bash
  just test-mysql-integration
  just test-postgres-integration
  ```
  - `just test-integration` 顺序执行两个 driver；任一 URL 缺失都明确失败，避免假绿。
- 当前真实 MySQL 20 项用例覆盖 ping、四层 metadata（含结构页元数据快速回归）、NULL/日期/数值/JSON、写确认、`SELECT SLEEP(10)` 经独立 control pool 取消，以及 v0.4 编辑批量 DML（5）、bulk 导入（2）、dump 风格 SQL 往返（1）。
- 当前真实 PostgreSQL 13 项用例覆盖 ping、四层 metadata、NULL/日期/数值/JSON、行数截断、写确认、`pg_sleep(10)` 原生取消及取消后 pool 恢复，以及 v0.4 编辑批量 DML（2）、bulk 导入（1）、dump 往返（1）。
- **CI 不跑 integration**（无外部数据库服务器）；正式版前保留人工双 driver 回归。3 跳真实故障 / 断链 / 重连回归已在 v0.2/v0.3 dogfooding 中覆盖。

### 10.3 端到端测试

- **Playwright E2E 已推迟**（决策记录见 memory-bank）：原计划 Week 2 架齐 `playwright`（Tauri 2 模式）+ `vitest`，CI 跑 playwright headless；当前仓库无 playwright 依赖，CI 不跑 E2E。前端单测（vitest）已覆盖 store / sql-guard / sql-editor / tauri-api / ddl / metadata-cache / column-widths 等模块，组件层有 ConnectionForm、EditableTable、SchemaBrowser、TopologyGraph、HistoryPanel、UpdateCheckResultDialog 等渲染与交互测试。
- dogfooding（FR-041）作为补充 E2E 验证。

**v0.1 历史 UI 缺口在 v0.2 的处理状态**：

- schema 树列清单已由 V2-T5.1 完成
- 结果表格列宽拖拽与持久化已由 V2-T6.4 完成（localStorage 按连接 + 列签名存储，可恢复默认）
- 多查询 tab（FR-109）、SQL 历史（FR-106）与 CSV/Excel 导出（FR-107）已由 Week 6 完成
- 隧道 lost 后的手动幂等「重连」已由 V2-T7.2 完成
- 语言下拉框未实现（FR-030 验收项）；UI 固定全中文，静态 `ERROR_ZH` map 翻译

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
- tiny-sql 用对象安全 `Driver` 契约承载 `MySqlDriver` / `PostgresDriver`；redis-desktop-client 直接用 `redis` crate
- tiny-sql 用纯 CSS 线性拓扑图展示本机、SSH hop 与 MySQL 状态；redis-desktop-client 无此组件
- tiny-sql 加 SSH keepalive 60s + 3 次阈值（FR-014）；redis-desktop-client 仅靠 russh 3600s inactivity timeout

---

## 附录 A：术语对照

| 术语 | 同义词 | 备注 |
|---|---|---|
| schema | database | MySQL 里这俩是同义词 |
| hop | jump / bastion | 一跳 SSH 节点 |
| TOFU | first-use trust | Trust On First Use |
| direct-tcpip | port forwarding | SSH 协议标准 channel 类型 |
| keepalive | heartbeat | russh 按配置自动发送的保活 global request |
| SSH RTT | protocol round-trip | russh `send_ping()` 测得的累计 session 往返时间，非 ICMP |
| TunnelLost | dead tunnel | 已建立隧道因 keepalive 失败而失活 |

## 附录 B：与设计文档的对齐

本架构遵循 [设计文档](/Users/kurisu/.gstack/projects/tiny-sql/kurisu-main-design-20260626-162200.md) 的 Approach B（Clean Workspace），并补充：

1. **SSH keepalive 机制**（§4.4，FR-014）：设计文档未写，eng review 拍板加入
2. **状态机 lost 状态**（§4.2）：keepalive 失败的视觉区分
3. **每个 SshTunnelError 变体都带 hop_index**（§4.3）：FR-013 完整实现
