"use client";

import { Virtuoso } from "react-virtuoso";

import { TopologyGraph } from "@/components/topology-graph";
import { needsWriteConfirmation } from "@/lib/sql-guard";
import type { RowSet, StoredConnection } from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

/**
 * 已连接后的 schema 浏览：左侧 database/table 树，右侧选中表的前 1000 行。
 *
 * v0.1 用普通可滚动表格（1000 行上限浏览器无压力）；react-virtuoso 虚拟滚动
 * 留 Week 4 的 10w 行硬上限再引入，避免提前加依赖。
 */
export function SchemaBrowser({ connection }: { connection: StoredConnection }) {
  const {
    status,
    databases,
    selectedDb,
    tables,
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
    selectTable,
    setSqlText,
    executeSql,
    cancelQuery,
    close,
  } = useSessionStore();

  async function runSql() {
    const sql = sqlText.trim();
    if (!sql) return;
    const allowWrite =
      needsWriteConfirmation(sql) &&
      window.confirm("检测到写操作，请确认已经使用只读账号或明确知道风险。继续执行？");
    if (needsWriteConfirmation(sql) && !allowWrite) return;
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
        {/* 左：db / table 树 */}
        <aside className="w-60 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
          {!connected && (
            <p className="px-3 py-3 text-xs text-neutral-500">
              {status === "error" ? "连接失败，请检查上方断点。" : "正在建立连接…"}
            </p>
          )}
          {connected && databases.map((db) => (
            <div key={db.name}>
              <button
                onClick={() => selectDb(db.name)}
                className={`flex w-full items-center gap-1 px-3 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 ${
                  selectedDb === db.name ? "font-medium" : ""
                }`}
              >
                <span className="text-neutral-400">
                  {selectedDb === db.name ? "▾" : "▸"}
                </span>
                {db.name}
              </button>
              {selectedDb === db.name && (
                <ul className="pb-1">
                  {tables.length === 0 && (
                    <li className="px-3 py-1 pl-7 text-xs text-neutral-400">
                      {loadingData ? "加载中…" : "（无表）"}
                    </li>
                  )}
                  {tables.map((t) => (
                    <li key={t.name}>
                      <button
                        onClick={() => selectTable(t.name)}
                        title={t.comment ?? undefined}
                        className={`block w-full truncate px-3 py-1 pl-7 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                          selectedTable === t.name
                            ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                            : "text-neutral-600 dark:text-neutral-400"
                        }`}
                      >
                        {t.name}
                      </button>
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
            <textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              disabled={!connected || queryRunning}
              spellCheck={false}
              className="h-24 w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-blue-500 disabled:bg-neutral-100 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
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
              当前表：{selectedDb}.{selectedTable}
            </div>
          )}
        </section>
      </div>
    </div>
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
