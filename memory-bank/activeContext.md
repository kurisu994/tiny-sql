# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-06-27

## 当前状态

**Week 2 完成（5/5 子任务，静态验证全绿）**。后端连接管理全链路 + 测试基建落地：

- ✅ T2.2 `MySqlDriver`（connect/connect_url/ping/list_databases/list_tables/list_columns/query），动态结果集按列类型解码字符串
- ✅ T2.4 加密 store：整个 `connections.enc` 文件 AES-GCM 加密（强于参考项目的逐字段加密，满足 FR-001）
- ✅ T2.3 `connection_*` 命令 + `AppState`（Mutex<ConnectionStore>）
- ✅ T2.5 前端连接管理 UI（列表 + 编辑表单 + 测试连接，zustand）
- ✅ T2.1 测试基建：vitest（9 例）+ db-driver integration（4 例 `#[ignore]`）+ CI 接入
- `just check` 全绿：cargo test（2 ssh + 6 config）+ vitest 9 + fmt/clippy + 前端 build

## 活跃文件

- `crates/db-driver/src/lib.rs` — MySqlDriver + 元数据/RowSet + cell_to_string 动态解码
- `src-tauri/src/config/{encryption,store}.rs` — AES-GCM 整体加密 + ConnectionStore CRUD
- `src-tauri/src/commands/connection.rs` + `state.rs` — 5 个命令 + AppState
- `src/lib/tauri-api.ts` / `src/stores/connection-store.ts` / `src/components/connection-form.tsx` — 前端

## 近期已做决策

- **整体文件加密**而非参考项目的逐字段加密（FR-001 要求 host/user 也不明文）。
- **connection_list 返回完整配置含明文 password**（Week 2 简化，本地工具内存明文可接受，落盘已加密）。
- **playwright E2E 推迟**：Tauri WebDriver 不支持 macOS（CI 是 macOS arm64），改 vitest 进 CI，E2E 留 Linux CI / dogfooding。
- **移除 Week 1 的 test_select_1**，由 connection_test 取代。

## 下一步（Week 3）

1. 多跳 SSH 扩成 N 跳（当前 ssh-multihop 单跳）+ keepalive 60s/3 次 + `SshTunnelError` 三个 mid-session 变体 + hop_index。
2. TOFU 流程（known_hosts.json + 弹窗）。
3. 前端 SSH 跳板配置表单（ConnectionForm 加 SSH 折叠区，passphrase 仅会话内存）。
4. schema/table 左侧树 + 1000 行表格（用 db-driver 的 list_*/query）。

## 阻塞 / 待确认

- **CP-1b** GUI 运行时 smoke（点按钮连真实 MySQL）仍待用户 `pnpm tauri dev` 验证——现在可测连接管理 CRUD + 测试连接。
- **CP-2** Week 2 末 25h 累计工时检查（PLAN §3.3）：未正式记录工时。
- 本会话所有提交**未 push**。

相关：[[progress]] · [[systemPatterns]]
