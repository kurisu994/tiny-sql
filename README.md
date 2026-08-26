# tiny-sql

> 多级跳板机友好的 MySQL / PostgreSQL / SQLite 桌面客户端 —— 把 SSH 跳板从「雾中一根管子」变成「可观测的路由器」。

[![CI](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/kurisu994/tiny-sql/actions/workflows/ci.yml)

**状态：稳定 Release 为 v0.7.0；main 已切 `v0.8.0-rc1`（含 SQLite driver），待 GUI/RC 验收后正式发布。** GitHub Actions 为 macOS（Apple Silicon / Intel）、Windows x64、Linux x64 产出安装包与签名更新包；正式版附四平台 `latest.json`。历史与计划见 [CHANGELOG.md](./CHANGELOG.md) 与 [docs/ROADMAP.md](./docs/ROADMAP.md)。

## 为什么又造一个 SQL 客户端

市面上的 SQL 桌面客户端（DBeaver / TablePlus / Navicat / DataGrip）几乎都把 SSH 隧道当「雾中一根管子」处理——**单跳、黑盒，出错不知道哪一跳挂了**。但生产环境里多级跳板机（堡垒机 → 内网堡垒 → 业务跳板 → MySQL）是常态。

tiny-sql 把每一跳都当成 UI 上的一等公民：

- **原生多跳 SSH**，不用手动 `ssh -L` 拼链路、改 `~/.ssh/config`
- **可视化跳板拓扑**，连接失败时高亮断点的那一跳
- **keepalive 感知断开**，隧道任意一跳挂掉 180s 内推送到 UI
- 纯 Rust 异步 SSH（russh），跨平台无需系统 `ssh` / `sshpass`

自用 + 同事可用 + 开源。不收费、无遥测、业务数据仅本地；自动更新只访问 GitHub Release 的正式版清单。

## 当前能力

**连接与 SSH**

- N 跳 SSH：密码 / 私钥认证、passphrase 会话缓存（可选加密持久化）、TOFU host key 校验、指纹变更硬拒绝。
- 可视化拓扑：本机 → N 跳 → 数据库，展示每跳 `pending / connected / failed / lost` 状态与累计协议 RTT；keepalive 默认 180s 内感知断开，支持手动幂等重连。

**数据库**

- 三 driver：MySQL（5.7 / 8.0 / 8.4）、PostgreSQL、SQLite，编辑器按连接切换方言。
- SQLite 直接打开本地 `.db` 文件：不需要主机 / 账号，也不经过 SSH 隧道。
- 元数据树：database / schema / table / column / index / constraint 按需展开 + 对象搜索。
- 数据浏览：服务端筛选 / 排序 / 分页（不整拉全表），结果上限 10 万行。

**SQL 编辑器**

- CodeMirror 三方言高亮（MySQL / PostgreSQL / SQLite）、schema-aware 补全、多语句执行与格式化；写操作二次确认；网络型独立 control pool 取消（SQLite 走原生 progress handler）。
- 可靠事务：独占 session 上 `BEGIN` / `COMMIT` / `ROLLBACK`。
- SQL 文件打开 / 保存 / 最近文件；SQL 历史（最近 100 条加密落盘）。

**数据工作流**

- 查询结果导出 CSV / Excel（后端流式写文件，区分 SQL NULL 与空字符串）。
- 表格安全编辑：仅带主键单表，dirty 暂存 + 单事务批量提交。
- 结构查看 / DDL 预览 / 新建表 / 修改表与索引。
- CSV 导入 + SQL dump 导入导出；官方 mysqldump/pg_dump/sqlite3 备份恢复（需本机工具）。
- 加密分享连接（独立口令）；双连接结构对比与可审阅同步 SQL；只读 ER 关系图。
- 同方言表数据拷贝（追加或先清空再插入，须手输目标表）；MySQL 权限预览（PG 角色只读）；EXPLAIN 计划树（ANALYZE 需确认）。
- 连接可设应用只读与生产/预发/开发标签；同库复制为新表；结果格检查器与外键跳转；非主键列可预览重命名。

**安全与分发**

- 连接配置 AES-GCM 加密落盘；可选主密码（Argon2id）加护并支持锁定 / 重置。
- 跨平台打包 + 正式版自动更新（RC / beta / alpha 不作为更新源）。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2.x |
| 前端 | Next.js 16 (Turbopack) + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui |
| 后端 | Rust (Edition 2021, MSRV 1.77.2) + Tokio |
| SSH 隧道 | russh 0.54（N 跳，纯 Rust 异步） |
| 数据库 | sqlx 0.8（MySQL + PostgreSQL + SQLite 三 driver，SQLite 静态内建） |

完整变更历史见 [CHANGELOG.md](./CHANGELOG.md)。

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
| `just test-integration` | integration 测试（连本地 MySQL / PostgreSQL，需 `.env` 设 `TINY_SQL_TEST_MYSQL_URL` 与 `TINY_SQL_TEST_POSTGRES_URL`，见 `.env.example`；SQLite 用临时文件库，已并入 `just test`） |
| `just version <ver>` | 同步更新各配置版本号（如 `just version 0.4.0`） |
| `just release <tag>` | 🚀 一键发布：更新版本号 + Commit + 打 Tag + 推送触发云端构建（如 `just release v0.4.0`） |
| `just clean` | 清理构建产物 |

## 项目结构

```
crates/                     # Rust workspace 成员（与 Tauri 解耦，未来可独立 publish）
├── ssh-multihop/           # N 跳 SSH 隧道（russh，Tauri-free）
└── db-driver/              # 数据库 driver（对象安全 Driver 契约 + MySQL/PostgreSQL/SQLite 三实现）

src-tauri/                  # Tauri 壳
├── src/
│   ├── lib.rs              # Tauri 入口 + commands
│   └── main.rs
├── capabilities/           # 权限配置
└── tauri.conf.json

src/                        # 前端源码（Next.js App Router）
├── app/                    # layout / page / globals.css
├── components/             # 业务组件（连接表单 / schema 树 / SQL 编辑器 / 拓扑图等）
├── lib/                    # tauri-api / ddl / connection-meta / clone-table / cell-inspect / explain 等
├── stores/                 # zustand（connection / security / session / confirm）
└── hooks/                  # use-update-checker / use-column-widths

docs/                       # 项目文档
├── REQUIREMENTS.md         # 需求文档
├── PLAN.md                 # 待办（只留未完成项）
├── ARCHITECTURE.md         # 架构设计
└── ROADMAP.md              # 路线图

CHANGELOG.md                # 变更日志
justfile                    # 项目命令入口
```

## 安装

> 从 [v0.7.0 Release](https://github.com/kurisu994/tiny-sql/releases/tag/v0.7.0) 下载当前稳定版（云端打包完成后资产才会齐）。

v0.7.0 提供 **macOS（Apple Silicon + Intel）** `.dmg`、**Windows x64** `.exe` 和 **Linux x64** `.AppImage`。

`v0.8.0-rc1` 已发布为 prerelease（含 SQLite 支持），正式版发布前需手动下载验证。

正式版会在 GitHub Release 中附带 `latest.json` 与签名更新包，应用内自动更新只跟随 GitHub 的 latest 正式版。`v*-rc*`、beta、alpha 预发布版本仍需手动下载验证。

### macOS 首次打开

当前版本暂未配置 Apple Developer 代码签名 / notarization。安装 `.dmg` 后首次打开时，优先在 Finder 中对 `tiny-sql.app` 右键选择「打开」，再在系统弹窗中确认打开。

如果仍提示**"已损坏，无法打开"**，在终端执行：

```bash
xattr -cr /Applications/tiny-sql.app
```

然后重新打开即可。

## v0.1 验收范围（历史）

以下场景记录了 v0.1 的日常多跳 MySQL 查询回归场景（已随 v0.1 发布完成验收）。

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

- [English README](./README_EN.md)
- [贡献指南](./CONTRIBUTING.md)
- [需求文档](./docs/REQUIREMENTS.md)
- [开发计划](./docs/PLAN.md)
- [架构设计](./docs/ARCHITECTURE.md)
- [路线图](./docs/ROADMAP.md)
- [发布检查清单](./docs/RELEASE_CHECKLIST.md)

## License

MIT
