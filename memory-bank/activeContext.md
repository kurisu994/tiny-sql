# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-06-27

## 当前状态

**Week 3 完成（6/6 子任务，静态验证全绿）**。多跳 SSH 强化 + TOFU + 数据浏览全链路：

- ✅ T3.1 N 跳隧道已实现（旧称「单跳」过时）；新增 `connection_open/close` 持久连接 + `OpenConnection`（tunnel+pool 生命周期绑定，先 pool 后 tunnel）+ AppState 注册表
- ✅ T3.2 keepalive：russh 内置 60s/连续 3 次（≈180s）+ 每跳监控 task + `HopStatusCallback` 上报 `ssh:hop-status`，Drop 全 abort
- ✅ T3.3 `SshTunnelError` 各变体补 `hop_index` + 三个 mid-session 变体（TunnelLost/ChannelDropped/AcceptLoopDied）+ HostKeyMismatch/HostKeyRejected/InvalidAuthType
- ✅ T3.4 TOFU：`HostKeyVerifier` 回调注入 + `SshKnownHostsStore`(known_hosts.json) + `SshTofuManager`(oneshot+120s) + `ssh_tofu_decision` + 前端指纹弹窗
- ✅ T3.5 前端 SSH 多跳表单（N 跳增删/调序）
- ✅ T3.6 前端 schema/table 树 + 前 1000 行表格 + `db_*` 命令
- `just check` 全绿：cargo test（3 ssh + 8 config + 4 ignored）+ vitest 14 + fmt/clippy + 前端 build

## 活跃文件

- `crates/ssh-multihop/src/lib.rs` — N 跳 + keepalive + 错误模型 + TunnelHandler/HostKeyVerifier（仍不依赖 Tauri，回调注入）
- `src-tauri/src/{state.rs,tofu.rs}` + `config/ssh_known_hosts.rs` — 注册表/passphrase 缓存 + TOFU manager + known_hosts
- `src-tauri/src/commands/{connection,query,ssh_tofu}.rs` — open/close + db_* + tofu 决策
- `src/components/{connection-form,connection-dialogs,schema-browser}.tsx` + `stores/session-store.ts` + `lib/tauri-api.ts`

## 近期已做决策

- **ssh-multihop 保持不依赖 Tauri**：ARCHITECTURE 原设计 `SshTunnelContext { app_handle }` 会耦合 Tauri，改用 `TunnelContext` 注入闭包（HostKeyVerifier + 状态回调），由 src-tauri 接事件总线——honor「可独立 publish」不变量。
- **keepalive 用 russh 内置机制**：`keepalive_interval=60s`+`keepalive_max=2`（第 3 次未响应即 180s 断），监控 task 仅探测 session 死亡后上报，持锁短不卡末跳 accept loop。
- **指纹拒绝区分 mismatch/reject**：`HostKeyDecision::Reject{mismatch}` + handler `reject_slot` 在握手失败后还原精确错误。
- **passphrase 单值应用到全部私钥跳**（v0.1 简化），按 connection_id 会话缓存（NFR-011）。
- **1000 行用普通滚动表格**，react-virtuoso 留 Week 4 的 10w 行硬上限再引入（避免提前加依赖）。
- 沿用：整体文件加密、playwright 推迟、移除 test_select_1。

## 下一步（Week 4）

1. SQL 执行：拒多语句 + **子查询包装** `SELECT * FROM (<sql>) AS t LIMIT 1000`（替换前端临时 LIMIT）+ 客户端 take(100000) 硬上限。
2. 取消：独立 control connection 发 `KILL QUERY`。
3. 拓扑图（@xyflow/react）+ macOS .dmg build。
4. （并入）react-virtuoso 虚拟滚动表格。

## 阻塞 / 待确认

- **CP-1b** GUI 运行时 smoke 仍待用户 `pnpm tauri dev`——现可测：配 3 跳 SSH 连真实 MySQL、TOFU 弹窗、passphrase、左侧树点表看前 1000 行、kill 中间跳验证 180s 内 lost。
- **CP-2/CP-3** 工时与 MySQL 5.7 兼容仍留 dogfooding。
- 本会话所有提交**未 push**（Week 2 + Week 3 共 10+ commit）。

相关：[[progress]] · [[systemPatterns]]
