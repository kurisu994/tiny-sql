"use client";

import { useEffect, useState } from "react";

import {
  historyApi,
  translateError,
  type HistoryEntry,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";

/**
 * SQL 历史面板（FR-106）：最近 100 条执行记录（后端加密落盘）。
 * 点击条目回填到当前 tab；清空需二次确认。
 */
export function HistoryPanel({
  onPick,
  onClose,
}: {
  /** 选中一条历史（回填 SQL 到当前 tab） */
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirmStore((s) => s.confirm);

  useEffect(() => {
    historyApi
      .list()
      .then(setEntries)
      .catch((e) => setError(translateError(e)));
  }, []);

  async function clearAll() {
    const ok = await confirm({
      title: "清空 SQL 历史",
      message: "确定清空全部 SQL 执行历史？此操作不可撤销。",
      confirmText: "清空",
      danger: true,
    });
    if (!ok) return;
    try {
      await historyApi.clear();
      setEntries([]);
    } catch (e) {
      setError(translateError(e));
    }
  }

  return (
    <div className="flex max-h-72 flex-col overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
        <span>SQL 历史（最近 100 条，加密保存）</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={clearAll}
            disabled={!entries || entries.length === 0}
            className="rounded px-1.5 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            清空
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
        {entries === null && !error && (
          <p className="px-3 py-2 text-xs text-neutral-400">加载中…</p>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="px-3 py-2 text-xs text-neutral-400">暂无历史记录</p>
        )}
        <ul>
          {entries?.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onPick(entry.sql)}
                title="点击回填到当前查询 tab"
                className="flex w-full flex-col gap-0.5 border-b border-neutral-50 px-3 py-1.5 text-left hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-800"
              >
                <span className="flex items-center gap-1.5 text-[10px] text-neutral-400">
                  <span
                    className={
                      entry.success
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-500"
                    }
                  >
                    {entry.success ? "成功" : "失败"}
                  </span>
                  <span>{formatTime(entry.executedAt)}</span>
                  <span className="truncate">
                    {entry.connectionName} · {entry.database}
                    {entry.schema ? `.${entry.schema}` : ""}
                  </span>
                </span>
                <code className="line-clamp-2 break-all text-xs text-neutral-700 dark:text-neutral-300">
                  {entry.sql}
                </code>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
