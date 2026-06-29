# v0.1 发布检查清单

> 本文件用于 Week 5 dogfooding、RC 和正式发布。不要在这里记录真实 host、用户名、库名、表名、IP 或公司环境细节；真实记录写到被忽略的 `docs/dogfooding-log.md`。

## 当前发布范围

- 平台：macOS Apple Silicon + Intel。
- 数据库：MySQL 5.7 / 8.0 / 8.4。
- 连接：0 跳 / 1 跳 / 3 跳 SSH；v0.1 不支持 GSSAPI / Kerberos。
- 分发：GitHub Release `.dmg`，v0.1 不签名，README 提供右键打开与 `xattr -cr` 说明。

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
- `just build` 产出 `target/release/bundle/dmg/tiny-sql_0.1.0_aarch64.dmg`。
- `CHANGELOG.md` 的 `[Unreleased]` 段覆盖本次用户可见变更。

## 2. RC 发布

`just release` 会修改版本、提交、push、打 tag 并触发 GitHub Release。执行前确认工作区只包含发布相关改动。

```bash
just release v0.1.0-rc1
```

GitHub Actions 期望产物：

- Apple Silicon `.dmg`：`macos-15` runner 构建。
- Intel `.dmg`：`macos-15-intel` runner 构建。
- `Publish GitHub Release` job 等两个 `.dmg` artifact 都上传后再创建 GitHub Release。

RC 下载后至少验证：

- 全新 macOS 上通过 Finder 右键打开。
- 如果提示“已损坏，无法打开”，执行 `xattr -cr /Applications/tiny-sql.app` 后能打开。
- 应用启动后无空白页、无 Tauri IPC 报错弹窗。

## 3. Dogfooding 验收

真实试用记录写到 `docs/dogfooding-log.md`，不要提交。

### 作者自测

- 真实 3 跳 SSH + MySQL 连接成功，database/table/columns 能列出。
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
1. 下载 .dmg 后在 Finder 里右键打开 tiny-sql.app。
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
- README 已包含右键打开说明；真实 GIF 若尚未录制，必须明确延期并不在发布文案里承诺。
- `CHANGELOG.md` 已从 `[Unreleased]` 切出 `0.1.0`。
- GitHub Release 中有 Apple Silicon 与 Intel 两个 `.dmg`。

正式发布命令：

```bash
just release v0.1.0
```

发布后检查：

- GitHub Release 页面能下载两个 `.dmg`。
- 下载产物能在一台干净 Mac 上打开并连接测试库。
- README 的下载链接、右键打开说明与当前 Release 一致。

## 5. 延期规则

- P0/P1 bug 未修完：不发正式版，进入 Week 6 缓冲。
- MySQL 5.7 不通过：不发正式版，先修兼容或明确 v0.1 降级范围。
- 只有 P2 反馈：记录到 v0.1.1 / v0.2，不阻塞发布。
