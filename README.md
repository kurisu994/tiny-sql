# tiny-sql

> 多级跳板机友好的 MySQL 桌面客户端 —— 把 SSH 跳板从「雾中一根管子」变成「可观测的路由器」。

[![CI](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml)

**状态：当前预览版为 v0.0.3，v0.1 仍处于 Week 5 dogfooding，原定 2026-08 月初的正式发布已延期**。Week 1-4 的实现与静态验证已经落地；v0.0.3 也已通过 GitHub Actions 产出 macOS / Windows / Linux 安装包、签名更新包和 `latest.json`。当前发布门槛是真实 3 跳 SSH + MySQL GUI 试用、MySQL 5.7、作者与 2 位同事各使用 1 周、README GIF，以及最终 `v0.1.0` RC / 正式版验收。完整范围与进度见 [docs/PLAN.md](./docs/PLAN.md) 与 [docs/ROADMAP.md](./docs/ROADMAP.md)。

## 为什么又造一个 SQL 客户端

市面上的 SQL 桌面客户端（DBeaver / TablePlus / Navicat / DataGrip）几乎都把 SSH 隧道当「雾中一根管子」处理——**单跳、黑盒，出错不知道哪一跳挂了**。但生产环境里多级跳板机（堡垒机 → 内网堡垒 → 业务跳板 → MySQL）是常态。

tiny-sql 把每一跳都当成 UI 上的一等公民：

- **原生多跳 SSH**，不用手动 `ssh -L` 拼链路、改 `~/.ssh/config`
- **可视化跳板拓扑**，连接失败时高亮断点的那一跳
- **keepalive 感知断开**，隧道任意一跳挂掉 180s 内推送到 UI
- 纯 Rust 异步 SSH（russh），跨平台无需系统 `ssh` / `sshpass`

自用 + 同事可用 + 开源。不收费、无遥测、业务数据仅本地；自动更新只访问 GitHub Release 的正式版清单。

## v0.1 当前能力

- N 跳 SSH 配置与连接：密码 / 私钥认证、passphrase 会话缓存、TOFU host key 校验、指纹变更硬拒绝。
- MySQL SSL/TLS 配置：默认禁用，可显式选择 Preferred / Required / Verify CA / Verify Identity，并传入 CA、客户端证书与私钥路径；真实 TLS 服务器验收尚未完成。
- MySQL 数据浏览：列出 database / table，点表浏览前 1000 行。（`db_list_columns` 后端已实现，前端列清单 UI 留 v0.2）
- SQL 执行：CodeMirror SQL 编辑器支持语法高亮、行号、基础 schema/table 补全和快捷执行；后端拒绝空 SQL / 多语句，`SELECT` / `WITH` 顶层安全时自动追加 `LIMIT`，结果上限 10 万行。
- SQL 取消：执行时记录 MySQL `CONNECTION_ID()`，取消时通过独立 control pool 发 `KILL QUERY`。
- 拓扑状态：本机 → N 跳 → MySQL 的只读拓扑图，支持 `pending` / `connected` / `failed` / `lost`。
- 跨平台打包：GitHub Release workflow 监听 `v*` tag，产出 macOS Apple Silicon + Intel `.dmg`、Windows x64 `.exe`、Linux x64 `.AppImage`，正式版同时发布 Tauri 自动更新清单。
- 自动更新：桌面端启动后每日检查一次正式版更新，macOS 应用菜单可手动检查；RC / beta / alpha 不作为自动更新源。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2.x |
| 前端 | Next.js 16 (Turbopack) + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui |
| 后端 | Rust (Edition 2021, MSRV 1.77.2) + Tokio |
| SSH 隧道 | russh 0.54（N 跳，纯 Rust 异步） |
| 数据库 | sqlx 0.8（MySQL；v0.2 加 PostgreSQL） |

> v0.2 之后再考虑 PostgreSQL、MySQL TLS 真实环境验收与证书 UX 打磨、SQL 历史、导出与 schema-aware 智能联想。详见 [ROADMAP](./docs/ROADMAP.md)。

## 开发环境准备

### 前置依赖

- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/) 11+
- [Rust](https://rustup.rs/) (MSRV 1.77.2)
- [just](https://github.com/casey/just)（命令运行器）
- Tauri 2 系统依赖（参考 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)）

### 安装与开发

```bash
just install      # pnpm install + cargo fetch
just dev          # 启动 Tauri 完整开发环境（前后端热重载）
just dev-web      # 仅启动 Next.js 前端（localhost:3000）
```

### 构建

```bash
just build        # 生产构建（桌面应用，出 .dmg / .app）
just build-web    # 仅构建前端（静态导出到 out/）
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `just dev` | 启动 Tauri 开发模式（前后端热重载） |
| `just dev-web` | 仅启动 Next.js 前端 |
| `just build` | 生产构建桌面应用 |
| `just build-web` | 仅构建前端资源 |
| `just build-debug` | 构建 Debug 版本（含调试符号） |
| `just check` | 提交前一键自检（fmt 检查 + clippy + 测试 + 前端 build，对齐 CI） |
| `just lint` | 完整代码检查（tsc + Clippy） |
| `just lint-rust` | 仅 Rust 检查（Clippy） |
| `just lint-web` | 仅前端类型检查（tsc） |
| `just fmt` | 格式化 Rust 代码 |
| `just fmt-check` | 仅检查格式不修改（CI 用） |
| `just test` | Rust workspace + 前端 Vitest 单元测试 |
| `just test-integration` | integration 测试（连本地 MySQL，需 `.env` 设 `TINY_SQL_TEST_MYSQL_URL`，见 `.env.example`） |
| `just version <ver>` | 同步更新各配置版本号（如 `just version 0.2.0`） |
| `just release <tag>` | 🚀 一键发布：更新版本号 + Commit + 打 Tag + 推送触发云端构建（如 `just release v0.1.0`） |
| `just clean` | 清理构建产物 |

## 项目结构

```
crates/                     # Rust workspace 成员（与 Tauri 解耦，未来可独立 publish）
├── ssh-multihop/           # N 跳 SSH 隧道（russh，Tauri-free）
└── db-driver/              # MySQL driver（v0.1 具体 struct，v0.2 extract trait）

src-tauri/                  # Tauri 壳
├── src/
│   ├── lib.rs              # Tauri 入口 + commands
│   └── main.rs
├── capabilities/           # 权限配置
└── tauri.conf.json

src/                        # 前端源码（Next.js App Router）
├── app/                    # layout / page / globals.css
├── components/             # 业务组件（连接表单 / schema 树 / SQL 编辑器 / 拓扑图等）
├── lib/                    # 工具（tauri-api / sql-guard / sql-editor）
├── stores/                 # zustand store（connection / session / confirm）
└── hooks/                  # React hooks（use-update-checker）

docs/                       # 项目文档
├── REQUIREMENTS.md         # 需求文档
├── PLAN.md                 # 开发计划（按周）
├── ARCHITECTURE.md         # 架构设计（数据流 / 状态机 / 错误模型）
└── ROADMAP.md              # 路线图（v0.1 / v0.2 / v0.3+）

CHANGELOG.md                # 变更日志
justfile                    # 项目命令入口
```

## 安装

> v0.1 尚未正式发布。当前可从 [Releases](https://github.com/kurisu994/tiny-sql/releases) 下载 v0.0.3 预览版；Week 5 dogfooding 继续使用本地或 GitHub Release 产出的桌面安装包。

v0.1 先提供 **macOS（Apple Silicon + Intel）** `.dmg`、**Windows x64** `.exe` 和 **Linux x64** `.AppImage`；Windows / Linux 产物先用于 dogfooding 与兼容验证。

正式版会在 GitHub Release 中附带 `latest.json` 与签名更新包，应用内自动更新只跟随 GitHub 的 latest 正式版。`v*-rc*`、beta、alpha 预发布版本仍需手动下载验证。

### macOS 首次打开

v0.1 暂未配置 Apple Developer 代码签名 / notarization。安装 `.dmg` 后首次打开时，优先在 Finder 中对 `tiny-sql.app` 右键选择「打开」，再在系统弹窗中确认打开。

如果仍提示**"已损坏，无法打开"**，在终端执行：

```bash
xattr -cr /Applications/tiny-sql.app
```

然后重新打开即可。

## Week 5 dogfooding

dogfooding 目标是确认 v0.1 能不能真实承担日常多跳 MySQL 查询，而不只是通过静态测试。

### 必验场景

- 真实 3 跳 SSH + MySQL 连接：连接成功后能列出 database / table。
- TOFU：首次未知 host 弹窗；已信任 host 静默；指纹变更硬拒绝。
- passphrase：私钥首次输入后同一会话内复用，退出应用后重新要求输入。
- 表浏览：点表后展示前 1000 行，滚动不卡顿。
- SQL 执行：覆盖 SELECT / JOIN / 聚合 / 大表无 LIMIT 截断提示。
- SQL 取消：`SELECT SLEEP(60)` 执行中取消，UI 停止等待，`SHOW PROCESSLIST` 中 query 消失。
- 拓扑状态：故意断中间跳后，180s 内对应 hop 变为 `lost`。
- MySQL 5.7：至少一位同事在 5.7 环境完成连接与 SELECT 验证。

试用记录不要写入公开仓库。仓库提供 [dogfooding 日志模板](./docs/dogfooding-log.template.md)，实际记录文件 `docs/dogfooding-log.md` 已被 `.gitignore` 忽略。

## 文档

- [需求文档](./docs/REQUIREMENTS.md)
- [开发计划](./docs/PLAN.md)
- [架构设计](./docs/ARCHITECTURE.md)
- [路线图](./docs/ROADMAP.md)
- [v0.1 发布检查清单](./docs/RELEASE_CHECKLIST.md)

## License

MIT
