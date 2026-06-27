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
│  MySqlDriver（sqlx pool） │  │  open() → N 跳隧道 + 本地端口  │
│  不知道 SSH 存在          │  │  完全不知道 MySQL 存在         │
└──────────────────────────┘  └──────────────────────────────┘
```

**分工铁律**：

- `ssh-multihop` **只知道**「本地监听一个端口，把流量转发到远端 host:port」，不知道上层是 MySQL → 这是它未来能独立 publish 的前提。
- `db-driver` **只知道**「给我一个 URL，返回 Connection」，不知道 SSH（除组合层 `MySqlDriverViaSshTunnel`）。
- `src-tauri` 把两者拼起来 + Tauri IPC + 持久化。

## 多跳 SSH 机制（核心）

OpenSSH ProxyJump 等效：hops[0] 用 `TcpStream` 直连；hops[i] 在 hops[i-1] 的 channel `into_stream()` 上跑嵌套 SSH；最后一跳对 MySQL 开 `direct-tcpip`，在本地 `127.0.0.1:0` 绑随机端口。**加密层数 = 跳数**。

**sqlx 桥接**：sqlx 不支持注入自定义 `TcpStream`，所以走「本地 listener 端口 P → `mysql://user:pass@127.0.0.1:P/db` URL」。1 个连接 = 1 个本地端口 = 1 个 `MySqlPool`（max=5）；5 条 TCP 走同一端口，首跳 session 上是 5 个 direct-tcpip channel（不是 5 个 session）。

**生命周期绑定**：`MySqlDriverViaSshTunnel` 同时持有 `tunnel` 和 `pool`，drop 时**先 pool 后 tunnel**（反过来 listener 先关会让 pool 刷 EOF 错误）。

## 目录约定

### 实际结构（Week 1 已落地）

```
tiny-sql/
├── Cargo.toml                  # workspace 根，members + workspace.dependencies
├── crates/
│   ├── ssh-multihop/src/lib.rs # N 跳隧道（当前单跳，348 行）
│   └── db-driver/src/lib.rs    # ping_select_1（75 行，尚无 MySqlDriver struct）
├── src-tauri/
│   ├── src/{lib.rs, main.rs}   # test_select_1 command
│   ├── capabilities/default.json
│   ├── tauri.conf.json
│   └── icons/
├── src/app/                    # layout.tsx / page.tsx / globals.css
├── docs/                       # REQUIREMENTS / PLAN / ARCHITECTURE / ROADMAP
├── justfile · README · CHANGELOG · AGENTS · .env.example
```

### 规划结构（ARCHITECTURE.md §1.1，尚未创建）

`src-tauri/src/` 下将分 `commands/`（connection/query/ssh_tofu）、`config/`（encryption/store/ssh_known_hosts）、`state.rs`；`db-driver` 拆 `mysql.rs` / `tunneled.rs`；前端加 `components/` `lib/` `stores/`（zustand）。**写代码前确认是「实际」还是「规划」。**

## 设计模式

**Rust 后端**

- 错误用 `thiserror`，每个变体绑定稳定 i18n key（`#[error("error.ssh.connect_failed")]`）；i18n key 是**公开 API 契约**，只能加不能改名。
- `SshTunnelError` 每个变体带 `hop_index: usize`，错误能定位到具体跳。
- 公共类型/函数加中文 doc comment。
- 隧道 `Drop` 里 abort 所有 keepalive task 和 accept task，防 leak。

**前端**

- `"use client"` 组件 + `invoke<T>()` 调 command；i18n key → 中文映射（v0.1 用 `ERROR_ZH` map，Week 2 接 i18next）。
- 状态用 zustand（规划）；拓扑图用 `@xyflow/react`（规划）；表格用 `react-virtuoso`（规划）。

**数据库（被连接的 MySQL）**

- LIMIT 防护用**子查询包装**，不用 regex 检测关键字。
- 取消用**独立 control connection** 发 `KILL QUERY`，不从主 pool 借连接（pool 满时借不到）。

## 负向约束（❌ 不要做）

- ❌ **不在 `ssh-multihop` 里引用 MySQL/sqlx** —— 破坏独立 publish 前提。
- ❌ **v0.1 不写 `trait Driver`** —— 单实现 trait 是过早抽象，v0.2 加 PG 时再 rust-analyzer extract。
- ❌ **不读不写 `~/.ssh/known_hosts`** —— 用自有 store，不污染用户 OpenSSH 信任域。
- ❌ **host key 变更不给「忽略」按钮** —— 硬拒绝。
- ❌ **passphrase 不落盘**（v0.1）—— 仅会话内存。
- ❌ **不用 regex 检测 SQL 的 LIMIT** —— 会被注释/字符串/CTE/UNION 骗，用子查询包装。
- ❌ **不向前端泄露原始 Rust 错误** —— 必须走 i18n key。
- ❌ **不联网**（除用户配置的 SSH/MySQL 目标）—— 无遥测/更新检查/错误上报。
- ❌ **数据库设计不定义 FOREIGN KEY**（全局规则）—— 关联由代码与索引控制。
- ❌ **keepalive 不要 30s/1 次即报** —— 用 60s + 连续 3 次，防误报。

相关：[[techContext]] · [[productContext]] · [[activeContext]]
