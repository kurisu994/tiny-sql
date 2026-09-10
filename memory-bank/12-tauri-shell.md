---
name: 12-tauri-shell
description: Tauri 组装层 —— command 契约、AppState 生命周期、加密 store 与 TOFU 信任库
paths:
  - "src-tauri/src/**"
  - "src-tauri/capabilities/**"
---

# Tauri 组装层（12-tauri-shell）

> 改 `src-tauri/**` 前读这份。这一层负责「把 ssh-multihop 和 db-driver 拼起来 + IPC + 持久化」。

## 文件职责

- `src/lib.rs` · `main.rs`：setup 装配 store / known_hosts + 注册 command；
- `src/state.rs`：`AppState`（pool / 隧道注册表 / passphrase 缓存）、`ActiveDriver` 注册表 + security / history 注入；
- `src/security.rs`：主密码状态机、v1↔v2 迁移回滚、secrets map（FR-102）；
- `src/tofu.rs`：`SshTofuManager`；
- `src/commands/`：`connection` / `query` / `copy` / `privilege` / `backup` / `share` / `dump` / `export` / `import` / `transaction` / `sql_file` / `history` / `security` / `ssh_tofu`；
- `src/config/`：`encryption` · `store` · `history` · `recent_files` · `ssh_known_hosts`。

## 连接生命周期

- `OpenConnection` 同时持有 `driver: ActiveDriver` 和 `tunnel: Option<SshTunnel>`；关闭时**先 pool 后 tunnel**（反过来 listener 先关会让 pool 刷 EOF 错误）。
- 同一 `connection_id` 的 open / close / reconnect 与 query 注册必须共用生命周期锁；不同连接使用独立锁。
- 重连前按 `connection_id` 取消查询并先关 pool 后关 tunnel；每次打开生成 `session_id`，旧 `query_id` 结果和旧 session 事件**不得写回**。
- SQLite 不需要隧道：`connection.rs` 在「建隧道」与「session 级 database_override」两处按 `DriverKind::is_file_based()` 短路。

## 对外错误契约（公开 API）

- 查询 / dump / 备份 / 分享等 command 对外错误用 `{ key, line?, editIndex? }`，**只允许稳定 i18n key 与安全序号**，禁止把 sqlx / 数据库原文或 SQL 片段放入 IPC。
- `DriverError` 的 `Display` 只输出稳定 i18n key；sqlx 原始错误只保留在后端结构化字段，Tauri command 不得返回 `to_string()` 原文。
- 前端只接收稳定 key 与可选正整数行号（R-query-error-contract 已关闭）。
- i18n key 是公开契约，**只能加不能改名**（如 `error.ssh.*` / `error.driver.*` / `error.privilege.unsupported`）。

## 持久化与加密

| 项 | 值 |
|---|---|
| 加密 store 路径 | `~/Library/Application Support/tiny-sql/{connections.enc, master.key, security.json, secrets.enc, history.enc}`（AES-GCM / Argon2id，整体加密） |
| known_hosts 路径 | `~/Library/Application Support/tiny-sql/known_hosts.json`（明文，自有库，**不碰** `~/.ssh`，NFR-012） |
| 连接 driver 持久化值 | `mysql` / `postgresql` / `sqlite`；旧记录缺字段默认 `mysql`，兼容读取**不主动重写密文** |
| SQLite 字段映射 | 复用 `database` 字段存 `.db` 路径，`host` / `port` / `user` / `password` / `ssh` / `ssl` 均不参与 |
| 连接只读 / 环境 | `readOnly` 缺省 `false`；`env` 为 `none` / `prod` / `staging` / `dev`（FR-270 / FR-271） |
| 排序 | `StoredConnection.sort_order: Option<i64>`；`None` 排在其后并回落到最近使用倒序 |

规则：

- 连接配置（含 SSH password）AES-GCM 加密落盘，明文 grep 必须 0 命中。
- passphrase 未启用主密码时仅会话内存（`zeroize` / Zeroizing 包装）；启用主密码并解锁后可加密持久化至 `secrets.enc`。
- `connection_test` 的 passphrase 是独立瞬时参数，只用于本次 SSH 私钥握手；**不得**写入 `ConnectionInput`、持久化配置或正式连接的会话缓存。
- 旧密文缺字段时只做内存默认迁移，不在启动读取时重写文件，**显式保存才升级格式**；迁移失败必须保持原密文不变。

## TOFU 信任库

- 未知 host 首次连接 → 弹 TOFU 对话框显示 SHA256 指纹 → 指纹写入自有 `known_hosts.json`。
- 指纹变更**硬拒绝**，UI 不提供「忽略」按钮。
- 事件 `ssh:tofu-request`；决策命令 `ssh_tofu_decision`。

## command 清单（src-tauri 实际，56 个）

- **连接**：`connection_create/list/update/delete`、`connection_test(input, passphrase?)`、`connection_open(id, passphrase?, remember_passphrase?)`、`connection_reconnect(id, expected_session_id?, passphrase?, database_override?)`、`connection_close(id, expected_session_id?)`、`connection_reorder(ids)`（拖拽排序，`StoredConnection.sort_order` 落盘）。
- **分享**：`connection_share_export/preview/import`。
- **元数据与查询**：`db_list_databases/schemas/tables/columns/indexes/constraints`、`db_create_database`、`db_query`、`db_query_cancel`、`db_query_many`、`db_browse_table`、`db_apply_table_edits`、`db_schema_overview`（表/列/索引/约束全库批量拉取：MySQL 4 条 information_schema / PG 3 条 pg_catalog，SQLite 逐表但收敛成 1 次 IPC）。
- **导入导出与备份**：`csv_import_preview`、`db_import_csv`、`db_export_dump`、`db_import_dump`、`backup_probe_tools`、`db_backup_export`、`db_backup_restore`、`db_export_query`。
- **拷贝与权限**：`db_copy_preview`、`db_copy_table_rows`、`db_list_accounts`、`db_show_grants`。
- **事务 / SQL 文件 / 安全 / 历史 / TOFU**：`transaction_*`（5）、`sql_file_*`（5）、`security_*`（6）、`history_list/clear`、`ssh_tofu_decision`。

**事件**：`ssh:tofu-request`、`ssh:hop-status`、`ssh:hop-rtt`、`db:rtt`、`backup:progress`、`copy:progress`、`app:check-update`、`app:open-settings`。

> 增删 command 时同步更新本清单、`docs/ARCHITECTURE.md` 的命令表与 README。

## 依赖事实

`tauri` 2、`tauri-plugin-log` 2、`tauri-plugin-updater` 2、`tauri-plugin-process` 2、`tauri-plugin-dialog` 2.7、`serde_json` 1、`aes-gcm` 0.10 + `base64` 0.22、`argon2` 0.5.3、`zeroize` =1.8.1（精确约束保持 MSRV 1.77.2）、`rust_xlsxwriter` 0.83（constant_memory 流式 Excel 导出）、`uuid` 1、`chrono` 0.4、`tauri-build` 2（build-dep）。

`AppState` 注册表实际用 `std` / `tokio` 的 `Mutex<HashMap>` 而非 `dashmap`（够用、少依赖）。

## 负向约束（❌ 不要做）

- ❌ **不在 command 层返回 Rust 错误原文** —— 见上方错误契约。
- ❌ **不让 `connection_test` 的 passphrase 落盘**。
- ❌ **不用 `dashmap` 之类的额外依赖**（除非确有并发瓶颈）。
- ❌ **不把 SSH / driver 的领域规则写在这一层** —— 这一层只做组装与 IPC 契约。

相关：[[10-ssh-multihop]] · [[11-db-driver]] · [[13-toolchain]] · [[20-frontend]]
