"use client";

import { useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HistoryPanel } from "@/components/history-panel";
import { BackupDialog } from "@/components/backup-dialog";
import { CompareView } from "@/components/compare-view";
import { ErView } from "@/components/er-view";
import { PrivilegeView } from "@/components/privilege-view";
import { CloneTableDialog } from "@/components/clone-table-dialog";
import { CreateTableDialog } from "@/components/create-table-dialog";
import { BrowseView } from "@/components/browse-view";
import { SqlCodeEditor } from "@/components/sql-code-editor";
import { TopologyGraph } from "@/components/topology-graph";
import { useColumnWidths } from "@/hooks/use-column-widths";
import {
  connectionEnv,
  connectionSafetyLine,
  envLabel,
  envTextClass,
  isReadOnly,
} from "@/lib/connection-meta";
import { formatCellDisplay } from "@/lib/cell-inspect";
import { buildExplainTree, explainSql, type ExplainNode } from "@/lib/explain";
import { parseForeignKey } from "@/lib/schema-er";
import { needsWriteConfirmation } from "@/lib/sql-guard";
import {
  dbApi,
  exportApi,
  sqlFileApi,
  translateError,
  type ColumnMeta,
  type ConstraintMeta,
  type ExportFormat,
  type IndexMeta,
  type RecentFileEntry,
  type RowSet,
  type StoredConnection,
  type TableMeta,
} from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  isTabDirty,
  selectActiveTab,
  useSessionStore,
  type QueryTab,
} from "@/stores/session-store";

/**
 * 已连接后的 schema 浏览：左侧 database/table 树，右侧多 tab 查询工作台。
 *
 * 每个 tab 独立保存 SQL、结果集、query_id 与取消状态（FR-109）；
 * 结果表格用 react-virtuoso 虚拟滚动，列宽可拖拽并持久化（FR-111）。
 */
export function SchemaBrowser({ connection }: { connection: StoredConnection }) {
  const {
    status,
    databases,
    expandedDb,
    selectedDb,
    schemas,
    expandedSchema,
    selectedSchema,
    tables,
    expandedTable,
    tableColumns,
    columnsByTable,
    indexesByTable,
    constraintsByTable,
    loadingColumns,
    refreshingMetadata,
    loadingData,
    tabs,
    activeTabId,
    hopStatuses,
    databaseRtt,
    lostHops,
    errorMsg,
    pendingDbSwitch,
    selectDb,
    toggleExpandedDb,
    selectSchema,
    toggleExpandedSchema,
    toggleTableColumns,
    refreshMetadata,
    switchDatabase,
    selectTable,
    newTab,
    closeTab,
    setActiveTab,
    setSqlText,
    executeSql,
    cancelQuery,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    openSqlFileFromPath,
    saveTabToFile,
    reconnect,
    close,
  } = useSessionStore();
  const confirm = useConfirmStore((s) => s.confirm);
  const confirmWrite = useSettingsStore((s) => s.confirmWrite);
  const activeTab = selectActiveTab({ tabs, activeTabId });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [objectQuery, setObjectQuery] = useState("");
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [formatting, setFormatting] = useState(false);
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [importingDump, setImportingDump] = useState(false);
  const [dumpMsg, setDumpMsg] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<"browse" | "compare" | "er" | "privilege">("browse");
  const [explainTree, setExplainTree] = useState<ExplainNode[] | null>(null);
  const [explainTruncated, setExplainTruncated] = useState(false);

  /** 导入 SQL dump（FR-252）：选文件 → 确认（写操作一次性确认）→ 流式执行 */
  async function importDump() {
    if (!selectedDb) return;
    if (isReadOnly(connection)) {
      setDumpMsg("该连接已设为应用只读，已拒绝导入。");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: "导入 SQL dump",
      filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
      multiple: false,
    });
    if (typeof selected !== "string") return;
    const ok = await confirm({
      title: "导入 SQL dump",
      message: `将在 ${connection.driver === "postgresql" ? (selectedSchema ?? "public") : selectedDb} 范围逐条执行文件中的全部语句（含 DROP / CREATE / INSERT 等写操作）：\n\n${selected}\n\n失败即中止并报告语句序号。确定执行吗？`,
      confirmText: "执行",
      danger: true,
    });
    if (!ok) return;
    setDumpMsg(null);
    setImportingDump(true);
    try {
      const result = await dbApi.importDump(
        connection.id,
        selectedDb,
        connection.driver === "postgresql" ? selectedSchema : null,
        selected,
      );
      if (result.failedAt !== null) {
        setDumpMsg(
          `导入中止：第 ${result.failedAt} 条语句失败（已执行 ${result.executed} 条）`,
        );
      } else {
        setDumpMsg(`导入完成：执行 ${result.executed} 条语句`);
      }
      await refreshMetadata();
    } catch (e) {
      setDumpMsg(translateError(e));
    } finally {
      setImportingDump(false);
    }
  }
  /** 打开 SQL 文件对话框（FR-240） */
  async function openFileDialog() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: "打开 SQL 文件",
      filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
      multiple: false,
    });
    if (typeof selected === "string") {
      const ok = await openSqlFileFromPath(selected);
      setFileMsg(ok ? null : "文件不存在或无法读取");
    }
  }

  /** 打开最近文件；失效时从列表移除并提示 */
  async function openRecentFile(path: string) {
    const ok = await openSqlFileFromPath(path);
    if (!ok) {
      setFileMsg("文件不存在或无法读取，已从最近文件移除");
      setRecentFiles(await sqlFileApi.recentList().catch(() => []));
    } else {
      setFileMsg(null);
    }
  }

  /** 保存当前 tab 到 SQL 文件；saveAs 强制另选路径。外部修改冲突时先确认 */
  async function saveSqlTab(tab: QueryTab, saveAs = false) {
    let path = tab.filePath;
    if (saveAs || !path) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const selected = await save({
        title: saveAs ? "另存为" : "保存 SQL 文件",
        defaultPath: `${tab.title.replace(/\.\w+$/, "")}.sql`,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!selected) return;
      path = selected;
    }
    const result = await saveTabToFile(tab.id, path);
    if (result === "conflict") {
      const ok = await confirm({
        title: "覆盖外部修改",
        message: `「${path.split("/").pop()}」已被外部修改，保存将覆盖外部改动。继续？`,
        confirmText: "覆盖保存",
        danger: true,
      });
      if (!ok) return;
      const retry = await saveTabToFile(tab.id, path, { force: true });
      setFileMsg(retry === "saved" ? `已保存 ${path.split("/").pop()}` : "保存失败");
      return;
    }
    setFileMsg(result === "saved" ? `已保存 ${path.split("/").pop()}` : "保存失败");
  }

  // 快捷键：⌘/Ctrl+S 保存当前 tab，⌘/Ctrl+O 打开 SQL 文件（FR-240）
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "s") {
        event.preventDefault();
        const state = useSessionStore.getState();
        const tab = selectActiveTab({
          tabs: state.tabs,
          activeTabId: state.activeTabId,
        });
        if (tab && !tab.browse) {
          void saveSqlTab(tab);
        }
      } else if (event.key === "o") {
        event.preventDefault();
        void openFileDialog();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 展开目标表并清空搜索（对象搜索定位动作，FR-241） */
  function locateTable(table: string) {
    if (expandedTable !== table) {
      void toggleTableColumns(table);
    }
    setObjectQuery("");
  }

  /** 对象搜索结果：在已加载的 database/schema/表/列/索引/约束中即时过滤（FR-241） */
  const objectResults = useMemo(() => {
    const query = objectQuery.trim().toLowerCase();
    if (!query) return [];
    type Result = {
      key: string;
      kind: string;
      name: string;
      detail?: string;
      onPick: () => void;
    };
    const results: Result[] = [];
    const includes = (value: string) => value.toLowerCase().includes(query);
    for (const db of databases) {
      if (includes(db.name)) {
        results.push({
          key: `db:${db.name}`,
          kind: "数据库",
          name: db.name,
          onPick: () => {
            void selectDb(db.name);
            setObjectQuery("");
          },
        });
      }
    }
    for (const schema of schemas) {
      if (includes(schema.name)) {
        results.push({
          key: `schema:${schema.name}`,
          kind: "Schema",
          name: schema.name,
          onPick: () => {
            void selectSchema(schema.name);
            setObjectQuery("");
          },
        });
      }
    }
    for (const table of tables) {
      if (includes(table.name)) {
        results.push({
          key: `table:${table.name}`,
          kind: "表",
          name: table.name,
          detail: table.comment ?? undefined,
          onPick: () => locateTable(table.name),
        });
      }
    }
    for (const [table, cols] of Object.entries(columnsByTable)) {
      for (const col of cols) {
        if (includes(col.name)) {
          results.push({
            key: `col:${table}.${col.name}`,
            kind: "列",
            name: col.name,
            detail: table,
            onPick: () => locateTable(table),
          });
        }
      }
    }
    for (const [table, items] of Object.entries(indexesByTable)) {
      for (const index of items) {
        if (includes(index.name)) {
          results.push({
            key: `idx:${table}.${index.name}`,
            kind: "索引",
            name: index.name,
            detail: table,
            onPick: () => locateTable(table),
          });
        }
      }
    }
    for (const [table, items] of Object.entries(constraintsByTable)) {
      for (const constraint of items) {
        if (includes(constraint.name)) {
          results.push({
            key: `con:${table}.${constraint.name}`,
            kind: "约束",
            name: constraint.name,
            detail: table,
            onPick: () => locateTable(table),
          });
        }
      }
    }
    return results.slice(0, 50);
  }, [
    objectQuery,
    databases,
    schemas,
    tables,
    columnsByTable,
    indexesByTable,
    constraintsByTable,
  ]);

  const sqlNamespaces = useMemo(
    () =>
      connection.driver === "postgresql"
        ? schemas.map((schema) => schema.name)
        : databases.map((database) => database.name),
    [connection.driver, databases, schemas],
  );

  /**
   * 写操作确认：设置里关掉「写操作二次确认」后直接放行。
   * 只读连接拦截与后端 allow_write 护栏不受此设置影响。
   */
  async function confirmWriteOp(
    options: Parameters<typeof confirm>[0],
  ): Promise<boolean> {
    if (!confirmWrite) return true;
    return confirm(options);
  }

  async function runSql() {
    const sql = activeTab?.sqlText.trim() ?? "";
    if (!sql) return;
    let allowWrite = false;
    if (needsWriteConfirmation(sql, connection.driver)) {
      if (readOnly) {
        setDumpMsg("该连接已设为应用只读，已拒绝写操作。");
        return;
      }
      allowWrite = await confirmWriteOp({
        title: "确认写操作",
        message: `${safety}\n检测到写操作，请确认已使用只读账号或明确知道风险。是否继续执行？`,
        confirmText: "继续执行",
        danger: true,
      });
      if (!allowWrite) return;
    }
    setExplainTree(null);
    await executeSql(sql, { rowLimit: 100000, allowWrite });
    // 多语句脚本的写确认回填：前端粗判只看首 token，漏网的写语句由后端
    // 返回 write_requires_confirmation，这里补确认后按确认态重试（FR-243）
    const state = useSessionStore.getState();
    const latest = selectActiveTab({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    });
    if (
      latest?.lastErrorKey === "error.driver.write_requires_confirmation" &&
      !allowWrite
    ) {
      const ok = await confirmWriteOp({
        title: "确认写操作",
        message:
          "脚本中包含写操作，请确认已使用只读账号或明确知道风险。是否继续执行？",
        confirmText: "继续执行",
        danger: true,
      });
      if (ok) {
        await executeSql(sql, { rowLimit: 100000, allowWrite: true });
      }
    }
  }

  async function runExplain(analyze: boolean) {
    const sql = activeTab?.sqlText.trim() ?? "";
    if (!sql) return;
    if (analyze) {
      if (readOnly) {
        setDumpMsg("该连接已设为应用只读，已拒绝 ANALYZE。");
        return;
      }
      const ok = await confirm({
        title: "EXPLAIN ANALYZE",
        message: `${safety}\n会真正执行当前 SQL（含写语句的副作用）。确定继续？`,
        confirmText: "分析",
        danger: true,
      });
      if (!ok) return;
    }
    const wrapped = explainSql(connection.driver, sql, analyze);
    const allowWrite =
      analyze && needsWriteConfirmation(wrapped, connection.driver);
    if (allowWrite) {
      const ok = await confirmWriteOp({
        title: "确认写操作",
        message: "EXPLAIN ANALYZE 将执行被分析的写语句。",
        confirmText: "继续",
        danger: true,
      });
      if (!ok) return;
    }
    await executeSql(wrapped, { rowLimit: 100000, allowWrite });
    const latest = selectActiveTab(useSessionStore.getState());
    if (latest?.rowSet) {
      const tree = buildExplainTree(connection.driver, latest.rowSet);
      setExplainTree(tree.nodes);
      setExplainTruncated(tree.truncated);
    }
  }

  /** 格式化当前 tab 的 SQL（FR-243）：按连接方言，sql-formatter 动态加载；失败保持原文 */
  async function formatSql() {
    if (!activeTab) return;
    const sql = activeTab.sqlText;
    if (!sql.trim()) return;
    setFormatting(true);
    try {
      const { format } = await import("sql-formatter");
      const formatted = format(sql, {
        language:
          connection.driver === "postgresql"
            ? "postgresql"
            : connection.driver === "sqlite"
              ? "sqlite"
              : "mysql",
        tabWidth: 2,
        keywordCase: "upper",
      });
      setSqlText(formatted);
    } catch {
      // 格式化失败（方言边界语法）保持原文，不打断用户
    } finally {
      setFormatting(false);
    }
  }

  /** 关闭 tab：dirty、执行中或有未提交事务时先确认（FR-109 / FR-244 / FR-250） */
  async function closeTabWithConfirm(tab: QueryTab) {
    const txOpen = tab.transaction?.inTransaction ?? false;
    const browseDirty = tab.browse?.editMode && tab.browse.pendingEdits.length > 0;
    if (isTabDirty(tab) || tab.queryRunning || txOpen) {
      const message = tab.queryRunning
        ? `「${tab.title}」正在执行查询，关闭将取消该查询。确定关闭？`
        : txOpen
          ? `「${tab.title}」有未提交的事务，关闭将回滚全部未提交修改。确定关闭？`
          : browseDirty
            ? `「${tab.title}」有 ${tab.browse!.pendingEdits.length} 条未提交表格编辑，关闭后将丢失。确定关闭？`
            : `「${tab.title}」有未执行的修改，关闭后将丢失。确定关闭？`;
      const ok = await confirm({
        title: "关闭查询",
        message,
        confirmText: "关闭",
        danger: true,
      });
      if (!ok) return;
    }
    await closeTab(tab.id);
  }

  /** 导出当前 tab SQL 的结果集（后端重新执行并流式写文件，FR-107） */
  async function exportResult(format: ExportFormat) {
    const openId = useSessionStore.getState().openId;
    if (!activeTab || !openId || exporting) return;
    const sql = activeTab.sqlText.trim();
    if (!sql) return;
    if (needsWriteConfirmation(sql, connection.driver)) {
      setExportMsg("仅支持导出只读查询结果");
      return;
    }
    setExporting(true);
    setExportMsg(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `export.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      const result = await exportApi.query(openId, sql, format, path);
      setExportMsg(
        `已导出 ${result.rows} 行${result.truncated ? "（结果受 10 万行上限截断）" : ""}`,
      );
    } catch (e) {
      setExportMsg(translateError(e));
    } finally {
      setExporting(false);
    }
  }

  const connected = status === "connected";
  const readOnly = isReadOnly(connection);
  const safety = connectionSafetyLine(connection);

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span className="text-sm font-semibold">{connection.name}</span>
        {envLabel(connectionEnv(connection)) && (
          <span className={cn("text-xs font-medium", envTextClass(connectionEnv(connection)))}>
            {envLabel(connectionEnv(connection))}
          </span>
        )}
        {isReadOnly(connection) && (
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
            应用只读
          </span>
        )}
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${
            connected
              ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
              : status === "error"
                ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {connected ? "已连接" : status === "error" ? "连接失败" : "连接中"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => reconnect(connection)}
            disabled={status === "connecting"}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            重连
          </button>
          <button
            onClick={close}
            disabled={status === "connecting"}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            断开
          </button>
        </div>
      </div>

      <TopologyGraph
        connection={connection}
        sessionStatus={status}
        hopStatuses={hopStatuses}
        databaseRtt={databaseRtt}
      />

      {lostHops.length > 0 && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span>
            第 {lostHops.map((h) => h + 1).join("、")} 跳 SSH 隧道已断开，请重连。
          </span>
          <button
            type="button"
            onClick={() => reconnect(connection)}
            className="ml-auto rounded border border-red-300 px-2 py-0.5 font-medium hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
          >
            立即重连
          </button>
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <span>{errorMsg}</span>
          {pendingDbSwitch && (
            <button
              type="button"
              onClick={() => switchDatabase()}
              disabled={status === "connecting"}
              className="ml-auto shrink-0 rounded border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:hover:bg-amber-900"
            >
              切换到 {pendingDbSwitch}
            </button>
          )}
        </div>
      )}

      <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-3 py-1 text-xs dark:border-neutral-800">
        {(
          [
            ["browse", "浏览"],
            ["compare", "对比"],
            ["er", "关系图"],
            ["privilege", "权限"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setWorkspace(id)}
            className={cn(
              "rounded px-2 py-0.5",
              workspace === id
                ? "bg-neutral-200 dark:bg-neutral-800"
                : "hover:bg-neutral-100 dark:hover:bg-neutral-800",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {workspace === "compare" ? (
        <CompareView />
      ) : workspace === "er" ? (
        <ErView />
      ) : workspace === "privilege" ? (
        <PrivilegeView />
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* 左：database / schema / table 树 */}
        <aside className="w-80 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white/95 px-3 py-1.5 text-xs text-neutral-500 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
            <span className="shrink-0">数据库对象</span>
            <div className="flex shrink-0 items-center gap-1">
              {/* 新建表（FR-251）：需已选中 database（MySQL）/ schema（PostgreSQL） */}
              <button
                type="button"
                onClick={() => setCreateTableOpen(true)}
                disabled={
                  readOnly ||
                  !connected ||
                  !selectedDb ||
                  (connection.driver === "postgresql" && !selectedSchema)
                }
                aria-label="新建表"
                title="新建表"
                className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              >
                新建
              </button>
              <button
                type="button"
                onClick={() => setCloneOpen(true)}
                disabled={
                  readOnly ||
                  !connected ||
                  !selectedDb ||
                  !activeTab?.selectedTable ||
                  (connection.driver === "postgresql" && !selectedSchema)
                }
                aria-label="复制为新表"
                title="把当前表复制为同库新表"
                className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              >
                复制
              </button>
              {/* 导入 SQL dump（FR-252）：流式执行整个文件 */}
              <button
                type="button"
                onClick={() => void importDump()}
                disabled={
                  readOnly ||
                  !connected ||
                  !selectedDb ||
                  importingDump ||
                  (connection.driver === "postgresql" && !selectedSchema)
                }
                aria-label="导入 SQL"
                title="导入 SQL dump 文件（流式逐条执行）"
                className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              >
                {importingDump ? "导入中" : "导入"}
              </button>
              <button
                type="button"
                onClick={() => setBackupOpen(true)}
                disabled={!connected || !selectedDb}
                aria-label="官方备份"
                title="官方 mysqldump / pg_dump 备份与恢复（不是 SQL dump）"
                className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              >
                备份
              </button>
              <button
                type="button"
                onClick={refreshMetadata}
                disabled={!connected || refreshingMetadata}
                aria-label="刷新数据库对象"
                title="刷新数据库对象"
                className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
              >
                {refreshingMetadata ? "刷新中" : "刷新"}
              </button>
            </div>
          </div>
          {dumpMsg && (
            <div className="border-b border-neutral-100 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800">
              {dumpMsg}
            </div>
          )}
          {connected && (
            <div className="border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
              <input
                value={objectQuery}
                onChange={(e) => setObjectQuery(e.target.value)}
                placeholder="搜索表 / 列 / 索引 / 约束…"
                aria-label="搜索数据库对象"
                className="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-xs outline-none placeholder:text-neutral-400 focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-blue-500"
              />
              {objectQuery.trim() && (
                <div className="mt-1 max-h-56 overflow-y-auto rounded border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
                  {objectResults.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-neutral-400">
                      无匹配对象（仅搜索已加载范围）
                    </p>
                  ) : (
                    objectResults.map((result) => (
                      <button
                        key={result.key}
                        type="button"
                        onClick={result.onPick}
                        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        <span className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {result.kind}
                        </span>
                        <span className="min-w-0 truncate">{result.name}</span>
                        {result.detail && (
                          <span className="ml-auto shrink-0 truncate text-[10px] text-neutral-400">
                            {result.detail}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          {!connected && (
            <p className="px-3 py-3 text-xs text-neutral-500">
              {status === "error" ? "连接失败，请检查上方断点。" : "正在建立连接…"}
            </p>
          )}
          {connected && databases.map((db) => (
            <div key={db.name}>
              <button
                onClick={() => toggleExpandedDb(db.name)}
                onDoubleClick={() => selectDb(db.name)}
                title={db.name}
                className={`flex w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 ${
                  selectedDb === db.name ? "font-medium" : ""
                }`}
              >
                <DatabaseTreeIcon active={selectedDb === db.name} />
                <span className="min-w-0 truncate">{db.name}</span>
                {connection.driver === "postgresql" && db.isCurrent && (
                  <span className="ml-auto shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                    当前
                  </span>
                )}
              </button>
              {expandedDb === db.name && connection.driver !== "postgresql" && (
                <TableTreeList
                  tables={tables}
                  loading={loadingData}
                  loadingColumns={loadingColumns}
                  expandedTable={expandedTable}
                  columns={tableColumns}
                  indexes={expandedTable ? (indexesByTable[expandedTable] ?? []) : []}
                  constraints={
                    expandedTable ? (constraintsByTable[expandedTable] ?? []) : []
                  }
                  selectedTable={activeTab?.selectedTable ?? null}
                  onToggleColumns={toggleTableColumns}
                  onSelect={selectTable}
                  paddingClass="pl-8"
                  columnPaddingClass="pl-12"
                />
              )}
              {expandedDb === db.name && connection.driver === "postgresql" && (
                <ul className="pb-1">
                  {schemas.length === 0 && (
                    <li className="px-3 py-1 pl-7 text-xs text-neutral-400">
                      {loadingData ? "加载中…" : "（无 Schema）"}
                    </li>
                  )}
                  {schemas.map((schema) => (
                    <li key={schema.name}>
                      <button
                        onClick={() => toggleExpandedSchema(schema.name)}
                        onDoubleClick={() => selectSchema(schema.name)}
                        title={schema.name}
                        className={`flex w-full min-w-0 items-center gap-1.5 px-3 py-1 pl-7 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                          selectedSchema === schema.name ? "font-medium" : ""
                        }`}
                      >
                        <SchemaTreeIcon active={selectedSchema === schema.name} />
                        <span className="min-w-0 truncate">{schema.name}</span>
                        {schema.isDefault && (
                          <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
                            默认
                          </span>
                        )}
                      </button>
                      {expandedSchema === schema.name && (
                        <TableTreeList
                          tables={tables}
                          loading={loadingData}
                          loadingColumns={loadingColumns}
                          expandedTable={expandedTable}
                          columns={tableColumns}
                          indexes={
                            expandedTable
                              ? (indexesByTable[expandedTable] ?? [])
                              : []
                          }
                          constraints={
                            expandedTable
                              ? (constraintsByTable[expandedTable] ?? [])
                              : []
                          }
                          selectedTable={activeTab?.selectedTable ?? null}
                          onToggleColumns={toggleTableColumns}
                          onSelect={selectTable}
                          paddingClass="pl-12"
                          columnPaddingClass="pl-16"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </aside>

        {/* 右：多 tab 查询工作台（FR-109） */}
        <section className="flex min-w-0 flex-1 flex-col">
          {/* 查询 tab 条 */}
          <div className="flex items-center gap-0.5 overflow-x-auto border-b border-neutral-200 px-2 pt-1.5 dark:border-neutral-800">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  "group flex max-w-40 items-center gap-1 rounded-t-md border border-b-0 border-neutral-200 px-2.5 py-1 text-xs dark:border-neutral-700",
                  tab.id === activeTabId
                    ? "bg-white font-medium dark:bg-neutral-900"
                    : "bg-neutral-50 text-neutral-500 hover:bg-neutral-100 dark:bg-neutral-950 dark:hover:bg-neutral-800",
                )}
              >
                <button
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  title={tab.title}
                  className="flex min-w-0 items-center gap-1"
                >
                  {(isTabDirty(tab) || tab.queryRunning) && (
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        tab.queryRunning ? "bg-blue-500" : "bg-amber-500",
                      )}
                      aria-label={tab.queryRunning ? "执行中" : "未执行修改"}
                    />
                  )}
                  {tab.transaction?.inTransaction && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
                      aria-label="事务进行中"
                      title="事务进行中"
                    />
                  )}
                  <span className="truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => closeTabWithConfirm(tab)}
                  aria-label={`关闭 ${tab.title}`}
                  className="shrink-0 rounded p-0.5 text-neutral-300 hover:bg-neutral-200 hover:text-neutral-600 group-hover:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => newTab()}
              disabled={!connected}
              aria-label="新建查询"
              title="新建查询 tab"
              className="mb-0.5 ml-1 shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
            <div className="relative ml-auto shrink-0 pb-0.5 pr-1">
              {fileMsg && (
                <span className="mr-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {fileMsg}
                </span>
              )}
              <button
                type="button"
                onClick={async () => {
                  const opening = !fileMenuOpen;
                  setFileMenuOpen(opening);
                  setHistoryOpen(false);
                  if (opening) {
                    setRecentFiles(await sqlFileApi.recentList().catch(() => []));
                  }
                }}
                className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                文件
              </button>
              {fileMenuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-80 max-w-[80vw] rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                  <button
                    type="button"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void openFileDialog();
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    打开 SQL 文件…
                    <span className="ml-auto text-[10px] text-neutral-400">⌘O</span>
                  </button>
                  <button
                    type="button"
                    disabled={!activeTab || activeTab.browse != null}
                    onClick={() => {
                      setFileMenuOpen(false);
                      if (activeTab) void saveSqlTab(activeTab);
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
                  >
                    保存
                    <span className="ml-auto text-[10px] text-neutral-400">⌘S</span>
                  </button>
                  <button
                    type="button"
                    disabled={!activeTab || activeTab.browse != null}
                    onClick={() => {
                      setFileMenuOpen(false);
                      if (activeTab) void saveSqlTab(activeTab, true);
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
                  >
                    另存为…
                  </button>
                  <div className="mx-3 my-1 border-t border-neutral-100 dark:border-neutral-800" />
                  <p className="px-3 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                    最近文件
                  </p>
                  {recentFiles.length === 0 && (
                    <p className="px-3 py-1 text-xs text-neutral-400">（无）</p>
                  )}
                  {recentFiles.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      title={entry.path}
                      onClick={() => {
                        setFileMenuOpen(false);
                        void openRecentFile(entry.path);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      <span className="shrink-0">
                        {entry.path.split("/").pop()}
                      </span>
                      <span className="min-w-0 truncate text-[10px] text-neutral-400">
                        {entry.path}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                历史
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-[28rem] max-w-[80vw]">
                  <HistoryPanel
                    onPick={(sql) => {
                      setSqlText(sql);
                      setHistoryOpen(false);
                    }}
                    onClose={() => setHistoryOpen(false)}
                  />
                </div>
              )}
            </div>
          </div>

          {!activeTab?.browse && (
            <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
              {activeTab && (
              <SqlCodeEditor
                value={activeTab.sqlText}
                onChange={setSqlText}
                onRun={runSql}
                disabled={!connected || activeTab.queryRunning}
                queryErrorMsg={activeTab.queryErrorMsg}
                driver={connection.driver}
                namespaces={sqlNamespaces}
                selectedNamespace={
                  connection.driver === "postgresql" ? selectedSchema : selectedDb
                }
                tables={tables}
                columnsByTable={columnsByTable}
              />
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={runSql}
                disabled={
                  !connected ||
                  !activeTab ||
                  activeTab.queryRunning ||
                  activeTab.sqlText.trim().length === 0
                }
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                执行
              </button>
              <button
                onClick={cancelQuery}
                disabled={!activeTab?.queryRunning}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              {activeTab?.queryRunning && (
                <span className="text-xs text-neutral-500">执行中…</span>
              )}
              <button
                type="button"
                onClick={formatSql}
                disabled={
                  !connected ||
                  !activeTab ||
                  activeTab.queryRunning ||
                  formatting ||
                  activeTab.sqlText.trim().length === 0
                }
                title="按当前连接方言格式化 SQL"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                {formatting ? "格式化…" : "格式化"}
              </button>
              <button
                type="button"
                onClick={() => void runExplain(false)}
                disabled={
                  !connected ||
                  !activeTab ||
                  activeTab.queryRunning ||
                  activeTab.sqlText.trim().length === 0
                }
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                解释
              </button>
              <button
                type="button"
                onClick={() => void runExplain(true)}
                disabled={
                  isReadOnly(connection) ||
                  !connected ||
                  !activeTab ||
                  activeTab.queryRunning ||
                  activeTab.sqlText.trim().length === 0
                }
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                ANALYZE
              </button>
              {activeTab?.transaction?.inTransaction ? (
                <div className="flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 dark:border-violet-900 dark:bg-violet-950/40">
                  <span className="text-xs font-medium text-violet-700 dark:text-violet-300">
                    事务进行中
                  </span>
                  <button
                    type="button"
                    onClick={commitTransaction}
                    disabled={!connected || activeTab.queryRunning}
                    className="rounded bg-violet-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    提交
                  </button>
                  <button
                    type="button"
                    onClick={rollbackTransaction}
                    disabled={!connected || activeTab.queryRunning}
                    className="rounded border border-violet-300 px-2 py-0.5 text-xs text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-900/50"
                  >
                    回滚
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={beginTransaction}
                  disabled={!connected || !activeTab || activeTab.queryRunning}
                  title="开启事务：本 tab 后续 SQL 固定同一连接执行，提交或回滚后自动结束"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  开始事务
                </button>
              )}
              <div className="ml-auto flex items-center gap-2">
                {exportMsg && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {exportMsg}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => exportResult("csv")}
                  disabled={
                    !connected ||
                    exporting ||
                    !activeTab ||
                    activeTab.queryRunning ||
                    activeTab.sqlText.trim().length === 0 ||
                    !!activeTab.multiResults
                  }
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  导出 CSV
                </button>
                <button
                  type="button"
                  onClick={() => exportResult("xlsx")}
                  disabled={
                    !connected ||
                    exporting ||
                    !activeTab ||
                    activeTab.queryRunning ||
                    activeTab.sqlText.trim().length === 0 ||
                    !!activeTab.multiResults
                  }
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  导出 Excel
                </button>
              </div>
            </div>
            {activeTab?.queryErrorMsg && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-300">
                {activeTab.queryErrorMsg}
              </p>
            )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab?.multiResults ? (
              <MultiResultView tab={activeTab} connectionId={connection.id} />
            ) : activeTab?.browse ? (
              <BrowseView
                key={activeTab.id}
                tab={activeTab}
                connectionId={connection.id}
              />
            ) : (
              <>
                {!activeTab?.rowSet && !activeTab?.loadingData && (
                  <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                    {activeTab?.selectedTable
                      ? "暂无结果"
                      : "选择左侧表，或直接执行 SQL。"}
                  </div>
                )}
                {activeTab?.loadingData && (
                  <p className="p-4 text-sm text-neutral-500">加载中…</p>
                )}
                {explainTree && (
                  <div className="max-h-48 overflow-auto border-b border-neutral-200 p-2 text-xs dark:border-neutral-800">
                    {explainTruncated && (
                      <p className="mb-1 text-amber-600">计划过大，已截断展示</p>
                    )}
                    <ExplainTreeView nodes={explainTree} />
                  </div>
                )}
                {!activeTab?.loadingData && activeTab?.rowSet && (
                  <ResultTable
                    rowSet={activeTab.rowSet}
                    connectionId={connection.id}
                    truncated={activeTab.rowSet.truncated}
                  />
                )}
              </>
            )}
          </div>
          {activeTab?.selectedTable && (
            <div className="border-t border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
              当前表：
              {connection.driver === "postgresql"
                ? `${selectedDb}.${selectedSchema}.${activeTab.selectedTable}`
                : `${selectedDb}.${activeTab.selectedTable}`}
            </div>
          )}
        </section>
      </div>
      )}

      {/* 新建表对话框（FR-251） */}
      {selectedDb && (
        <CreateTableDialog
          open={createTableOpen}
          driver={connection.driver}
          database={selectedDb}
          schema={connection.driver === "postgresql" ? selectedSchema : null}
          onOpenChange={setCreateTableOpen}
        />
      )}
      {selectedDb && activeTab?.selectedTable && (
        <CloneTableDialog
          open={cloneOpen}
          connection={connection}
          database={selectedDb}
          schema={connection.driver === "postgresql" ? selectedSchema : null}
          sourceTable={activeTab.selectedTable}
          onOpenChange={setCloneOpen}
        />
      )}
      {selectedDb && (
        <BackupDialog
          open={backupOpen}
          connectionId={connection.id}
          driver={connection.driver}
          database={selectedDb}
          schema={connection.driver === "postgresql" ? selectedSchema : null}
          table={activeTab?.selectedTable ?? null}
          onOpenChange={setBackupOpen}
        />
      )}
    </div>
  );
}

function TableTreeList({
  tables,
  loading,
  loadingColumns,
  expandedTable,
  columns,
  indexes,
  constraints,
  selectedTable,
  onToggleColumns,
  onSelect,
  paddingClass,
  columnPaddingClass,
}: {
  tables: TableMeta[];
  loading: boolean;
  loadingColumns: boolean;
  expandedTable: string | null;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  constraints: ConstraintMeta[];
  selectedTable: string | null;
  onToggleColumns: (table: string) => Promise<void>;
  onSelect: (table: string) => Promise<void>;
  paddingClass: string;
  columnPaddingClass: string;
}) {
  return (
    <ul className="pb-1">
      {tables.length === 0 && (
        <li className={cn("px-3 py-1 text-xs text-neutral-400", paddingClass)}>
          {loading ? "加载中…" : "（无表）"}
        </li>
      )}
      {tables.map((table) => (
        <li key={table.name}>
          <div
            className={cn(
              "flex w-full min-w-0 items-center gap-1 px-3 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800",
              paddingClass,
              selectedTable === table.name
                ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                : "text-neutral-600 dark:text-neutral-400",
            )}
          >
            <button
              type="button"
              onClick={() => onToggleColumns(table.name)}
              aria-label={`${expandedTable === table.name ? "收起" : "展开"} ${table.name} 的列`}
              className="w-3 shrink-0 text-center text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              {expandedTable === table.name ? "▾" : "▸"}
            </button>
            <button
              type="button"
              onClick={() => onSelect(table.name)}
              title={table.comment ?? undefined}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <TableTreeIcon active={selectedTable === table.name} />
              <span className="min-w-0 truncate">{table.name}</span>
              {table.tableType.toUpperCase().includes("VIEW") && (
                <span className="shrink-0 rounded bg-neutral-200 px-1 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                  VIEW
                </span>
              )}
            </button>
          </div>
          {expandedTable === table.name && (
            <>
              <ColumnTreeList
                columns={columns}
                loading={loadingColumns}
                paddingClass={columnPaddingClass}
              />
              {!loadingColumns && (
                <>
                  <IndexTreeList
                    indexes={indexes}
                    paddingClass={columnPaddingClass}
                  />
                  <ConstraintTreeList
                    constraints={constraints}
                    paddingClass={columnPaddingClass}
                  />
                </>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 表下的索引清单（FR-241）：名称、列与唯一性。 */
function IndexTreeList({
  indexes,
  paddingClass,
}: {
  indexes: IndexMeta[];
  paddingClass: string;
}) {
  if (indexes.length === 0) return null;
  return (
    <div className={cn("px-3 pb-1", paddingClass)}>
      <p className="pt-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        索引
      </p>
      {indexes.map((index) => (
        <p
          key={index.name}
          title={`${index.indexType} (${index.columns.join(", ")})`}
          className="truncate py-0.5 text-xs text-neutral-500 dark:text-neutral-400"
        >
          <span className="text-neutral-700 dark:text-neutral-300">
            {index.name}
          </span>{" "}
          <span className="text-neutral-400">({index.columns.join(", ")})</span>
          {index.unique && (
            <span className="ml-1 rounded bg-blue-50 px-1 text-[10px] text-blue-600 dark:bg-blue-950 dark:text-blue-300">
              {index.indexType === "PRIMARY" ? "主键" : "唯一"}
            </span>
          )}
        </p>
      ))}
    </div>
  );
}

/** 表下的约束清单（FR-241）：类型、列与外键引用。 */
function ConstraintTreeList({
  constraints,
  paddingClass,
}: {
  constraints: ConstraintMeta[];
  paddingClass: string;
}) {
  if (constraints.length === 0) return null;
  return (
    <div className={cn("px-3 pb-1.5", paddingClass)}>
      <p className="pt-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        约束
      </p>
      {constraints.map((constraint) => (
        <p
          key={constraint.name}
          title={constraint.reference ?? undefined}
          className="truncate py-0.5 text-xs text-neutral-500 dark:text-neutral-400"
        >
          <span className="text-neutral-700 dark:text-neutral-300">
            {constraint.name}
          </span>{" "}
          <span className="rounded bg-neutral-100 px-1 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {constraint.constraintType}
          </span>{" "}
          <span className="text-neutral-400">
            ({constraint.columns.join(", ")})
          </span>
          {constraint.constraintType === "FOREIGN KEY" && constraint.reference && (
            <span className="text-neutral-400"> → {constraint.reference}</span>
          )}
        </p>
      ))}
    </div>
  );
}

/** 表下按需展开的列信息，完整展示类型、可空、索引、默认值和注释。 */
function ColumnTreeList({
  columns,
  loading,
  paddingClass,
}: {
  columns: ColumnMeta[];
  loading: boolean;
  paddingClass: string;
}) {
  if (loading) {
    return (
      <p className={cn("px-3 py-1 text-xs text-neutral-400", paddingClass)}>
        加载列…
      </p>
    );
  }
  if (columns.length === 0) {
    return (
      <p className={cn("px-3 py-1 text-xs text-neutral-400", paddingClass)}>
        （无列）
      </p>
    );
  }
  return (
    <ul className="pb-1">
      {columns.map((column) => (
        <li
          key={column.name}
          className={cn(
            "px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400",
            paddingClass,
          )}
        >
          <div className="flex min-w-0 items-center gap-1">
            <ColumnTreeIcon />
            <span className="min-w-0 truncate font-medium text-neutral-700 dark:text-neutral-200">
              {column.name}
            </span>
            {column.columnKey && (
              <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {column.columnKey}
              </span>
            )}
          </div>
          <div className="ml-5 flex flex-wrap gap-x-1.5 text-[10px] leading-4">
            <span title="列类型">{column.dataType}</span>
            <span title="是否允许 NULL">
              {column.nullable ? "NULL" : "NOT NULL"}
            </span>
          </div>
          {column.defaultValue !== null && (
            <p
              className="ml-5 truncate text-[10px] leading-4"
              title={column.defaultValue}
            >
              默认 {column.defaultValue}
            </p>
          )}
          {column.comment && (
            <p
              className="ml-5 line-clamp-2 text-[10px] leading-4"
              title={column.comment}
            >
              {column.comment}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function ColumnTreeIcon() {
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-sm border border-cyan-500/50 bg-cyan-100 shadow-sm dark:bg-cyan-900"
      aria-hidden="true"
    />
  );
}

function SchemaTreeIcon({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "h-3.5 w-3.5 shrink-0 rounded-sm border shadow-sm",
        active
          ? "border-violet-600 bg-violet-500"
          : "border-violet-400/60 bg-violet-200 dark:bg-violet-800",
      )}
      aria-hidden="true"
    />
  );
}

function DatabaseTreeIcon({ active }: { active: boolean }) {
  return (
    <span className="relative h-4 w-4 shrink-0" aria-hidden="true">
      <span
        className={cn(
          "absolute left-[2px] top-[3px] h-[11px] w-3 rounded-b-[3px] border-x border-b bg-gradient-to-b shadow-sm",
          active
            ? "border-emerald-700/40 from-emerald-400 via-emerald-500 to-emerald-700"
            : "border-slate-500/35 from-slate-300 via-slate-400 to-slate-600 dark:from-slate-500 dark:via-slate-600 dark:to-slate-800",
        )}
      />
      <span
        className={cn(
          "absolute left-[2px] top-0 h-[6px] w-3 rounded-[50%] border bg-gradient-to-b shadow-sm",
          active
            ? "border-emerald-700/40 from-emerald-200 to-emerald-500"
            : "border-slate-500/35 from-slate-100 to-slate-400 dark:from-slate-300 dark:to-slate-600",
        )}
      />
    </span>
  );
}

function TableTreeIcon({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "grid h-4 w-4 shrink-0 grid-cols-2 grid-rows-2 gap-px rounded-[3px] p-[2px] shadow-sm ring-1",
        active
          ? "bg-blue-600 ring-blue-700/30"
          : "bg-sky-600 ring-sky-700/25 dark:bg-sky-500",
      )}
      aria-hidden="true"
    >
      <span className="rounded-[1px] bg-sky-100/90" />
      <span className="rounded-[1px] bg-sky-200/90" />
      <span className="rounded-[1px] bg-sky-200/90" />
      <span className="rounded-[1px] bg-sky-100/90" />
    </span>
  );
}

/** 多语句脚本的执行结果视图（FR-243）：结果集切换条 + 当前结果。 */
function MultiResultView({
  tab,
  connectionId,
}: {
  tab: QueryTab;
  connectionId: string;
}) {
  const setActiveResultIndex = useSessionStore((s) => s.setActiveResultIndex);
  const results = tab.multiResults ?? [];
  if (results.length === 0) return null;
  const activeIndex = Math.min(tab.activeResultIndex, results.length - 1);
  const current = results[activeIndex];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 px-2 py-1 dark:border-neutral-800">
        {results.map((result, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setActiveResultIndex(tab.id, index)}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs",
              index === activeIndex
                ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800",
            )}
          >
            结果 {index + 1}
            {result.outcome.status === "error" && (
              <span className="text-red-500" aria-label="失败">
                ✕
              </span>
            )}
            {result.outcome.status === "skipped" && (
              <span className="text-neutral-400" aria-label="已跳过">
                ⤼
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
          共 {results.length} 条语句
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {current.outcome.status === "ok" ? (
          <ResultTable
            rowSet={current.outcome.rowSet}
            connectionId={connectionId}
            truncated={current.outcome.rowSet.truncated}
          />
        ) : current.outcome.status === "error" ? (
          <p className="p-4 text-sm text-red-600 dark:text-red-300">
            {translateError({
              key: current.outcome.key,
              line: current.outcome.line,
            })}
          </p>
        ) : (
          <p className="p-4 text-sm text-neutral-400">
            已跳过（前序语句失败或被取消）
          </p>
        )}
      </div>
      <div
        className="truncate border-t border-neutral-200 px-3 py-1 font-mono text-xs text-neutral-400 dark:border-neutral-800"
        title={current.sql}
      >
        {current.sql}
      </div>
    </div>
  );
}

function ExplainTreeView({ nodes }: { nodes: ExplainNode[] }) {
  return (
    <ul className="font-mono leading-5">
      {nodes.map((node, index) => (
        <li key={`${node.label}-${index}`}>
          {node.label}
          {node.hint && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">[{node.hint}]</span>
          )}
          {node.children.length > 0 && (
            <div className="ml-4">
              <ExplainTreeView nodes={node.children} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 结果集表格（react-virtuoso 虚拟滚动，表头吸顶，序号列冻结，列宽可拖拽并持久化 FR-111） */
export function ResultTable({
  rowSet,
  connectionId,
  truncated,
  sort,
  onSort,
  constraints,
  onOpenForeignKey,
}: {
  rowSet: RowSet;
  connectionId: string;
  truncated?: boolean;
  /** 当前排序（FR-242）；与 onSort 同时提供时列头可点击切换 */
  sort?: { column: string; descending: boolean } | null;
  onSort?: (column: string) => void;
  constraints?: ConstraintMeta[];
  onOpenForeignKey?: (
    table: string,
    filters: { column: string; value: string }[],
  ) => void;
}) {
  const [inspect, setInspect] = useState<{
    column: string;
    value: string | null;
    row: (string | null)[];
  } | null>(null);
  const { widthOf, customized, startResize, reset } = useColumnWidths(
    connectionId,
    rowSet.columns,
  );
  // 统一的横纵滚动容器：Virtuoso 通过 customScrollParent 复用它，
  // 表头 sticky top 与序号列 sticky left 才能相对同一滚动框生效
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  if (rowSet.columns.length === 0) {
    return <p className="p-4 text-sm text-neutral-500">（空结果集）</p>;
  }
  const gridTemplateColumns = `48px ${rowSet.columns
    .map((_, i) => `${widthOf(i)}px`)
    .join(" ")}`;
  const minWidth =
    48 + rowSet.columns.reduce((sum, _, i) => sum + widthOf(i), 0);

  return (
    <div className="flex h-full flex-col">
      {(truncated || customized) && (
        <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1 text-xs dark:border-neutral-800">
          {truncated && (
            <span className="text-amber-600 dark:text-amber-300">
              已截断，请补充 LIMIT 缩小结果集
            </span>
          )}
          {customized && (
            <button
              type="button"
              onClick={reset}
              className="ml-auto rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              恢复默认列宽
            </button>
          )}
        </div>
      )}
      <div ref={setScrollEl} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full flex-col text-xs" style={{ minWidth }}>
          <div
            className="sticky top-0 z-20 grid bg-neutral-100 dark:bg-neutral-800"
            style={{ gridTemplateColumns }}
          >
            <div className="sticky left-0 z-30 border-r border-b border-neutral-200 bg-neutral-100 px-2 py-1 text-right font-mono text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800">
              #
            </div>
            {rowSet.columns.map((c, ci) => (
              <div
                key={`${ci}-${c}`}
                className={cn(
                  "relative truncate border-b border-neutral-200 px-2 py-1 text-left font-medium dark:border-neutral-700",
                  onSort &&
                    "cursor-pointer select-none hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60",
                )}
                title={c}
                onClick={onSort ? () => onSort(c) : undefined}
              >
                {c}
                {sort?.column === c && (
                  <span className="ml-0.5 text-blue-500">
                    {sort.descending ? "↓" : "↑"}
                  </span>
                )}
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`拖拽调整 ${c} 列宽`}
                  onMouseDown={(e) => startResize(ci, e)}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-blue-400/60"
                />
              </div>
            ))}
          </div>
          {rowSet.rows.length === 0 ? (
            <p className="p-4 text-sm text-neutral-500">（0 行）</p>
          ) : (
            <Virtuoso
              customScrollParent={scrollEl ?? undefined}
              data={rowSet.rows}
              itemContent={(ri, row) => (
                <div
                  className="group grid hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  style={{ gridTemplateColumns }}
                >
                  <div className="sticky left-0 z-10 border-r border-b border-neutral-100 bg-background px-2 py-1 text-right font-mono text-neutral-400 group-hover:bg-neutral-50 dark:border-neutral-900 dark:group-hover:bg-neutral-900">
                    {ri + 1}
                  </div>
                  {row.map((cell, ci) => (
                    <div
                      key={ci}
                      role="button"
                      tabIndex={0}
                      onDoubleClick={() =>
                        setInspect({ column: rowSet.columns[ci] ?? "", value: cell, row })
                      }
                      className="truncate border-b border-neutral-100 px-2 py-1 dark:border-neutral-900"
                      title={cell ?? "NULL"}
                    >
                      {cell === null ? (
                        <span className="italic text-neutral-400">NULL</span>
                      ) : (
                        cell
                      )}
                    </div>
                  ))}
                </div>
              )}
            />
          )}
        </div>
      </div>
      {inspect && (
        <CellInspector
          column={inspect.column}
          value={inspect.value}
          row={inspect.row}
          columns={rowSet.columns}
          constraints={constraints ?? []}
          onClose={() => setInspect(null)}
          onOpenForeignKey={onOpenForeignKey}
        />
      )}
    </div>
  );
}

function CellInspector({
  column,
  value,
  row,
  columns,
  constraints,
  onClose,
  onOpenForeignKey,
}: {
  column: string;
  value: string | null;
  row: (string | null)[];
  columns: string[];
  constraints: ConstraintMeta[];
  onClose: () => void;
  onOpenForeignKey?: (
    table: string,
    filters: { column: string; value: string }[],
  ) => void;
}) {
  const display = formatCellDisplay(value);
  const fk = constraints
    .map((constraint) => {
      const parsed = parseForeignKey(constraint);
      if (!parsed) return null;
      const index = constraint.columns.findIndex(
        (name) => name.toLowerCase() === column.toLowerCase(),
      );
      if (index < 0) return null;
      return { constraint, parsed, index };
    })
    .find(Boolean);
  const canJump =
    fk &&
    value !== null &&
    fk.constraint.columns.every((name) => {
      const i = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
      return i >= 0 && row[i] !== null;
    });

  return (
    <div className="max-h-56 shrink-0 overflow-auto border-t border-neutral-200 p-2 text-xs dark:border-neutral-800">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono font-medium">{column}</span>
        <button type="button" className="text-neutral-500" onClick={onClose}>
          关闭
        </button>
      </div>
      <p className="mb-1 text-neutral-500">
        {display.kind === "null"
          ? "SQL NULL"
          : display.kind === "empty"
            ? "空字符串（不是 NULL）"
            : display.kind === "json"
              ? "JSON"
              : "文本"}
      </p>
      <pre className="whitespace-pre-wrap break-all font-mono">{display.text}</pre>
      {canJump && fk && value && (
        <Button
          type="button"
          size="sm"
          className="mt-2"
          onClick={() => {
            const filters = fk.constraint.columns.flatMap((src, i) => {
              const rowIndex = columns.findIndex(
                (c) => c.toLowerCase() === src.toLowerCase(),
              );
              const dest = fk.parsed.columns[i];
              const cell = rowIndex >= 0 ? row[rowIndex] : null;
              return dest && cell !== null && cell !== undefined
                ? [{ column: dest, value: cell }]
                : [];
            });
            if (filters.length === fk.constraint.columns.length) {
              onOpenForeignKey?.(fk.parsed.table, filters);
            }
          }}
        >
          打开引用行 {fk.parsed.table}.{fk.parsed.columns[fk.index]}
        </Button>
      )}
    </div>
  );
}
