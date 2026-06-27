"use client";

import type { RowSet } from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

/**
 * 已连接后的 schema 浏览：左侧 database/table 树，右侧选中表的前 1000 行。
 *
 * v0.1 用普通可滚动表格（1000 行上限浏览器无压力）；react-virtuoso 虚拟滚动
 * 留 Week 4 的 10w 行硬上限再引入，避免提前加依赖。
 */
export function SchemaBrowser({ connectionName }: { connectionName: string }) {
  const {
    databases,
    selectedDb,
    tables,
    selectedTable,
    rowSet,
    loadingData,
    lostHops,
    errorMsg,
    selectDb,
    selectTable,
    close,
  } = useSessionStore();

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span className="text-sm font-semibold">{connectionName}</span>
        <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-950 dark:text-green-300">
          已连接
        </span>
        <button
          onClick={close}
          className="ml-auto rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          断开
        </button>
      </div>

      {lostHops.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          ⚠ 第 {lostHops.map((h) => h + 1).join("、")} 跳 SSH 隧道已断开，请重连。
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
          {databases.map((db) => (
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

        {/* 右：结果表格 */}
        <section className="min-w-0 flex-1 overflow-auto">
          {!selectedTable && (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              选择左侧的表查看前 1000 行
            </div>
          )}
          {selectedTable && loadingData && (
            <p className="p-4 text-sm text-neutral-500">加载中…</p>
          )}
          {selectedTable && !loadingData && rowSet && (
            <ResultTable rowSet={rowSet} />
          )}
        </section>
      </div>
    </div>
  );
}

/** 结果集表格（普通滚动表格，表头吸顶） */
function ResultTable({ rowSet }: { rowSet: RowSet }) {
  if (rowSet.columns.length === 0) {
    return <p className="p-4 text-sm text-neutral-500">（空结果集）</p>;
  }
  return (
    <table className="min-w-full border-collapse text-xs">
      <thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-800">
        <tr>
          <th className="border-b border-neutral-200 px-2 py-1 text-right font-mono text-neutral-400 dark:border-neutral-700">
            #
          </th>
          {rowSet.columns.map((c) => (
            <th
              key={c}
              className="border-b border-neutral-200 px-2 py-1 text-left font-medium dark:border-neutral-700"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rowSet.rows.map((row, ri) => (
          <tr
            key={ri}
            className="hover:bg-neutral-50 dark:hover:bg-neutral-900"
          >
            <td className="border-b border-neutral-100 px-2 py-1 text-right font-mono text-neutral-400 dark:border-neutral-900">
              {ri + 1}
            </td>
            {row.map((cell, ci) => (
              <td
                key={ci}
                className="max-w-xs truncate border-b border-neutral-100 px-2 py-1 dark:border-neutral-900"
                title={cell ?? "NULL"}
              >
                {cell === null ? (
                  <span className="italic text-neutral-400">NULL</span>
                ) : (
                  cell
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
