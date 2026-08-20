"use client";

import { useState } from "react";
import { PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { ResultTable } from "@/components/schema-browser";
import { cn } from "@/lib/utils";
import type { FilterOp, TableFilter } from "@/lib/tauri-api";
import { useSessionStore, type QueryTab } from "@/stores/session-store";

/** 筛选操作符选项（FR-242）；needsValue=false 时隐藏值输入并忽略草稿值 */
const OP_OPTIONS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: "eq", label: "=", needsValue: true },
  { value: "notEq", label: "≠", needsValue: true },
  { value: "gt", label: ">", needsValue: true },
  { value: "gtEq", label: "≥", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "ltEq", label: "≤", needsValue: true },
  { value: "like", label: "包含", needsValue: true },
  { value: "notLike", label: "不包含", needsValue: true },
  { value: "isNull", label: "为空", needsValue: false },
  { value: "isNotNull", label: "非空", needsValue: false },
];

const PAGE_SIZE_OPTIONS = [100, 500, 1000];

/**
 * 表数据浏览视图（FR-242）：筛选工具栏 + 列头排序结果表格 + 分页器。
 * 筛选 / 排序 / 分页全部在服务端执行（WHERE / ORDER BY / LIMIT / OFFSET）。
 */
export function BrowseView({
  tab,
  connectionId,
}: {
  tab: QueryTab;
  connectionId: string;
}) {
  const browse = tab.browse;
  const { browseSetFilters, browseSetOrder, browseSetPage, browseSetPageSize, browseRefresh } =
    useSessionStore();
  // 筛选草稿：本地编辑，点「应用」才提交查询（应用后 store 的 filters 即生效值）
  const [drafts, setDrafts] = useState<TableFilter[]>(browse?.filters ?? []);
  if (!browse) return null;

  const columns = tab.rowSet?.columns ?? [];
  const running = tab.queryRunning;

  function patchDraft(index: number, patch: Partial<TableFilter>) {
    setDrafts((items) =>
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  function applyDrafts() {
    const filters = drafts
      .filter((draft) => draft.column)
      .map((draft) => {
        const option = OP_OPTIONS.find((o) => o.value === draft.op);
        return option?.needsValue ? draft : { ...draft, value: "" };
      });
    void browseSetFilters(tab.id, filters);
  }

  /** 列头点击排序：无 → 升序 → 降序 → 无 */
  const toggleSort = (column: string) => {
    const current = browse.order;
    if (current?.column !== column) {
      void browseSetOrder(tab.id, { column, descending: false });
    } else if (!current.descending) {
      void browseSetOrder(tab.id, { column, descending: true });
    } else {
      void browseSetOrder(tab.id, null);
    }
  };

  const totalPages =
    browse.total !== null
      ? Math.max(1, Math.ceil(browse.total / browse.pageSize))
      : null;

  return (
    <div className="flex h-full flex-col">
      {/* 筛选工具栏：草稿本地编辑，应用后服务端生效 */}
      <div className="border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        {drafts.map((draft, index) => {
          const option = OP_OPTIONS.find((o) => o.value === draft.op);
          return (
            <div key={index} className="mb-1 flex items-center gap-1.5">
              <select
                value={draft.column}
                onChange={(e) => patchDraft(index, { column: e.target.value })}
                aria-label={`筛选列 ${index + 1}`}
                className="rounded border border-neutral-300 bg-white px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                {columns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
              </select>
              <select
                value={draft.op}
                onChange={(e) =>
                  patchDraft(index, { op: e.target.value as FilterOp })
                }
                aria-label={`筛选操作符 ${index + 1}`}
                className="rounded border border-neutral-300 bg-white px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                {OP_OPTIONS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              {option?.needsValue && (
                <input
                  value={draft.value}
                  onChange={(e) => patchDraft(index, { value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyDrafts();
                  }}
                  placeholder={draft.op === "like" || draft.op === "notLike" ? "如 %关键字%" : "值"}
                  className="w-40 rounded border border-neutral-300 bg-white px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                />
              )}
              <button
                type="button"
                onClick={() =>
                  setDrafts((items) => items.filter((_, i) => i !== index))
                }
                aria-label="删除筛选"
                className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              setDrafts((items) => [
                ...items,
                { column: columns[0] ?? "", op: "eq", value: "" },
              ])
            }
            disabled={columns.length === 0}
            className="flex items-center gap-0.5 rounded px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            <PlusIcon className="h-3 w-3" />
            筛选
          </button>
          <button
            type="button"
            onClick={applyDrafts}
            disabled={running}
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            应用
          </button>
          <button
            type="button"
            onClick={() => void browseRefresh(tab.id)}
            disabled={running}
            aria-label="刷新"
            title="按当前筛选 / 排序 / 分页重新查询"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            <RefreshCwIcon className="h-3.5 w-3.5" />
          </button>
          {browse.filters.length > 0 && (
            <span className="text-xs text-neutral-400">
              已生效 {browse.filters.length} 个筛选
            </span>
          )}
        </div>
      </div>

      {/* 结果表格（列头点击排序） */}
      <div className="min-h-0 flex-1">
        {tab.rowSet ? (
          <ResultTable
            rowSet={tab.rowSet}
            connectionId={connectionId}
            sort={browse.order}
            onSort={toggleSort}
          />
        ) : (
          <p className="p-4 text-sm text-neutral-500">
            {running ? "加载中…" : "暂无数据"}
          </p>
        )}
      </div>
      {tab.queryErrorMsg && (
        <p className="border-t border-neutral-200 px-3 py-1.5 text-xs text-red-600 dark:border-neutral-800 dark:text-red-300">
          {tab.queryErrorMsg}
        </p>
      )}

      {/* 分页器 */}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800">
        <button
          type="button"
          onClick={() => void browseSetPage(tab.id, browse.page - 1)}
          disabled={browse.page === 0 || running}
          className={cn(
            "rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50",
            "dark:border-neutral-700 dark:hover:bg-neutral-800",
          )}
        >
          上一页
        </button>
        <span className="text-neutral-500 dark:text-neutral-400">
          第 {browse.page + 1}
          {totalPages !== null && ` / ${totalPages}`} 页
          {browse.total !== null && `（共 ${browse.total} 行）`}
          {browse.total === null && "（总行数未知）"}
        </span>
        <button
          type="button"
          onClick={() => void browseSetPage(tab.id, browse.page + 1)}
          disabled={!browse.hasNextPage || running}
          className={cn(
            "rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50",
            "dark:border-neutral-700 dark:hover:bg-neutral-800",
          )}
        >
          下一页
        </button>
        <select
          value={browse.pageSize}
          onChange={(e) => void browseSetPageSize(tab.id, Number(e.target.value))}
          disabled={running}
          aria-label="每页行数"
          className="ml-auto rounded border border-neutral-300 bg-white px-1.5 py-0.5 dark:border-neutral-700 dark:bg-neutral-900"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size} 行 / 页
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
