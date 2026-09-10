---
name: 10-ssh-multihop
description: N 跳 SSH 隧道 —— 链路模型、keepalive/RTT 监控、错误归因与独立 publish 不变量
paths:
  - "crates/ssh-multihop/**"
---

# SSH 多跳隧道（10-ssh-multihop）

> 改 `crates/ssh-multihop/**` 前读这份。这个 crate **不知道 MySQL 存在**，是产品差异化的核心。

## 链路模型

OpenSSH ProxyJump 等效：

- `hops[0]` 用 `TcpStream` 直连；
- `hops[i]` 在 `hops[i-1]` 的 channel `into_stream()` 上跑嵌套 SSH；
- 最后一跳对目标数据库开 `direct-tcpip`，在本地 `127.0.0.1:0` 绑随机端口。

**加密层数 = 跳数**。

## 与 sqlx 的桥接方式

sqlx 不支持注入自定义 `TcpStream`，所以走「本地 listener 端口 P → 具体 driver 连接 `127.0.0.1:P`」。

- 1 个应用连接 = 1 个本地端口 = 1 组主 / control pool；
- 池内 TCP 共用同一隧道 listener，首跳 session 上是多个 `direct-tcpip` channel（**不是**多个 session）。
- 隧道 crate 本身只对外暴露「本地监听端口 → `127.0.0.1:port`」这一层语义；上层拼装见 [[12-tauri-shell]]。

## 生命周期绑定

`src-tauri::OpenConnection` 同时持有 `driver: ActiveDriver` 和 `tunnel: Option<SshTunnel>`，关闭时**先 pool 后 tunnel**——反过来 listener 先关会让 pool 刷 EOF 错误。

## russh 并发约束

russh `Handle` 含非 `Sync` receiver，每跳必须由**单一 session actor 独占**；RTT 等待期间优先处理 `direct-tcpip` 命令，**禁止让指标采样阻塞数据库连接主链路**。

## keepalive 与断链判定

- 每跳 keepalive 默认 60s 一次，**连续 3 次失败（≈180s）才判定断开**，防弱网 / bastion ratelimit 误报。
- 隧道 `Drop` 里 abort accept monitor、keepalive、RTT 和 session actor tasks，防 task leak。
- 运行期断链按三类归因：首跳 `tunnel_lost`、嵌套跳 `channel_dropped`、accept worker `accept_loop_died`；正常 drop 先置 shutdown，单跳用原子标记去重。
- `rtt_cb=None` 时**不得**产生探测流量。

## RTT 指标的表述边界

RTT 只能描述为「本机累计到第 N 跳 SSH session 的 global-request 往返时间」，**不是 ICMP，也不是可相减的单段延迟**；timeout / unavailable 只更新指标，不改变连接四态（`pending / connected / failed / lost`）。

进入数据库那条边显示的是 `SELECT 1` 累计延迟（末跳不是 SSH session，测不到协议 RTT）。

## 错误模型

- 错误用 `thiserror`，每个变体绑定稳定 i18n key（`#[error("error.ssh.connect_failed")]`）；**i18n key 是公开 API 契约，只能加不能改名**。
- 与具体跳相关的 `SshTunnelError` 变体带 `hop_index: usize`；`NoHops` / `LocalListenFailed` 返回 `None`。
- Tauri command 用 `hop_index()` emit 拓扑状态，错误返回值只暴露稳定 i18n key。
- TOFU host key 校验走自有 `known_hosts.json`，指纹变更硬拒绝（见 12 号规范）。

## 负向约束（❌ 不要做）

- ❌ **不在 `ssh-multihop` 里引用 MySQL / sqlx** —— 破坏独立 publish 前提。
- ❌ **不引入 `tauri::AppHandle`** —— 原 `SshTunnelContext{app_handle}` 已改为 `TunnelContext` 注入回调闭包，保「可独立 publish」不变量。
- ❌ **不读不写 `~/.ssh/known_hosts`** —— 用自有 store，不污染用户 OpenSSH 信任域。
- ❌ **host key 变更不给「忽略」按钮** —— 硬拒绝。
- ❌ **keepalive 默认值不要 30s / 1 次即报** —— 默认用 60s + 连续 3 次，防误报；运行时只读监控不得额外发心跳干扰用户设置的间隔。
- ❌ **不把 SSH RTT 冒充网络分段延迟** —— 仅显示累计 SSH 协议探测值；不得相减、不得用超时直接驱动 failed/lost。

相关：[[11-db-driver]] · [[12-tauri-shell]] · [[20-frontend]]
