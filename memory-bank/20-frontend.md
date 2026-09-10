---
name: 20-frontend
description: Next.js 前端约定 —— 状态管理、CodeMirror 方言、缓存与生命周期、shadcn/ui 与主题
paths:
  - "src/**"
---

# 前端（20-frontend）

> 改 `src/**` 前读这份。技术栈见 [[13-toolchain]]，IPC 契约见 [[12-tauri-shell]]。

## 基本形态

- Next.js App Router + 静态导出到 `out/`，组件一律 `"use client"`。
- 调后端用 `invoke<T>()`（`src/lib/tauri-api.ts`），事件用 `listen(event)`。
- 状态用 zustand（`src/stores/`：`connection-store` / `session-store` / `security-store`，以及命令式全局 `confirm-store`）。
- 结果表格用 `react-virtuoso` 虚拟滚动；拓扑图 / 链路图用**纯 CSS 静态布局 + 画布式平移缩放**（不引 `@xyflow/react`）。

## 错误展示

- i18n key → 中文映射（当前用静态 `ERROR_ZH` map，完整 i18next runtime 留到做英文 UI 时接入）。
- **禁止**把后端原始错误直接显示给用户。

## 缓存与生命周期（最容易踩的坑）

- schema metadata cache 只能是**进程内 LRU**，key 必须包含 connection / driver / database / schema / resource / table 完整边界；重连、建库、成功 DDL 和手动刷新必须失效，**异步旧响应不得覆盖当前命名空间**。
- metadata 异步返回除核对 connection / database / schema / table 外，**必须核对单调 request epoch**；仅比较当前名称无法防住 A→B→A 的 ABA 覆盖。
- 同一 `connection_id` 的 open / close / reconnect 与 query 注册必须共用生命周期锁；不同连接使用独立锁。
- 每次打开生成 `session_id`，旧 `query_id` 结果和旧 session 事件不得写回。

## CodeMirror

- 必须按连接 driver 使用 MySQL / PostgreSQL / SQLite 方言。
- column / alias 复用原生 schema completion；JOIN 候选只基于**已加载实际列的保守命名启发式**，**不得伪造 FOREIGN KEY 关系**（数据库不定义 FOREIGN KEY）。

## UI 组件与主题

- 组件库用 **shadcn/ui**（radix base，组件源码落 `src/components/ui/`，用 `cn()` 合并 className）：新建 / 编辑表单用 `Dialog`、右键菜单用 `ContextMenu`、二次确认用 `AlertDialog`。
- 确认统一走全局命令式 `confirm-store`（`await confirm({...})`）替代 `window.confirm`。
- 多视图布局：工作台顶部一栏放「浏览 / 关系图 / 对比 / 权限」+ 竖分隔线 + 对象树操作（新建表 / 复制表 / 导入 SQL / 官方备份 / 刷新），对象树操作**只在 `workspace === "browse"` 时渲染**（这些操作作用于左侧树，别的视图有自己的工具栏）。

## 拖拽排序（`src/hooks/use-drag-sort.ts`）

- 用 pointer 事件 + `data-drag-id` 读 rect 算插入位，指示线由调用方画。
- **故意不用 HTML5 draggable**：Tauri 窗口默认接管文件拖放，WebView 里 `dragstart` / `drop` 不可靠。
- 位移超 4px 才算拖拽（不抢单击选中 / 双击连接），只接左键（右键留给上下文菜单），拖完吞掉补发的那次 click，指针贴容器上下边缘 28px 时 rAF 自动滚动。
- store 的 `reorder` 做乐观更新：本地先落位避免松手回弹，后端失败回滚并报错。

## 应用偏好（localStorage）

键 `tiny-sql:settings`，纯 UI 偏好：`autoCheckUpdate` / `updateProxy` / `confirmWrite` / `defaultPageSize` / `editorFontSize` / `theme`；损坏或越界**逐字段**回落默认。`theme` 为 `system` / `light` / `dark`，默认 `system`。偏好不随连接配置分享。

- 暗色通过 `<html class="dark">` + `@custom-variant dark` 生效；启动脚本读 `tiny-sql:settings` 避免闪浅色。
- 更新代理点 ✓ 时才校验并保存，非法地址标红不保存；支持 `http` / `https` / `socks4` / `socks4a` / `socks5` / `socks5h`，留空直连。

## 其他前端约定

- 列宽拖拽与 localStorage 持久化在 `src/lib/column-widths.ts` + `src/hooks/use-column-widths.ts`。
- 前端单测用 vitest（`just test-web` / `just check` 会跑）。
- `formatMs` 对 <10ms 保留一位小数，否则内网库的延迟会统统显示 0 ms。

## 负向约束（❌ 不要做）

- ❌ **不再依赖 `prefers-color-scheme` 媒体查询切暗色** —— 已迁到 `<html class="dark">` + `@custom-variant dark`，CSS 变量从媒体查询迁到 `.dark`。
- ❌ **不绕过 `confirm-store` 用 `window.confirm`**。
- ❌ **不在前端重写后端已定的 SQL 分类 / 只读规则** —— 前后端同一套白名单，前端只是 UI 侧护栏。
- ❌ **不让异步 metadata 响应覆盖当前命名空间** —— 见上方 epoch 规则。
- ❌ **不显示原始错误** —— 必须走 i18n key。

相关：[[12-tauri-shell]] · [[13-toolchain]] · [[11-db-driver]]
