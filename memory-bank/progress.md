# 进度（progress）

> 面向历史回溯：发生了什么、为什么变。重大架构变更记日期。

## 版本发布历史

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.1.0 | 🚧 开发中（Week 1-2 已完成） | MySQL + 3 跳 SSH + 拓扑图 + macOS only，预期 2026-08 月初发布 |
| v0.2 | 规划 | PG driver + 自动更新 + passphrase 加密 + TLS + Schema-aware 联想 |
| v0.3+ | 规划 | Win/Linux + crate 独立 publish + 多集群 diff |

CHANGELOG 当前全部在 `[Unreleased]` 段（Week 1-2：脚手架 + 加密 store + 多跳 SSH / MySQL driver / 连接管理 + 测试基建）。

## 开发阶段完成度（5-6 周计划）

| 周 | 内容 | 状态 |
|---|---|---|
| Week 1 | vertical slice（workspace + 单跳 SSH + sqlx SELECT 1 + hello 页） | ✅ 静态验证完成，CP-1b 待用户 GUI smoke |
| Week 2 | 测试基础设施 + `MySqlDriver` struct + 加密 store + 连接管理 UI | ✅ 静态验证完成（playwright E2E 推迟；CP-2 工时未记录） |
| Week 3 | 多跳 SSH + keepalive + 错误模型三变体 + TOFU + 表浏览 | ⬜ |
| Week 4 | SQL 执行（子查询包装 + KILL QUERY）+ 拓扑图 + .dmg | ⬜ |
| Week 5 | dogfooding + 修 bug + README/GIF + tag v0.1.0 | ⬜ |
| Week 6 / 7 | 缓冲 / launch（V2EX + 掘金） | ⬜ |

## Git 提交历史

| commit | 内容 |
|---|---|
| `8a902c6` | docs: v0.1 工程文档（需求/计划/架构/路线图） |
| `a1cc3ef` | feat: Week 1 vertical slice — 单跳 SSH + sqlx SELECT 1 |
| `0fe1a5c` / `2494cf5` | docs: README/CHANGELOG/AGENTS、memory-bank 初始化 |
| `d0973ef` | docs: 添加 MIT LICENSE |
| `525e769` | feat(db-driver): MySqlDriver 与元数据/结果集查询 |
| `6395092` | feat(config): 加密 store 与连接配置 CRUD |
| `ac6cef6` | feat(commands): connection CRUD/测试连接命令与 AppState |
| `0f758aa` | feat(ui): 连接管理列表与编辑表单 |
| `97711dd` | tests(db-driver): integration 测试连本地 MySQL |
| `0bbd9b5` | tests(web): vitest 前端单测与 CI/justfile 接入 |

> 注：`d0973ef`（含）之前已 push 到远端 `git@github.com:kurisu994/tiny-sql.git`；
> Week 2 的 6 个 commit（`525e769`…`0bbd9b5`）及本次文档收尾**尚未 push**。

## 重大决策与架构变更记录

- **2026-06-26 选 Approach B（Clean Workspace）**：放弃 fork redis-desktop-client，改独立 workspace + 独立 crate。理由：长期维护 + `ssh-multihop` 未来独立 publish。
- **2026-06-26 plan-eng-review 9 个 binding 决策**：keepalive 30s→60s+3 次阈值 / SQL 取消用独立 control conn KILL QUERY / `SshTunnelError` 加 TunnelLost+ChannelDropped+AcceptLoopDied / trait Driver 推 v0.2 / 测试无 Docker 连本地 MySQL / LIMIT 用子查询包装 / **Week 1 改 vertical slice** / read-only best-effort / Codex tension 记 v0.2。
- **2026-06-26 文档全量改 draft-2**：4 篇 docs 落地上述 9 决策，PLAN.md 重写（Week 1 = vertical slice）。
- **2026-06-27 Week 2 整体文件加密**：连接配置用整个 `connections.enc` 文件 AES-GCM 加密（强于 redis-desktop-client 的逐字段加密），满足 FR-001（host/user 也不明文）。
- **2026-06-27 playwright E2E 推迟**：Tauri WebDriver 不支持 macOS（CI 是 macOS arm64）。Week 2 测试基建改用 vitest（前端单测）+ db-driver integration（连本地 MySQL）进 CI，E2E 留将来 Linux CI / dogfooding。

## 已解决的阻碍

| 问题 | 根因 | 解决 |
|---|---|---|
| sqlx feature 报错 | 写成 `rustls`，sqlx 0.8 无此 feature | 改 `runtime-tokio-rustls` |
| `pnpm build` exit 1 | pnpm 11 `verify-deps-before-run` 因 sharp 构建脚本未批准而 exit | `pnpm-workspace.yaml` 加 `allowBuilds: sharp: true`（pnpm 11 读 workspace.yaml 而非 package.json） |
| `tauri::Manager` unused 警告 | `app.handle()` 是 inherent 方法 | 删除 import |
| CP-1（Tauri+workspace 摩擦，Week 1 最大风险） | — | 已验证通过，`cargo check --workspace` 正常引用 crate |

## 待验证 / 风险跟踪

- **CP-1b** GUI 运行时 smoke：待用户 `pnpm tauri dev` 连真实 MySQL（现可测连接管理 CRUD + 测试连接）。
- **CP-2** Week 2 末 25h 累计工时检查（PLAN §3.3）：未正式记录工时，下次同步补。
- **CP-3** MySQL 5.7 `caching_sha2`/`native_password` 兼容：推到 Week 5 dogfooding（不进 CI）。
- **R-001** Tauri+workspace 摩擦：已规避（CP-1 通过）。
- **R-002** caching_sha2 握手：Week 5 验证。

相关：[[activeContext]] · [[projectbrief]]
