# tiny-sql dogfooding 日志模板

> 复制本模板到 `docs/dogfooding-log.md` 后填写。该实际日志文件已被 `.gitignore` 忽略，不应提交到公开仓库。

## 填写规则

- 不记录真实生产 host、用户名、库名、表名、公网 IP、内网 IP、公司名或截图中的敏感信息。
- 拓扑用匿名标签，例如 `hop-a -> hop-b -> hop-c -> mysql-8.0`。
- SQL 用脱敏样例，必要时只写类型：`SELECT + JOIN`、`SELECT SLEEP(60)`、`聚合查询`。
- P0/P1 bug 先记录复现步骤，再修；P2 可移到 v0.1.1 / v0.2 backlog。

## 环境信息

| 字段 | 内容 |
|---|---|
| 日期 | YYYY-MM-DD |
| tester | 作者 / 同事 A / 同事 B |
| 应用版本 | 0.1.0 / commit short sha |
| 安装方式 | 本地安装包 / GitHub Release 安装包 / `just dev` |
| 操作系统 | macOS 版本 + Apple Silicon / Intel；Windows x64；Linux x64 |
| MySQL | 5.7 / 8.0 / 8.4 |
| SSH 拓扑 | 0 跳 / 1 跳 / 3 跳（只写匿名标签） |
| 认证方式 | SSH password / private key / private key + passphrase |

## 验收记录

| 检查项 | 结果 | 备注 |
|---|---|---|
| 应用启动并稳定运行 30 分钟 | 待测 |  |
| 连接配置新建 / 编辑 / 删除 / 重启后仍在 | 待测 |  |
| 真实 3 跳 SSH + MySQL 连接成功 | 待测 |  |
| TOFU 首次弹窗 / 已信任静默 / 指纹变更硬拒绝 | 待测 |  |
| passphrase 同会话缓存，重启后重新输入 | 待测 |  |
| database / table / columns 浏览 | 待测 |  |
| 表浏览前 1000 行 | 待测 |  |
| SQL SELECT / JOIN / 聚合 | 待测 |  |
| 大表无 LIMIT 截断到 10 万行 | 待测 |  |
| `SELECT SLEEP(60)` 取消后 1s 内 UI 停止等待 | 待测 |  |
| 取消后 `SHOW PROCESSLIST` 中 query 消失 | 待测 |  |
| 故意断中间跳后 180s 内 hop 变 lost | 待测 |  |
| MySQL 5.7 连接与 SELECT | 待测 |  |
| 0 数据丢失、0 不可恢复 crash | 待测 |  |

## 反馈记录

| 编号 | 严重级别 | 场景 | 复现步骤 | 期望 | 实际 | 处理 |
|---|---|---|---|---|---|---|
| D001 | P0/P1/P2 |  |  |  |  |  |

## 结论

- 是否满足 CP-4 dogfooding 准入：
- 是否满足 CP-3 MySQL 5.7 兼容：
- 是否满足 CP-6 dogfooding 验收：
- 需要进入 v0.1.0 的修复：
- 推迟到 v0.1.1 / v0.2 的事项：
