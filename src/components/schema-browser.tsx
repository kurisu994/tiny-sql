"use client";

import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";

import { SqlCodeEditor } from "@/components/sql-code-editor";
import { TopologyGraph } from "@/components/topology-graph";
import { needsWriteConfirmation } from "@/lib/sql-guard";
import type {
  ColumnMeta,
  RowSet,
  StoredConnection,
  TableMeta,
} from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

/**
 * 已连接后的 schema 浏览：左侧 database/table 树，右侧选中表的前 1000 行。
 *
 * 结果表格用 react-virtuoso 虚拟滚动（表浏览 1000 行与 SQL 编辑器 10w 行共用）。
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
    loadingColumns,
    refreshingMetadata,
    selectedTable,
    rowSet,
    loadingData,
    sqlText,
    queryRunning,
    queryErrorMsg,
    hopStatuses,
    lostHops,
    errorMsg,
    selectDb,
    toggleExpandedDb,
    selectSchema,
    toggleExpandedSchema,
    toggleTableColumns,
    refreshMetadata,
    selectTable,
    setSqlText,
    executeSql,
    cancelQuery,
    close,
  } = useSessionStore();
  const confirm = useConfirmStore((s) => s.confirm);
  const sqlNamespaces = useMemo(
    () =>
      connection.driver === "postgresql"
        ? schemas.map((schema) => schema.name)
        : databases.map((database) => database.name),
    [connection.driver, databases, schemas],
  );

  async function runSql() {
    const sql = sqlText.trim();
    if (!sql) return;
    let allowWrite = false;
    if (needsWriteConfirmation(sql, connection.driver)) {
      allowWrite = await confirm({
        title: "确认写操作",
        message:
          "检测到写操作，请确认已使用只读账号或明确知道风险。是否继续执行？",
        confirmText: "继续执行",
        danger: true,
      });
      if (!allowWrite) return;
    }
    await executeSql(sql, { rowLimit: 100000, allowWrite });
  }

  const connected = status === "connected";

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span className="text-sm font-semibold">{connection.name}</span>
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
        <button
          onClick={close}
          className="ml-auto rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          断开
        </button>
      </div>

      <TopologyGraph
        connection={connection}
        sessionStatus={status}
        hopStatuses={hopStatuses}
      />

      {lostHops.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          第 {lostHops.map((h) => h + 1).join("、")} 跳 SSH 隧道已断开，请重连。
        </div>
      )}
      {errorMsg && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {errorMsg}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左：database / schema / table 树 */}
        <aside className="w-72 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white/95 px-3 py-1.5 text-xs text-neutral-500 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
            <span>数据库对象</span>
            <button
              type="button"
              onClick={refreshMetadata}
              disabled={!connected || refreshingMetadata}
              aria-label="刷新数据库对象"
              className="rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            >
              {refreshingMetadata ? "刷新中…" : "刷新"}
            </button>
          </div>
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
              {expandedDb === db.name && connection.driver === "mysql" && (
                <TableTreeList
                  tables={tables}
                  loading={loadingData}
                  loadingColumns={loadingColumns}
                  expandedTable={expandedTable}
                  columns={tableColumns}
                  selectedTable={selectedTable}
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
                          selectedTable={selectedTable}
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

        {/* 右：SQL + 结果表格 */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
            <SqlCodeEditor
              value={sqlText}
              onChange={setSqlText}
              onRun={runSql}
              disabled={!connected || queryRunning}
              queryErrorMsg={queryErrorMsg}
              driver={connection.driver}
              namespaces={sqlNamespaces}
              selectedNamespace={
                connection.driver === "postgresql" ? selectedSchema : selectedDb
              }
              tables={tables}
              columnsByTable={columnsByTable}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={runSql}
                disabled={!connected || queryRunning || sqlText.trim().length === 0}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                执行
              </button>
              <button
                onClick={cancelQuery}
                disabled={!queryRunning}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              {queryRunning && (
                <span className="text-xs text-neutral-500">执行中…</span>
              )}
              {rowSet?.truncated && (
                <span className="ml-auto text-xs text-amber-600 dark:text-amber-300">
                  已截断，请补充 LIMIT 缩小结果集
                </span>
              )}
            </div>
            {queryErrorMsg && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-300">
                {queryErrorMsg}
              </p>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {!rowSet && !loadingData && (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                {selectedTable ? "暂无结果" : "选择左侧表，或直接执行 SQL。"}
              </div>
            )}
            {loadingData && (
              <p className="p-4 text-sm text-neutral-500">加载中…</p>
            )}
            {!loadingData && rowSet && <ResultTable rowSet={rowSet} />}
          </div>
          {selectedTable && (
            <div className="border-t border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
              当前表：
              {connection.driver === "postgresql"
                ? `${selectedDb}.${selectedSchema}.${selectedTable}`
                : `${selectedDb}.${selectedTable}`}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TableTreeList({
  tables,
  loading,
  loadingColumns,
  expandedTable,
  columns,
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
            </button>
          </div>
          {expandedTable === table.name && (
            <ColumnTreeList
              columns={columns}
              loading={loadingColumns}
              paddingClass={columnPaddingClass}
            />
          )}
        </li>
      ))}
    </ul>
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

/** 结果集表格（react-virtuoso 虚拟滚动，表头吸顶） */
export function ResultTable({ rowSet }: { rowSet: RowSet }) {
  if (rowSet.columns.length === 0) {
    return <p className="p-4 text-sm text-neutral-500">（空结果集）</p>;
  }
  const gridTemplateColumns = `48px repeat(${rowSet.columns.length}, minmax(140px, 260px))`;
  const minWidth = 48 + rowSet.columns.length * 160;

  return (
    <div className="h-full overflow-x-auto">
      <div className="flex h-full flex-col text-xs" style={{ minWidth }}>
        <div
          className="grid bg-neutral-100 dark:bg-neutral-800"
          style={{ gridTemplateColumns }}
        >
          <div className="border-b border-neutral-200 px-2 py-1 text-right font-mono text-neutral-400 dark:border-neutral-700">
            #
          </div>
          {rowSet.columns.map((c) => (
            <div
              key={c}
              className="truncate border-b border-neutral-200 px-2 py-1 text-left font-medium dark:border-neutral-700"
              title={c}
            >
              {c}
            </div>
          ))}
        </div>
        {rowSet.rows.length === 0 ? (
          <p className="p-4 text-sm text-neutral-500">（0 行）</p>
        ) : (
          <Virtuoso
            className="min-h-0 flex-1"
            data={rowSet.rows}
            itemContent={(ri, row) => (
              <div
                className="grid hover:bg-neutral-50 dark:hover:bg-neutral-900"
                style={{ gridTemplateColumns }}
              >
                <div className="border-b border-neutral-100 px-2 py-1 text-right font-mono text-neutral-400 dark:border-neutral-900">
                  {ri + 1}
                </div>
                {row.map((cell, ci) => (
                  <div
                    key={ci}
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
  );
}
