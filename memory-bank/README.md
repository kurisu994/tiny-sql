# Memory Bank

tiny-sql 的项目长期记忆：约定怎么写代码、当前在做什么、以及为什么当初那么决定。

**新会话开局先读 [`00-project.md`](./00-project.md)**，其余按下面的路径映射表按需查阅。

## 四层结构与写入规则

| 层 | 文件 | 内容 | 频率 | 归属 | 写法 |
|---|---|---|---|---|---|
| 共识层 | `00-project.md`、`1X-*.md` | 项目定位、编码约定、架构约束 | 极低 | 团队 | **改写**，走 PR review；冲突要人工解决 |
| 任务层 | `active/<branch>.md` | 本次做什么、验收标准 | 任务内高频 | 单分支 | 随便改 |
| 个人层 | `journal/<dev>.md` | 会话日志、踩过的坑 | 每分钟 | 个人 | **只追加，禁改历史**；每段结尾留空行 |
| 归档层 | `archive/YYYY-MM/` | 已完成任务的决策记录 | 一次性 | 团队 | 写完不再动 |

三条红线：

1. `journal/` 只能 append，改历史条目会破坏 `merge=union` 的自动合并前提。
2. **不要往仓库里放任何自动生成的汇总表**（「当前活跃任务一览」这类派生数据必冲突且无信息量）。
3. 共识层冲突了**不要 `--ours` 硬合** —— 那说明对约定的理解分叉了，需当面对齐。

`.gitattributes` 只给 `memory-bank/journal/*.md` 配 `merge=union`；共识层刻意不设。

## 路径映射表

> 下表由各文件 frontmatter 实际抽取，不是手写。改了 `paths` 请同步重跑抽取。

| 文件 | 说明 | 覆盖路径 |
|---|---|---|
| `10-ssh-multihop.md` | N 跳 SSH 隧道 —— 链路模型、keepalive/RTT 监控、错误归因与独立 publish 不变量 | `crates/ssh-multihop/**` |
| `11-db-driver.md` | Driver 契约与 MySQL/PostgreSQL/SQLite 三实现 —— 元数据分层、取消机制、SQL guard | `crates/db-driver/**` |
| `12-tauri-shell.md` | Tauri 组装层 —— command 契约、AppState 生命周期、加密 store 与 TOFU 信任库 | `src-tauri/src/**` `src-tauri/capabilities/**` |
| `13-toolchain.md` | 技术栈版本矩阵、just 构建命令、CI 与发布流程（全部从真实配置提取） | `justfile` `Cargo.toml` `package.json` `pnpm-workspace.yaml` `src-tauri/Cargo.toml` `src-tauri/tauri.conf.json` `.github/workflows/**` `.env.example` |
| `20-frontend.md` | Next.js 前端约定 —— 状态管理、CodeMirror 方言、缓存与生命周期、shadcn/ui 与主题 | `src/**` |

`00-project.md` 不带 `paths`（开局必读，不会被自动注入）。

## 自动注入的平台支持

| 平台 | 支持 | 机制 |
|---|---|---|
| Claude Code | ✅ | `.claude/settings.json` 的 `PostToolUse` + `SessionStart`，事后注入不打断操作 |
| Codex | ✅ | 尚未在本仓库安装；需时跑 `install_hook.py --platforms=codex` |
| OpenCode | ✅ | 尚未在本仓库安装；需时跑 `install_hook.py --platforms=opencode` |
| **Pi** | ❌ | 扩展只走 systemPrompt / 会话级注入，工具事件无法回传上下文 |
| Grok / Cursor | ❌ | 无路径触发注入机制 |

⚠️ **hook 文件不入库**：`.gitignore` 把 `.claude/` / `.codex/` 列为「本地 agent 工具（非项目源码）」。所以 hook 只在本机生效，**新克隆仓库的人要自己跑一次**：

```bash
python3 ~/.pi/agent/skills/memory-bank-generation/scripts/install_hook.py . --platforms=claude
```

**在 Pi 里工作时按上面的映射表人工查阅对应规范**，不要指望自动注入。

hook 按 frontmatter 自动发现新规范：新增 `1X-*.md` 只需补 `paths` 并更新本文映射表，**无需改 hook 或 settings**。规范内容变化后 hook 检测到哈希变化会自动重新注入；`/clear` 与 `/compact` 后注入记录重置。

## 体量预算

- 单份规范上限 **9,000 字符**（硬上限 9,400），超出会被截断。
- 单次注入总量 9,500 字符，超出则降级为索引行。
- 超限就**按领域拆分**，不要靠截断兜底。核对用 `wc -m`（字符数，CJK 一字算一个）。

## 常用命令

```bash
# 校验事实零丢失（迁移期用；.legacy/ 删除后无从校验）
python3 ~/.pi/agent/skills/memory-bank-generation/scripts/migrate_legacy.py . --verify

# 重新抽取路径映射表（粘贴回本文）
python3 -c "
import pathlib,re
for md in sorted(pathlib.Path('memory-bank').glob('*.md')):
    t=md.read_text(encoding='utf-8')
    if not t.startswith('---'): continue
    fm=t[3:t.find(chr(10)+'---',3)]
    d=re.search(r'^description:\s*(.+)\$',fm,re.M)
    p=re.findall(r'^\s*-\s*[\"\']?([^\"\'\n]+)[\"\']?\s*\$',fm,re.M)
    if p: print(f\"| \`{md.name}\` | {d.group(1) if d else ''} | {' '.join('\`'+x+'\`' for x in p)} |\")
"
```
