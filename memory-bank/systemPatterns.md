# 系统模式（systemPatterns）

> 给写代码的人：架构、目录约定、设计模式、负向约束。**最重要的技术参考文件。**

## 架构总览

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
│  Driver + MySQL/Postgres │  │  open() → N 跳隧道 + 本地端口  │
│  不知道 SSH 存在          │  │  完全不知道 MySQL 存在         │
└──────────────────────────┘  └──────────────────────────────┘
```

**分工铁律**：

- `ssh-multihop` **只知道**「本地监听一个端口，把流量转发到远端 host:port」，不知道上层是 MySQL → 这是它未来能独立 publish 的前提。
- `db-driver` **只知道**数据库连接与查询，不知道 SSH。通用调用通过对象安全的 `Driver` 契约；连接创建和方言专属配置仍由具体 driver 负责。
- `src-tauri` 把两者拼起来 + Tauri IPC + 持久化；走 SSH 时先打开隧道拿本地端口，再按连接配置创建 `MySqlDriver` 或 `PostgresDriver` 连 `127.0.0.1:port`，最后包装为 `ActiveDriver`。

## 多跳 SSH 机制（核心）

OpenSSH ProxyJump 等效：hops[0] 用 `TcpStream` 直连；hops[i] 在 hops[i-1] 的 channel `into_stream()` 上跑嵌套 SSH；最后一跳对目标数据库开 `direct-tcpip`，在本地 `127.0.0.1:0` 绑随机端口。**加密层数 = 跳数**。

**sqlx 桥接**：sqlx 不支持注入自定义 `TcpStream`，所以走「本地 listener 端口 P → 具体 driver 连接 `127.0.0.1:P`」。1 个应用连接 = 1 个本地端口 = 1 组主/control pool；池内 TCP 共用同一隧道 listener，首跳 session 上是多个 direct-tcpip channel（不是多个 session）。

**生命周期绑定**：`src-tauri::OpenConnection` 同时持有 `driver: ActiveDriver` 和 `tunnel: Option<SshTunnel>`，关闭时**先 pool 后 tunnel**（反过来 listener 先关会让 pool 刷 EOF 错误）。

## 目录约定

### 实际结构（Week 1 已落地）

```
tiny-sql/
├── Cargo.toml                  # workspace 根，members + workspace.dependencies
├── crates/
│   ├── ssh-multihop/src/lib.rs # N 跳隧道 + keepalive + 错误模型 + TunnelHandler/HostKeyVerifier
│   └── db-driver/src/          # lib.rs: 公共契约/MySQL；postgres.rs: PostgreSQL
├── src-tauri/
│   ├── src/lib.rs · main.rs    # setup 装配 store/known_hosts + 注册 command
│   ├── src/state.rs · tofu.rs  # AppState(注册表/passphrase 缓存) + SshTofuManager
│   ├── src/commands/           # connection(open/close/CRUD/test) · query(db_*) · ssh_tofu
│   ├── src/config/             # encryption · store · ssh_known_hosts
│   ├── capabilities/default.json · tauri.conf.json · icons/
├── src/                        # app/ · components/(connection-form/dialogs/schema-browser)
│                               #   stores/(connection-store/session-store) · lib/tauri-api.ts
├── docs/                       # REQUIREMENTS / PLAN / ARCHITECTURE / ROADMAP
├── justfile · README · CHANGELOG · AGENTS · .env.example
```

### 与 ARCHITECTURE 的偏差（实施期决定）

- **db-driver 已按 driver 实现边界拆分**：`lib.rs` 保留公共契约、MySQL 与共享 SQL guard，`postgres.rs` 放 PostgreSQL metadata/query/cancel；隧道仍在 src-tauri 的 `OpenConnection` 里与 pool 绑定生命周期，不进入 db-driver。
- **ssh-multihop 不引 `tauri::AppHandle`**：原 `SshTunnelContext{app_handle}` 改为 `TunnelContext` 注入回调闭包，保「可独立 publish」不变量。**写代码前确认是「实际」还是「规划」。**

## 设计模式

**Rust 后端**

- 错误用 `thiserror`，每个变体绑定稳定 i18n key（`#[error("error.ssh.connect_failed")]`）；i18n key 是**公开 API 契约**，只能加不能改名。
- `Driver` 使用装箱 Future 保持对象安全，不引入 `async-trait`；取消令牌作为 query 契约的一部分，由具体 driver 映射为原生取消机制。
- metadata 通过 `MetadataScope { database, schema }` 显式表达层级；MySQL schema 与 database 同义，PostgreSQL schema 是独立层级且不能在同一连接上跨 database 查询。
- `DriverError` 的 `Display` 只输出稳定 i18n key；sqlx 原始错误只保留在后端结构化字段，Tauri command 不得返回 `to_string()` 原文。
- 连接配置的 `driver` 使用稳定值 `mysql` / `postgresql`；旧密文缺字段时只做内存默认迁移，不在启动读取时重写文件，显式保存才升级格式。迁移失败必须保持原密文不变。
- 与具体跳相关的 `SshTunnelError` 变体带 `hop_index: usize`；`NoHops` / `LocalListenFailed` 返回 `None`。Tauri command 用 `hop_index()` emit 拓扑状态，错误返回值只暴露稳定 i18n key。
- 公共类型/函数加中文 doc comment。
- 隧道 `Drop` 里 abort 所有 keepalive task 和 accept task，防 leak。

**前端**

- `"use client"` 组件 + `invoke<T>()` 调 command；i18n key → 中文映射（v0.1 用静态 `ERROR_ZH` map，完整 i18next runtime 留英文 UI 时接入）。
- 状态用 zustand；拓扑图用纯 CSS 静态布局；结果表格用 `react-virtuoso` 虚拟滚动。
- UI 组件库用 **shadcn/ui**（radix base，组件源码落 `src/components/ui/`，用 `cn()` 合并 className）：新建/编辑表单用 `Dialog`、右键菜单用 `ContextMenu`、二次确认用 `AlertDialog`；确认统一走全局命令式 `confirm-store`（`await confirm({...})`）替代 `window.confirm`。

**数据库（被连接的 MySQL）**

- LIMIT 防护用**顶层安全追加 LIMIT**（顶层无 LIMIT/FOR/LOCK/INTO/PROCEDURE 时末尾追加 `LIMIT n+1`），**不做 derived table 包装**（JOIN 重名列触发 1060）；顶层已含这些子句时客户端截断兜底，截断且无服务端 LIMIT 时主动 KILL QUERY 止损。
- 写操作二次确认为**首 token 白名单分类**（SELECT/WITH 读、SHOW/EXPLAIN/DESC/DESCRIBE 元数据免确认、其余一律需 allow_write），前后端同一套规则，不用黑名单正则。
- 取消用**独立 control pool**（max=1，同一连接参数独立连接池，非独立本地端口）发 `KILL QUERY`，不从主 pool 借连接（pool 满时借不到）。
- MySQL SSL 默认 `Disabled`；用户显式选择 Preferred / Required / Verify CA / Verify Identity 时，`src-tauri` 把模式与 CA / 客户端证书 / 私钥路径传给 `db-driver::MySqlConnectSettings`。不要把“真实 TLS 尚未验收”写成“代码完全未启用”。

**数据库（被连接的 PostgreSQL）**

- database 与 schema 分层；`list_schemas/list_tables/list_columns` 只允许当前 database，跨 database 返回 `error.driver.database_switch_required`。当前应用要求为目标 database 新建连接，不做隐式重连。
- 取消用独立 control pool 调 `pg_cancel_backend`；取消或无服务端 LIMIT 的客户端截断后关闭该执行连接，避免未消费协议消息回池。
- PostgreSQL guard 独立处理 `TABLE` / `VALUES`、`OFFSET` / `FETCH`、dollar-quoted body 与数据修改 CTE；DML `RETURNING` 需写确认并返回结果行。

## 负向约束（❌ 不要做）

- ❌ **不在 `ssh-multihop` 里引用 MySQL/sqlx** —— 破坏独立 publish 前提。
- ❌ **不把方言专属对象操作塞进 `Driver`** —— 通用契约只覆盖 ping、metadata、query/cancel、close；连接创建与 MySQL `CREATE DATABASE` 等能力留在具体实现/factory。
- ❌ **不读不写 `~/.ssh/known_hosts`** —— 用自有 store，不污染用户 OpenSSH 信任域。
- ❌ **host key 变更不给「忽略」按钮** —— 硬拒绝。
- ❌ **passphrase 不落盘**（v0.1）—— 仅会话内存。
- ❌ **不用 regex 检测 SQL 的 LIMIT** —— 会被注释/字符串/CTE/UNION 骗，用顶层安全追加 LIMIT（也不做 derived table 包装）。
- ❌ **不向前端泄露原始 Rust 错误** —— 必须走 i18n key。
- ❌ **不上传业务数据** —— 无遥测/错误上报；业务通信只访问用户配置的 SSH/数据库目标，自动更新只访问 GitHub Release 正式版清单。
- ❌ **数据库设计不定义 FOREIGN KEY**（全局规则）—— 关联由代码与索引控制。
- ❌ **keepalive 不要 30s/1 次即报** —— 用 60s + 连续 3 次，防误报。
- ❌ **不把暗色切成 `.dark` class 策略** —— 保持 Tailwind v4 默认 `prefers-color-scheme`（跟随系统），shadcn 主题变量在 `@media` 下随系统切换，避免现有满屏 `dark:` 工具类失效。

相关：[[techContext]] · [[productContext]] · [[activeContext]]
