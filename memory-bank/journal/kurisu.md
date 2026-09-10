# 开发日志（Kurisu）

> 只追加，不改历史；每段结尾留一个空行（`merge=union` 靠空行分隔）。会话流水写这里，里程碑写 `archive/`。

## 2026-08-25 — SQLite driver 落地

第三个 `Driver` 实现，`db-driver` 从「双 driver」变成「三 driver」。这是第一个**非网络型** driver，动了三处一直只为网络型数据库准备的假设：连接模型（`DriverKind::is_file_based()` 短路）、取消机制（无服务端，改用 SQLite 原生 progress handler，不需要 control pool）、元数据层级（无 schema，`MetadataScope.schema` 恒为 None）。

踩到的坑：SQLite 是动态类型，`SqliteColumn::type_info()` 给的是**列声明类型**，表达式列（`COUNT(*)`、`a + b`）根本没有声明类型 → 按它分派会把非空值一律解码成 NULL。改为按 `ValueRef` 的**取值真实类型**分派。这个 bug 是 SQLite integration 测试抓出来的——也正因为 SQLite 不需要外部服务，这套测试用临时文件库、不标 `#[ignore]`，进了默认 `just test`。

顺带把 `ActiveDriver` 的通用 `Driver` 方法从「每个方法三份 match」收敛成 `inner() -> &dyn Driver` 委托。

## 2026-08-29 — v0.8.0 发布 + 三项体验优化

`just release v0.8.0`（发布提交 `12d3aae`，Release run `33230468506` 四平台全部成功，含四平台资产与已核对的 `latest.json`）。rc1 08-26、rc2 08-28。范围：FR-270–275、SQLite driver、应用设置弹窗与更新代理、ER 关系图重做为实体卡片画布 + 整库结构批量拉取。

发布后当天又落了三项 Unreleased 体验优化（`495fde2`）：连接列表拖拽排序、工作台工具栏合并、测试连接延迟。拖拽排序把 FR-003 的 `last_used_at` 自动排序换成了手动顺序——双击连接自动跳顶和手动排序无法共存，问了用户后选手动。

## 2026-08-31 — 记忆银行归档

把 `activeContext.md` / `progress.md` 里的历史挪进 `archive/2026-08/`，两个文件瘦身。**遗留问题**：`docs/PLAN.md` / `ROADMAP.md` / `REQUIREMENTS.md` 里十几个 `progress.md#vXX-已交付周计划归档` 锚点跟着悬空了，当时没扫。

## 2026-09-10 — 记忆银行迁移到四层结构

旧版 6 枢纽 → 新版四层（`00-project` / `1X-*` / `active/` / `journal/` / `archive/`）。用 `migrate_legacy.py --apply` 搬运，AI 做合并拆分：systemPatterns + techContext 拆成 `10-ssh-multihop` / `11-db-driver` / `12-tauri-shell` / `13-toolchain` / `20-frontend` 五份，各带 `paths` frontmatter。顺带把上一轮遗留的悬空锚点指向 `archive/2026-08/progress.md`。

注意：Pi 不支持路径触发注入（扩展只能走 systemPrompt / 会话级注入），hook 只对 Claude Code 生效；Pi 里按 `memory-bank/README.md` 的映射表人工查阅。
