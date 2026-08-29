# 发布检查清单

> 本文件用于各版本 dogfooding、RC 和正式发布。不要在这里记录真实 host、用户名、库名、表名、IP 或公司环境细节；真实记录写到被忽略的 `docs/dogfooding-log.md`。

## v0.8 发布检查清单

> **v0.8.0 正式版发布结果（2026-08-29）**：发布提交 `12d3aae`、tag `v0.8.0`，Release workflow [run 33230468506](https://github.com/kurisu994/tiny-sql/actions/runs/33230468506) 四平台全部成功。[GitHub Release](https://github.com/kurisu994/tiny-sql/releases/tag/v0.8.0) 为非草稿、非预发布且是 latest，含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows x64 `.exe(.sig)`、Linux x64 `.AppImage(.sig)` 和正式版 `latest.json`；四个平台 URL 均已核对指向 `v0.8.0` 资产且带签名。相比 rc2 追加了关系图重做（实体卡片画布）与 `db_schema_overview` 整库结构批量拉取——这两项只做过 jsdom + 截图验证，作者决定不再等额外 GUI 实测轮次直接切正式版，发布后 GUI 上发现的 ER 问题走 v0.8.1 补丁。
>
> **v0.8.0-rc2 发布结果（2026-08-28）**：发布提交 `53c5e5a`、tag `v0.8.0-rc2`（2026-08-26 先发 `v0.8.0-rc1`，提交 `754f033`）；prerelease（非草稿，无 `latest.json`），不影响 v0.7.0 稳定版用户。四平台构建以 GitHub Actions 为准。rc2 含应用设置弹窗（Settings…，⌘,）。

### v0.8 RC 前本地检查

- `just check` 全绿（含 SQLite integration：临时文件库 23 条已并入默认测试）。
- 只读连接的写 command 均返回 `error.connection.read_only`。
- 旧连接缺 `readOnly` / `env` 字段仍能打开。

### v0.8 功能验收

- 只读连接无法执行 UPDATE / 导入 / 恢复 / 拷贝目标 / GRANT / ANALYZE。
- prod 标签出现在列表、标题与破坏性确认框。
- 同库能预览并创建新表（若未降级）。
- 单元格能看完整值；单列 FK 能跳转或已降级为只检查器。
- SQLite 全链路：新建连接选文件 → 库树 / 结构 / 浏览编辑 / SQL 编辑器（SQLite 方言）/ CSV 导入 / dump 导出导入；`sqlite3` 官方备份（仅整库）与恢复；无账号权限视图（`error.privilege.unsupported`）。
- 设置弹窗（rc2 新增）：自动检查更新开关、更新代理（✓/✕ 保存）、默认每页行数、编辑器字号、写确认开关、主密码入口与版本信息均真实生效。

### v0.8 正式发布追加条件

- V8-T8.1 / T8.2 由作者验收。
- rc2 已发布；GUI 实测通过后执行 `just release v0.8.0`。**（2026-08-29 已执行）**

## v0.7 发布检查清单

### v0.7 RC 前本地检查

- `just check` 全绿。
- 拷贝映射 / 权限 SQL / EXPLAIN 树单测通过。

### v0.7 功能验收

- 同方言两张表追加拷贝；手输目标名；replace 展示 TRUNCATE。
- MySQL GRANT 预览执行；列表无密码哈希；PG 权限只读。
- EXPLAIN 树；ANALYZE 先确认。

### v0.7 正式发布追加条件

> **v0.7.0 发布结果（2026-08-24）**：发布提交 `d2d3f5c`、tag `v0.7.0`。作者确认跳过单独 0.4/0.5/0.6 正式切版，将 v0.4–v0.7 一次打进稳定版。云端四平台资产与 `latest.json` 以 GitHub Actions 为准。

- 发布后 GUI 回归发现的 P0/P1 走补丁，不混进 v0.8。

## v0.6 发布检查清单

### v0.6 RC 前本地检查

- `just check` 全绿。
- schema-diff / schema-sync / schema-er 单测覆盖空库、加表、删列、跨 driver 拒绝、FK 解析。
- `CHANGELOG.md` `[Unreleased]` 覆盖 v0.6 用户可见变更。

### v0.6 功能验收

- 对比：两条已打开连接可选；未打开的不会被偷偷连接；表仅左/仅右/变更能看出来。
- 同步：同方言能生成 SQL；跨 driver 拒绝；确认框含目标连接名；失败能看到语句序号。
- ER：有 FK 能连线；无 FK 不崩；点击表能进结构。

### v0.6 正式发布追加条件

- V6-T8.1 / T8.2 由作者验收后再 `just release`。

## v0.5 发布检查清单

### v0.5 RC 前本地检查

- `just check` 全绿。
- 备份相关单测：defaults/pgpass 不含进 argv、缺工具稳定 key、分享口令/篡改拒绝。
- `CHANGELOG.md` 的 `[Unreleased]` 覆盖 v0.5 用户可见变更。

### v0.5 功能验收（对应 PLAN.md V5-CP1~CP4）

- 修改表（FR-253）：双方言结构页改列 → SQL 预览确认 → 树刷新；不能重命名/删主键；危险语句单独成条。
- 索引 / 约束：创建/删除非主键索引；FK/CHECK 仅 DROP 预览执行。
- View：树标记 VIEW，结构只读。
- 官方备份（FR-260）：有 mysqldump 时可导出；无工具明确报错且不回退 dump；恢复必须手输库名；与「导入 SQL」入口分离。
- 连接分享（FR-221）：独立口令导出导入；错误口令/篡改失败；导入新 id；不带 known_hosts。

### v0.5 正式发布追加条件

- V5-T8.1 / T8.2 由作者验收；P0/P1 清零后再 `just release`。

## v0.4 发布检查清单

### v0.4 RC 前本地检查

- `just check` 全绿（Rust fmt/clippy/workspace 测试、Vitest、Next build）。
- `just test-integration` 双 driver 全绿（含 v0.4 新增：编辑批提交/回滚/冲突/无主键拒绝/复合主键、bulk_insert 中止/跳过模式、dump 风格 SQL 往返）。
- `just build` 产出本机安装包与 updater artifact / `.sig`。
- `CHANGELOG.md` 的 `[Unreleased]` 段覆盖 v0.4 全部用户可见变更。

### v0.4 功能验收（对应 PLAN.md V4-CP1~CP4）

- 表格编辑（FR-250）：MySQL/PostgreSQL 各自进入编辑模式 → 新增/修改/删除混合 dirty → 提交生效；提交失败（如主键重复）整体回滚且数据无残留；他端删除同行后提交报冲突；无主键表无编辑入口；复合主键表可编辑；翻页/筛选/排序/关闭 tab 有 dirty 时确认拦截；NULL 与空串提交后严格区分。
- 结构查看与 DDL 预览（FR-251）：双方言列/索引/约束整合展示正确；MySQL DDL 为 `SHOW CREATE TABLE` 原文；PG DDL 标注为重建预览。
- 新建表（FR-251）：双方言表单 → SQL 预览 → 确认执行 → 树刷新可见；类型白名单拒绝注入字符。
- CSV 导入（FR-252）：引号/内嵌换行/BOM 文件解析正确；列映射同名自动匹配；中止模式失败整批回滚；跳过模式报告失败行号；无主键表可导入；NULL/空串往返一致。
- SQL dump（FR-252）：表级导出→导入闭环数据一致；整库导出覆盖全部 BASE TABLE；大文件导入不整读内存；导入失败报告语句序号；含注释/dollar-quoted body 的 dump 不误判分号。
- 双 driver × 直连 / 1 跳 / 3 跳回归上述全部功能。

### v0.4 正式发布追加条件

> **v0.4.0-rc1 发布结果（2026-08-22）**：发布提交 `dbae167`、tag `v0.4.0-rc1`；Release workflow run `32554496338` 四平台全部成功。GitHub Release `v0.4.0-rc1` 为 prerelease（非草稿），含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows x64 `.exe(.sig)`、Linux x64 `.AppImage(.sig)`，**无 `latest.json`**（不会成为更新源）。RC 前本地检查与自动化门禁全绿（`just check`、integration 33/33、本机 dmg + updater 签名产物）；剩 GUI 真实环境回归（V4-T8.1）、一周试用（V4-T8.2）与正式发布。

- RC 试用 ≥ 1 周（沿用 V2-T8.2 标准）且 P0/P1 清零；未完成 P1 降级项明确移入 v0.4.1 或 v0.5，不在 Release notes 承诺。
- `ARCHITECTURE.md` 已含编辑内核 / 批量插入 / dump 流式分句章节；`REQUIREMENTS.md` §3.4 已收口。

---

## v0.3 发布检查清单

### v0.3 RC 前本地检查

- `just check` 全绿（Rust fmt/clippy/workspace 测试、Vitest、Next build）。
- `just test-integration` 双 driver 全绿（含 v0.3 新增：事务 session 同连接证明与回滚、浏览筛选分页、index/constraint metadata、多语句拆分执行）。
- `just build` 产出本机安装包与 updater artifact / `.sig`。
- `CHANGELOG.md` 的 `[Unreleased]` 段覆盖 v0.3 全部用户可见变更。

### v0.3 功能验收（对应 PLAN.md V3-CP1~CP4）

> **V3-T7.1 验收结果（2026-08-21）**：用户真实环境实测双 driver × 直连 / 1 跳 / 3 跳下述全部功能通过，无遗留问题；脱敏环境细节按惯例记入被忽略的 `docs/dogfooding-log.md`。

- 事务（FR-244）：MySQL/PostgreSQL 各自开始事务 → 多条 SQL → 提交生效 / 回滚消失；事务中取消查询、关闭 tab、断开重连连接，未提交事务均回滚且 UI 状态正确清理；两个事务 tab 并行互不串连接。
- 浏览（FR-242）：百万行级表筛选 / 排序 / 翻页不整拉全表；PG 数值列筛选正常；COUNT 超时降级为未知总数分页仍可翻页。
- 元数据树与搜索（FR-241）：双方言索引 / 约束展示正确；对象搜索定位展开；DDL 后 cache 失效。
- 多语句（FR-243）：含字符串 / 注释 / dollar-quoted body 的脚本拆分正确；写语句确认流程；首错中止；dollar-quoted 函数体（PG）不破坏格式化。
- SQL 文件（FR-240）：打开 / 保存 / 另存为 / 最近文件全链路；外部修改覆盖确认；⌘O / ⌘S 快捷键。
- 双 driver × 直连 / 1 跳 / 3 跳回归上述全部功能。

### v0.3 正式发布追加条件

> **V3-T7.2 验收结果（2026-08-22）**：作者 + 试用者 RC 一周试用关闭，0 数据丢失、0 凭据泄露、0 不可恢复 crash，无阻塞正式发布的 P0/P1。

- RC 试用 ≥ 1 周（沿用 V2-T8.2 标准）且 P0/P1 清零；未完成 P1 降级项明确移入 v0.3.1 或 v0.4，不在 Release notes 承诺。
- `ARCHITECTURE.md` 已含 session/事务、多语句拆分与浏览查询章节；`REQUIREMENTS.md` §3.3 已收口。

---

## v0.2 发布检查清单

> **v0.2.0 发布结果（2026-08-20）**：Release workflow [run 32325101849](https://github.com/kurisu994/tiny-sql/actions/runs/32325101849) 全部成功；[GitHub Release](https://github.com/kurisu994/tiny-sql/releases/tag/v0.2.0) 为非草稿、非预发布且是 latest，已包含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows x64 `.exe(.sig)`、Linux x64 `.AppImage(.sig)` 和正式版 `latest.json`。`latest.json` 的四个平台 URL 均已核对指向 `v0.2.0` 资产，Release notes 与 CHANGELOG `0.2.0` 段一致。RC（`v0.2.0-rc1`）下载安装验收、PostgreSQL 15/18 双端点回归与 T8.2 关闭均已于发布前完成（见 PLAN.md 历史与 progress.md）；从 v0.1.0 应用内检查更新到 v0.2.0 的端到端实测由用户在日常使用中验证。

v0.2 在 v0.1 全平台发布链路不变的前提下，新增以下验收项（对应 `docs/PLAN.md` 的 V2-CP5）：

### v0.2 RC 前本地检查

- `just check` 全绿（Rust fmt/clippy/workspace 测试、Vitest、Next build）。
- `just test-integration` 双 driver 全绿：MySQL 5/5、PostgreSQL 4/4；PostgreSQL 需另外完成 15.latest / 18.latest 双端点回归（单一本地实例不能替代版本矩阵）。
- `just build` 产出本机安装包与 updater artifact / `.sig`。
- `CHANGELOG.md` 的 `[Unreleased]` 段覆盖 v0.2 全部用户可见变更。

### v0.2 双 driver dogfooding（V2-T8.1 / T8.2）

> 状态：T8.1 部分（双 driver × 直连/1 跳/3 跳、metadata/查询/取消/历史/tab/导出/重连、MySQL 真实 TLS 正反例、断中间跳 lost → 重连、RTT 不阻塞主链路）已于 2026-08-19 验收通过；主密码全路径与 ≥2 位试用者 RC 一周试用（T8.2）待进行。

- MySQL 与 PostgreSQL 各自完成：直连、1 跳 SSH、真实 3 跳 SSH 回归，覆盖 metadata 树、查询、取消、SQL 历史、多 tab、导出、重连。
- MySQL 真实 TLS 环境验收：Preferred / Required / Verify CA / Verify Identity 正反例与双向证书（V2-T4.3）；PostgreSQL 走 driver 默认 TLS 策略。
- 主密码全路径：启用迁移（旧配置无损）→ 重启解锁 → 错误密码拒绝且不破坏数据 → 记住 passphrase 后重启免输入 → 锁定/关闭/忘记密码重置。
- 至少 2 位试用者使用 RC ≥ 1 周，至少 1 人以 PostgreSQL 为主；要求 0 数据丢失、0 凭据泄露、0 不可恢复 crash。
- 断开中间跳后拓扑能看到 lost 且手动重连成功；RTT 采样不阻塞连接主链路。

### v0.2 正式发布追加条件

- 上述 dogfooding 全部完成且 P0/P1 清零；未完成 P2 明确移入 v0.2.1，不在 Release notes 承诺。
- `README_EN.md` 与 `CONTRIBUTING.md` 已随版本更新。
- 安全矩阵通过：旧加密文件迁移、错误主密码、损坏文件、TLS CA/hostname/客户端证书正反例、历史/passphrase 明文扫描（`cargo test -p tiny-sql` 中的 security/history 用例）。

---

## v0.1 发布检查清单

## 当前发布范围

> **v0.1.0 发布结果（2026-08-18）**：Release workflow [run 32110227419](https://github.com/kurisu994/tiny-sql/actions/runs/32110227419) 全部成功；[GitHub Release](https://github.com/kurisu994/tiny-sql/releases/tag/v0.1.0) 已包含 macOS arm64/x64 `.dmg` 与 `.app.tar.gz(.sig)`、Windows x64 `.exe(.sig)`、Linux x64 `.AppImage(.sig)` 和正式版 `latest.json`。清单中的四个平台 URL 均已核对指向 `v0.1.0` 资产；从 v0.0.3 发现、下载、安装并重启到 v0.1.0 的应用内端到端流程也已实测。

- 平台：macOS Apple Silicon + Intel、Windows x64、Linux x64。
- 数据库：MySQL 5.7 / 8.0 / 8.4。
- 连接：0 跳 / 1 跳 / 3 跳 SSH；v0.1 不支持 GSSAPI / Kerberos。
- 分发：GitHub Release 桌面安装包 + Tauri updater 签名更新包；v0.1 无 Apple Developer 代码签名 / notarization，README 仍提供 macOS 右键打开与 `xattr -cr` 说明。

## 0. 自动更新签名准备

自动更新使用 Tauri updater 的 minisign 签名，不等同于 macOS 代码签名。Release workflow 需要以下 GitHub Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：`pnpm tauri signer generate --write-keys <path> --ci` 生成的私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；当前私钥未设置密码时可留空。

当前 `src-tauri/tauri.conf.json` 已启用 `bundle.createUpdaterArtifacts=true`，所以本地构建也需要提供同一组环境变量，否则 Tauri 无法生成 updater artifact。推荐按 `redis-desktop-client` 的方式写入本地 `.env`，再通过 `just build` 构建；`justfile` 会自动加载 `.env`。

直接运行 `pnpm tauri build` 不会由 `justfile` 注入 `.env`，需要先手动 export 变量。本轮生成的本地 updater 私钥没有设置密码；本地验证时仍需显式传或在 `.env` 中保留 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`，避免 Tauri 退回交互式密码读取。

## 1. RC 前本地检查

在打 `v0.1.0-rc1` 前必须完成：

```bash
git status -sb
just check
just test-integration
just build
```

验收：

- `just check` 通过：Rust fmt/clippy/test、Vitest、Next build 全绿。
- `just test-integration` 在本地 MySQL 环境通过，不把 `.env` 或连接串写入日志。
- `just build` 从 `.env` 读取 updater 签名变量后至少产出本机平台安装包、updater artifact 与 `.sig`。
- `CHANGELOG.md` 的 `[Unreleased]` 段覆盖本次用户可见变更。

## 2. RC 发布

`just release` 会修改版本、提交、push、打 tag 并触发 GitHub Release。版本提交只包含 `package.json`、`Cargo.lock`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和必要的 `CHANGELOG.md` 时，`ci.yml` 会跳过该分支 push，随后由 tag push 触发 `release.yml` 打包。执行前确认工作区只包含发布相关改动。

```bash
just release v0.1.0-rc1
```

GitHub Actions 期望产物：

- Apple Silicon `.dmg` / `.app.tar.gz`：`macos-15` runner 构建。
- Intel `.dmg` / `.app.tar.gz`：`macos-15-intel` runner 构建。
- Windows x64 `.exe`：`windows-latest` runner 构建。
- Linux x64 `.AppImage`：`ubuntu-22.04` runner 构建；updater 使用 `.AppImage.sig` 签名，不生成额外 `.AppImage.tar.gz`。
- 每个平台同时上传安装包、updater artifact 与 `.sig`。
- `Publish GitHub Release` job 等全平台 artifact 都上传后再创建 GitHub Release。
- GitHub Release notes 从 `CHANGELOG.md` 提取：正式版优先取对应版本段，RC 若没有独立版本段则取 `[Unreleased]`；RC tag 会标记为 prerelease，且不设为 latest。
- RC 不生成 `latest.json`，不会成为应用内自动更新源。

RC 下载后至少验证：

- macOS：全新机器上通过 Finder 右键打开；如果提示“已损坏，无法打开”，执行 `xattr -cr /Applications/tiny-sql.app` 后能打开。
- Windows / Linux：下载对应 `.exe` / `.AppImage` 后能启动到主界面。
- 应用启动后无空白页、无 Tauri IPC 报错弹窗。

## 3. Dogfooding 验收

真实试用记录写到 `docs/dogfooding-log.md`，不要提交。

### 作者自测

- 真实 3 跳 SSH + MySQL 连接成功，database / table 树能列出（列清单 UI 留 v0.2）。
- TOFU 首次弹窗、已信任静默、指纹变更硬拒绝。
- passphrase 同一会话内缓存，退出应用后重新要求输入。
- 应用稳定运行 >= 30 分钟。
- 至少执行 10 条 SQL，覆盖 SELECT / JOIN / 聚合 / 大表无 LIMIT 截断提示。
- `SELECT SLEEP(60)` 执行中取消，UI 1s 内停止等待，`SHOW PROCESSLIST` 中 query 消失。
- 故意断中间跳，180s 内对应 hop 变 `lost`。

### 同事试用

- 至少 2 位同事各试用 1 周，每人至少 5 条反馈。
- 至少 1 位同事使用 MySQL 5.7，完成连接与 SELECT 验证。
- 1 周内 0 数据丢失、0 不可恢复 crash。

同事邀请模板：

```text
tiny-sql v0.1.0-rc1 试用：
1. 下载自己系统对应的安装包；macOS 使用 .dmg 后在 Finder 里右键打开 tiny-sql.app。
2. 配一个你平时会用的 MySQL 连接，优先选择 3 跳 SSH 环境。
3. 请至少试：连接、TOFU、表浏览、SELECT/JOIN/聚合、SELECT SLEEP(60) 取消。
4. 不要发真实 host/IP/库名/表名；反馈时用 hop-a / mysql-5.7 这类匿名写法。
5. 发现 crash、数据错误、连接失败优先反馈，UI 别扭和缺功能可以放后面。
```

## 4. 正式发布

只有以下条件全部满足时才发 `v0.1.0`：

- CP-3：MySQL 5.7 验证通过。
- CP-4：真实 GUI dogfooding 准入通过。
- CP-6：作者 + 2 同事试用 1 周，0 数据丢失，0 不可恢复 crash。
- README 已包含右键打开说明；发布不要求额外录制 GIF。
- `CHANGELOG.md` 已从 `[Unreleased]` 切出 `0.1.0`。
- GitHub Secrets 已配置 updater 私钥。
- GitHub Release 中有 macOS Apple Silicon / Intel 两个 `.dmg`，Windows x64 `.exe`，Linux x64 `.AppImage`，并有对应 updater artifact / `.sig`。
- GitHub Release 中有 `latest.json`，且 `platforms.darwin-aarch64` / `platforms.darwin-x86_64` / `platforms.windows-x86_64` / `platforms.linux-x86_64` 的 URL 指向当前 tag 资产。

正式发布命令：

```bash
just release v0.1.0
```

发布后检查：

- GitHub Release 页面能下载 macOS `.dmg`、Windows `.exe`、Linux `.AppImage`。
- GitHub Release 页面能下载 `latest.json`；已从 v0.0.3 通过应用菜单手动发现、下载、安装并重启到 v0.1.0。
- Release notes 与 `CHANGELOG.md` 的 `0.1.0` 版本段一致。
- 下载产物能在至少一台干净 Mac、Windows 或 Linux 机器上打开并连接测试库。
- README 的下载链接、右键打开说明与当前 Release 一致。

## 5. 延期规则

- P0/P1 bug 未修完：不发正式版，进入 Week 6 缓冲。
- MySQL 5.7 不通过：不发正式版，先修兼容或明确 v0.1 降级范围。
- 只有 P2 反馈：记录到 v0.1.1 / v0.2，不阻塞发布。
