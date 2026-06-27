# 进度（progress）

> 面向历史回溯：发生了什么、为什么变。重大架构变更记日期。

## 版本发布历史

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.1.0 | 🚧 开发中（Week 1 已完成） | MySQL + 3 跳 SSH + 拓扑图 + macOS only，预期 2026-08 月初发布 |
| v0.2 | 规划 | PG driver + 自动更新 + passphrase 加密 + TLS + Schema-aware 联想 |
| v0.3+ | 规划 | Win/Linux + crate 独立 publish + 多集群 diff |

CHANGELOG 当前全部在 `[Unreleased]` 段（Week 1 脚手架 + 三大功能模块）。

## 开发阶段完成度（5-6 周计划）

| 周 | 内容 | 状态 |
|---|---|---|
| Week 1 | vertical slice（workspace + 单跳 SSH + sqlx SELECT 1 + hello 页） | ✅ 静态验证完成，CP-1b 待用户 GUI smoke |
| Week 2 | 测试基础设施 + `MySqlDriver` struct + 加密 store + 连接管理 UI | ⬜ 未开始 |
| Week 3 | 多跳 SSH + keepalive + 错误模型三变体 + TOFU + 表浏览 | ⬜ |
| Week 4 | SQL 执行（子查询包装 + KILL QUERY）+ 拓扑图 + .dmg | ⬜ |
| Week 5 | dogfooding + 修 bug + README/GIF + tag v0.1.0 | ⬜ |
| Week 6 / 7 | 缓冲 / launch（V2EX + 掘金） | ⬜ |

## Git 提交历史

| commit | 内容 |
|---|---|
| `8a902c6` | docs: 新增 v0.1 工程文档（需求/计划/架构/路线图） |
| `9f76b1c` | chore: 添加 .gitignore |
| `a1cc3ef` | feat: Week 1 vertical slice — 单跳 SSH + sqlx SELECT 1 |
| `0fe1a5c` | docs: 补充 README / CHANGELOG / AGENTS 及 justfile |

> 注：`a1cc3ef` 及之后**尚未 push** 到远端 `git@github.com:kurisu994/tiny-sql.git`。

## 重大决策与架构变更记录

- **2026-06-26 选 Approach B（Clean Workspace）**：放弃 fork redis-desktop-client，改独立 workspace + 独立 crate。理由：长期维护 + `ssh-multihop` 未来独立 publish。
- **2026-06-26 plan-eng-review 9 个 binding 决策**：keepalive 30s→60s+3 次阈值 / SQL 取消用独立 control conn KILL QUERY / `SshTunnelError` 加 TunnelLost+ChannelDropped+AcceptLoopDied / trait Driver 推 v0.2 / 测试无 Docker 连本地 MySQL / LIMIT 用子查询包装 / **Week 1 改 vertical slice** / read-only best-effort / Codex tension 记 v0.2。
- **2026-06-26 文档全量改 draft-2**：4 篇 docs 落地上述 9 决策，PLAN.md 重写（Week 1 = vertical slice）。

## 已解决的阻碍

| 问题 | 根因 | 解决 |
|---|---|---|
| sqlx feature 报错 | 写成 `rustls`，sqlx 0.8 无此 feature | 改 `runtime-tokio-rustls` |
| `pnpm build` exit 1 | pnpm 11 `verify-deps-before-run` 因 sharp 构建脚本未批准而 exit | `pnpm-workspace.yaml` 加 `allowBuilds: sharp: true`（pnpm 11 读 workspace.yaml 而非 package.json） |
| `tauri::Manager` unused 警告 | `app.handle()` 是 inherent 方法 | 删除 import |
| CP-1（Tauri+workspace 摩擦，Week 1 最大风险） | — | 已验证通过，`cargo check --workspace` 正常引用 crate |

## 待验证 / 风险跟踪

- **CP-1b** GUI 运行时 smoke：待用户 `pnpm tauri dev` 连真实 MySQL。
- **CP-3** MySQL 5.7 `caching_sha2`/`native_password` 兼容：推到 Week 5 dogfooding（不进 CI）。
- **R-001** Tauri+workspace 摩擦：已规避（CP-1 通过）。
- **R-002** caching_sha2 握手：Week 5 验证。

相关：[[activeContext]] · [[projectbrief]]
