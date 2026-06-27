# 活跃上下文（activeContext）

> 最轻量、最常更新的文件。每次会话结束前由 AI 更新「活跃文件 / 决策 / 下一步 / 阻塞」。

**最后更新**：2026-06-27

## 当前状态

**Week 1 — vertical slice 已打通（静态验证全绿）**。端到端最小链路：前端 hello 页 → tauri command `test_select_1` → `ssh-multihop`（单跳）→ `db-driver`（sqlx）→ MySQL `SELECT 1`。

- ✅ CP-1（Tauri + workspace 摩擦）已解决：`src-tauri` 成功引用 workspace crate，无需退回扁平 mod。
- ✅ 静态验证：`cargo check/build`、`fmt-check`、`clippy`、2 个单元测试、`pnpm build → out/` 全通过。
- ⏳ **CP-1b（GUI 运行时 smoke：点按钮 → SSH → SELECT 1 → 显示「连接成功」）**：需 GUI + 用户本地 MySQL，无法 headless，**待用户跑 `pnpm tauri dev` 验证**。

## 活跃文件

- `crates/ssh-multihop/src/lib.rs`（348 行）— 单跳隧道 + `SshTunnelError`（7 变体，尚无 hop_index / mid-session 三变体）。
- `crates/db-driver/src/lib.rs`（75 行）— `ping_select_1`，**尚无 `MySqlDriver` struct**。
- `src-tauri/src/lib.rs`（116 行）— `test_select_1` command。
- `src/app/page.tsx`（165 行）— 测试连接表单（单跳 SSH + MySQL 字段）。

## 近期已做决策

- README / CHANGELOG / AGENTS / justfile / .env.example 已补齐并提交（commit `0fe1a5c`）。
- AGENTS.md 作为贡献者指南，与 memory-bank 互补（前者编码规范，后者项目记忆）。
- memory-bank 本次初始化（6 文件）。

## 下一步（按 PLAN.md）

1. **用户验证 CP-1b**：`pnpm tauri dev` 连真实 MySQL 走通 SELECT 1。
2. 决定是否 `git push`（本地领先远端，含 `a1cc3ef` Week 1 slice + `0fe1a5c` 文档 + 本次 memory-bank commit）。
3. **进入 Week 2**：测试基础设施（无 Docker）+ 具体 `MySqlDriver` struct + 加密 store + 连接管理 UI（无 SSH）。Week 2 末有 CP-2（25h 累计工时检查）。

## 阻塞 / 待确认

- CP-1b 运行时 smoke 依赖用户本地 MySQL，AI 无法代跑。
- 是否 push 未提交决定权在用户。

相关：[[progress]] · [[systemPatterns]]
