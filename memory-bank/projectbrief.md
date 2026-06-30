# 项目简介（projectbrief）

> 给第一次接触 tiny-sql 的人：这是什么、做什么、给谁用、交付什么。

## 一句话

**tiny-sql** 是一款**多级跳板机友好的 MySQL 桌面客户端**——把 SSH 跳板从「雾中一根管子」变成「可观测的路由器」。

## 核心愿景

主流 SQL 客户端（DBeaver / TablePlus / Navicat / DataGrip / Sequel Ace）把 SSH 隧道当作单跳、黑盒的「一根管子」，出错无法定位是第几跳挂了。tiny-sql 把**每一跳都做成 UI 上的一等公民节点**：独立连接状态、独立错误归因、独立延迟读数。连接失败时拓扑图高亮断点那一跳，隧道任意一跳挂掉 180s 内推送 lost 状态到 UI。

这是把 SSH 从「网络层」提升到「数据模型层」的理念差距，而非单纯 feature 差距。

## 目标用户（三类，需求高度重叠）

| 画像 | 身份 | 关键诉求 |
|---|---|---|
| A 作者自用 | 每天连 4 层堡垒生产 MySQL 的工程师 | 高频连接免手动 `ssh -L`；故障时一眼看出哪跳挂 |
| B 同事推广 | 同公司面对多级堡垒的运维/后端/数据 | 不会配 ProxyJump；无 $99 苹果账号也能用 |
| C 开源社区 | V2EX/掘金/GitHub 上的中文开发者 | 1-2 跳常见；首发 zh-CN；issue/PR 24h 内回应 |

## v0.1 范围与交付物

- **范围**：MySQL only（5.7 + 8.0）+ 3 跳 SSH + 拓扑图 + macOS only（arm64 + x64）+ zh-CN only + 正式版自动更新；v0.1 无 Apple Developer 代码签名 / notarization。
- **预算**：5-6 周 × 12-13 小时/周 = 60-75 小时。
- **交付物**：GitHub Releases 上的 `.dmg`、Tauri updater `.app.tar.gz` / `.sig` 与正式版 `latest.json`；tag `v0.1.0` 触发 CI 自动构建上传。
- **发布门槛**：作者 + 2 同事 dogfooding ≥ 1 周，0 数据丢失、0 不可恢复 crash。

## 关键产品决策

- **Approach B（Clean Workspace）**：独立 crate（`ssh-multihop` / `db-driver`），未来可独立 publish，仓库诞生即干净。
- **v0.1 具体 struct，v0.2 才抽 trait**：避免单实现 trait 的过早抽象。
- **best-effort 只读保护**：正则二次确认，真正只读建议用 MySQL 只读账号。
- **仅本地数据**：无遥测、无错误上报；自动更新只访问 GitHub Release 的正式版更新清单。

## 配套文档

详细需求/计划/架构/路线见 `docs/`：[REQUIREMENTS](../docs/REQUIREMENTS.md) · [PLAN](../docs/PLAN.md) · [ARCHITECTURE](../docs/ARCHITECTURE.md) · [ROADMAP](../docs/ROADMAP.md)。
