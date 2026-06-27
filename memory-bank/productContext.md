# 产品语境（productContext）

> 给需要理解业务逻辑的开发者：核心用户流、特殊约束、交互规则。

## 核心用户流

### 流 1：高频日常查询（画像 A 主场景）

```
开机 → 30s 内打开 tiny-sql
   │
   ▼
连接列表第一个 = "生产读库 RO"（按最近使用排序）
   │ 双击
   ▼
3 跳隧道自动建立（拓扑图节点依次 pending → connected 变绿）
   │
   ▼
左侧树列出所有 schema → 点 orders → 点 t_order 表
   │
   ▼
右侧「数据」标签显示前 1000 行（虚拟滚动）
   预期全流程 ≤ 15s
```

### 流 2：故障排查（画像 A 的差异化卖点）

```
线上告警 → 点开 "生产读库 RO"
   │
   ▼
第 2 跳堡垒机网络抖动连不上
   │
   ▼
拓扑图 hop[1] 节点变红 + tooltip "connection timeout"
hop[0] 仍绿 → 立刻判定是堡垒机问题
   （DBeaver 只会报 "connection refused"，无法定位第几跳）
```

### 流 3：执行修复 SQL（写操作二次确认）

```
粘贴 UPDATE t_order SET ... WHERE id IN (...) → 点执行
   │
   ▼
正则命中写操作 → 弹 "检测到写操作，确认执行？"
   │ 二次确认
   ▼
执行成功，显示影响行数
```

### 流 4：首次连接 TOFU（画像 B 上手 5 分钟）

```
新建连接 → 填 3 跳 SSH + MySQL 信息 → 测试连接
   │
   ▼
首跳未知 host → 弹 TOFU 对话框（显示 SHA256 指纹）
   │ 信任并继续
   ▼
指纹写入自有 known_hosts.json（不污染 ~/.ssh）
   │
   ▼
后续连接静默通过；指纹被改 → 硬拒绝（MITM 警告）
```

## 特殊约束

| 约束 | 内容 | 理由 |
|---|---|---|
| 多级跳板 | 生产环境 4 层堡垒是常态（办公网 → VPC → DB 跳板 → MySQL） | 这是产品存在的根本动机 |
| MySQL 版本 | 必须同时支持 5.7（`mysql_native_password`）和 8.0（`caching_sha2_password`） | 5.7 EOL 但国内仍大量在用 |
| passphrase | 私钥 passphrase 仅会话内存，进程退出即丢，v0.1 不持久化 | 安全；v0.2 用主密码加密存储 |
| 小库假设 | v0.1 ≤ 30 schema、≤ 200 表/schema，不做搜索/分页/cache | 控制 v0.1 复杂度 |
| 不签名 | v0.1 无苹果开发者证书，README 教 `xattr -cr` | 避免 $99/年阻塞首发 |

## 交互逻辑（具体规则）

- **结果集防 OOM 三道闸**：拒多语句 + 子查询包装 `SELECT * FROM (<sql>) AS tiny_sql_limited LIMIT 1000` + 客户端 `take(100000)` 硬上限。
- **SQL 取消**：`tokio::select!` + cancel token 中止客户端等待，**同时**从独立 control connection 发 `KILL QUERY` 中止远端，不留服务端幽灵查询。
- **隧道断开感知**：每跳 keepalive 60s 一次，**连续 3 次失败（≈180s）才判定断开**（防弱网/bastion ratelimit 误报）。
- **错误归因**：每个 `SshTunnelError` 变体带 `hop_index`，从后端原样透传到前端拓扑节点。
- **错误展示**：所有用户可见错误用稳定 i18n key（`error.ssh.*` / `error.driver.*`）翻译成中文，禁止显示原始 Rust 错误。

## 数据安全约束

- 连接配置（含 SSH password）AES-GCM 加密落盘到 `~/Library/Application Support/tiny-sql/connections.enc`，明文 grep 必须 0 命中。
- known_hosts 写自有 store，**不读不写** `~/.ssh/known_hosts`。
- host key 变更**硬拒绝**，UI 不提供「忽略」按钮。

详见 [REQUIREMENTS.md](../docs/REQUIREMENTS.md) 与 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)。相关：[[systemPatterns]] · [[techContext]]
