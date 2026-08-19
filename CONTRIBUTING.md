# 贡献指南

感谢你对 tiny-sql 感兴趣！tiny-sql 是一个多级跳板机友好的 MySQL / PostgreSQL 桌面客户端，技术栈为 **Tauri 2 + Next.js 16 + Rust workspace**。本文档帮助你快速搭建环境并对齐协作约定。

## 环境准备

- [Node.js](https://nodejs.org/)：版本见仓库根目录 `.nvmrc`（LTS）
- [pnpm](https://pnpm.io/) 11+
- [Rust](https://rustup.rs/) stable（MSRV 1.77.2）
- [just](https://github.com/casey/just)：项目统一的命令运行器
- Tauri 2 系统依赖：参考 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)

首次克隆后执行：

```bash
just install      # pnpm install + cargo fetch
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `just dev` | 启动 Tauri 完整开发模式（前后端热重载） |
| `just dev-web` | 仅启动 Next.js 前端（localhost:3000） |
| `just check` | 提交前一键自检（fmt 检查 + clippy + 测试 + 前端 build，等价 CI） |
| `just fmt` / `just fmt-check` | 格式化 Rust 代码 / 仅检查不修改 |
| `just lint` | 全量检查（tsc + clippy） |
| `just test` | Rust workspace + 前端 Vitest 单元测试 |
| `just test-integration` | 连真实数据库的 integration 测试（见下） |
| `just build` / `just build-web` | 生产构建桌面应用 / 仅前端静态导出 |

更多命令直接运行 `just` 查看完整列表。

### Integration 测试

integration 测试连接**本地真实数据库**，不使用 Docker。复制 `.env.example` 为 `.env` 并填写：

```bash
TINY_SQL_TEST_MYSQL_URL=mysql://root:password@127.0.0.1:3306/test
TINY_SQL_TEST_POSTGRES_URL=postgresql://postgres:password@127.0.0.1:5432/postgres
```

然后运行 `just test-integration`（也可用 `just test-mysql-integration` / `just test-postgres-integration` 单独回归某一种数据库）。

## 项目结构导读

```
crates/
├── ssh-multihop/    # N 跳 SSH 隧道（russh），不依赖 Tauri，未来可独立 publish
└── db-driver/       # MySQL / PostgreSQL driver（基于 sqlx）

src-tauri/           # Tauri 壳：src/lib.rs 为入口与 #[tauri::command]，tauri.conf.json 为配置
src/                 # 前端源码（Next.js App Router），静态导出到 out/
docs/                # 需求 / 计划 / 架构 / 路线图文档
justfile             # 项目命令入口
```

## 提交规范

- Commit message **使用中文**，格式：`[可选 emoji] 类型(可选范围): 动词开头的主题`，主题不超过 50 字。
- 常用类型：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `tests` / `chore` / `workflow` / `build` / `CI` / `release` 等。
- **不要**添加 `Co-authored-by`、`Generated with ...` 等署名。
- 复杂变更正文用 1-5 条说明「做了什么」和「为什么做」，不贴原始 diff。

## Pull Request 要求

- 提 PR 前本地必须通过 `just check`（warning 即失败，与 CI 对齐；CI 仅在 macOS arm64 上运行）。
- PR 描述写清「做了什么 / 为什么」，关联相关 issue。
- 涉及 UI 改动请附截图。
- 功能变更请同步更新 `CHANGELOG.md` 的 `[Unreleased]` 段。

## 编码约定

- 公共类型与函数加**中文注释**说明用途；复杂逻辑补行内中文注释。
- 错误对外走稳定的 i18n key（如 `error.ssh.*`），**不向前端泄露后端语言原文**。
- 数据库设计**不定义 FOREIGN KEY** 约束，表关联由代码逻辑、索引和校验控制。
- `crates/ssh-multihop` **不得依赖 Tauri 或任何数据库驱动**，保持可独立 publish。
- `crates/db-driver` 只面向数据库协议，**不知道 SSH 的存在**；隧道由上层组装。
- 日志保留关键业务上下文，避免记录密码、私钥、passphrase 等敏感信息。

## 测试约定

- Rust 单元测试与被测代码放在同一文件的 `#[cfg(test)] mod tests` 内，用 `just test` 运行。
- 连真实数据库的 integration 测试标注 `#[ignore]`，用 `just test-integration` 运行。
- CI 只跑单元测试与编译检查，不连真实数据库。

## 安全相关改动

涉及**加密、凭据存储、TLS / 证书校验、主机指纹**等安全敏感改动时，请在 PR 描述中明确说明：

- 威胁模型的影响（防什么、不防什么）；
- 是否改变了已有安全默认值或校验行为；
- 是否需要补充文档或 CHANGELOG 安全说明。

## 文档

改动方案前建议先读 [docs/](./docs) 下的需求、架构与路线图文档，保持实现与设计一致。

## License

贡献的代码默认以 [MIT](./README.md#license) 协议发布。
