# v0.1 发布检查清单

> 本文件用于 Week 5 dogfooding、RC 和正式发布。不要在这里记录真实 host、用户名、库名、表名、IP 或公司环境细节；真实记录写到被忽略的 `docs/dogfooding-log.md`。

## 当前发布范围

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
- README 已包含右键打开说明；真实 GIF 若尚未录制，必须明确延期并不在发布文案里承诺。
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
- GitHub Release 页面能下载 `latest.json`，应用内手动检查更新能发现正式版（从旧版本验证）。
- Release notes 与 `CHANGELOG.md` 的 `0.1.0` 版本段一致。
- 下载产物能在至少一台干净 Mac、Windows 或 Linux 机器上打开并连接测试库。
- README 的下载链接、右键打开说明与当前 Release 一致。

## 5. 延期规则

- P0/P1 bug 未修完：不发正式版，进入 Week 6 缓冲。
- MySQL 5.7 不通过：不发正式版，先修兼容或明确 v0.1 降级范围。
- 只有 P2 反馈：记录到 v0.1.1 / v0.2，不阻塞发布。
