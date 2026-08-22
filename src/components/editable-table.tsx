"use client";

import { useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { Trash2Icon, Undo2Icon } from "lucide-react";

import { useColumnWidths } from "@/hooks/use-column-widths";
import { cn } from "@/lib/utils";
import type { RowSet } from "@/lib/tauri-api";
import { rowKeyOf, type PendingEdit } from "@/stores/session-store";

/** 单元格本地编辑态：正在编辑的行键 + 列 + 草稿值 */
interface EditingCell {
  rowKey: string;
  column: string;
  draft: string;
}

/**
 * 可编辑结果表格（FR-250）：浏览 tab 编辑模式专用。
 *
 * 在 ResultTable 的 Virtuoso + sticky 布局上扩展：
 * - 双击单元格进入本地编辑，Enter 保存为 dirty / Esc 取消；
 * - 已有行的 update 变更覆盖显示，delete 行划线且值可原位恢复（Undo 撤销删除）；
 * - 新增草稿行在表格末尾追加一行，填值即成为 insert dirty；
 * - 单元格左侧「·」标记表示该行有未提交修改。
 */
export function EditableTable({
  rowSet,
  connectionId,
  pkColumns,
  pendingEdits,
  onCellEdit,
  onToggleDelete,
  onAddRow,
}: {
  rowSet: RowSet;
  connectionId: string;
  pkColumns: string[];
  pendingEdits: PendingEdit[];
  onCellEdit: (rowKey: string, column: string, value: string | null) => void;
  onToggleDelete: (rowKey: string) => void;
  onAddRow: () => void;
}) {
  const { widthOf, customized, startResize, reset } = useColumnWidths(
    connectionId,
    rowSet.columns,
  );
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const editingRef = useRef<EditingCell | null>(null);
  editingRef.current = editing;

  if (rowSet.columns.length === 0) {
    return <p className="p-4 text-sm text-neutral-500">（空结果集）</p>;
  }
  const gridTemplateColumns = `48px ${rowSet.columns
    .map((_, i) => `${widthOf(i)}px`)
    .join(" ")}`;
  const minWidth =
    48 + rowSet.columns.reduce((sum, _, i) => sum + widthOf(i), 0);

  /** 行当前展示值：update dirty 覆盖变更列，其余取行数据 */
  function displayedRow(row: Array<string | null>, rowKey: string | null) {
    if (!rowKey) return row;
    const edit = pendingEdits.find((e) => e.rowKey === rowKey && e.kind === "update");
    if (!edit) return row;
    return row.map((value, index) => {
      const column = rowSet.columns[index];
      return column in edit.values ? edit.values[column] : value;
    });
  }

  function dirtyOf(rowKey: string | null): PendingEdit | undefined {
    if (!rowKey) return undefined;
    return pendingEdits.find((e) => e.rowKey === rowKey);
  }

  /** 双击进入编辑：delete 行不可编辑；已有行禁止编辑主键列（新增行允许）。 */
  function beginEdit(rowKey: string, column: string, currentValue: string | null) {
    const dirty = dirtyOf(rowKey);
    if (dirty?.kind === "delete") return;
    if (dirty?.kind !== "insert" && pkColumns.includes(column)) return;
    setEditing({
      rowKey,
      column,
      draft: currentValue ?? "",
    });
  }

  function commitEdit(asNull = false) {
    const current = editingRef.current;
    if (!current) return;
    onCellEdit(current.rowKey, current.column, asNull ? null : current.draft);
    setEditing(null);
  }

  // 虚拟滚动下编辑输入框在行离开可视区后卸载：Esc 时同步清除（原生 input onKeyDown 已处理）
  const rows = rowSet.rows;

  return (
    <div className="flex h-full flex-col">
      {customized && (
        <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1 text-xs dark:border-neutral-800">
          <button
            type="button"
            onClick={reset}
            className="ml-auto rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            恢复默认列宽
          </button>
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
                className="truncate border-b border-neutral-200 px-2 py-1 text-left font-medium dark:border-neutral-700"
                title={c}
              >
                {c}
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
          <Virtuoso
            customScrollParent={scrollEl ?? undefined}
            data={rows}
            itemContent={(ri, row) => {
              const rowKey = rowKeyOf(row, rowSet.columns, pkColumns);
              const dirty = dirtyOf(rowKey);
              const display = displayedRow(row, rowKey);
              const deleted = dirty?.kind === "delete";
              return (
                <div
                  className={cn(
                    "group grid hover:bg-neutral-50 dark:hover:bg-neutral-900",
                    deleted && "opacity-50",
                    dirty && !deleted && "bg-amber-50/60 dark:bg-amber-900/20",
                  )}
                  style={{ gridTemplateColumns }}
                >
                  <div className="sticky left-0 z-10 flex items-center justify-end gap-1 border-r border-b border-neutral-100 bg-background px-2 py-1 font-mono text-neutral-400 group-hover:bg-neutral-50 dark:border-neutral-900 dark:group-hover:bg-neutral-900">
                    {ri + 1}
                    {rowKey && (
                      <button
                        type="button"
                        onClick={() => onToggleDelete(rowKey)}
                        aria-label={deleted ? "撤销删除" : "删除行"}
                        title={deleted ? "撤销删除" : "删除行"}
                        className={cn(
                          "rounded p-0.5 opacity-0 group-hover:opacity-100",
                          deleted
                            ? "text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950"
                            : "text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950",
                        )}
                      >
                        {deleted ? (
                          <Undo2Icon className="h-3.5 w-3.5" />
                        ) : (
                          <Trash2Icon className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                  {display.map((cell, ci) => {
                    const column = rowSet.columns[ci];
                    const isEditing =
                      editing?.rowKey === rowKey && editing.column === column;
                    return (
                      <div
                        key={ci}
                        onDoubleClick={() => {
                          if (!rowKey || deleted) return;
                          beginEdit(rowKey, column, cell);
                        }}
                        title={cell ?? "NULL"}
                        className={cn(
                          "truncate border-b border-neutral-100 px-2 py-1 dark:border-neutral-900",
                          !rowKey && "cursor-not-allowed opacity-40",
                          deleted && "line-through",
                        )}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            defaultValue={editing?.draft ?? ""}
                            title="Enter 保存 · Shift+Enter 置为 NULL · Esc 取消"
                            onChange={(e) =>
                              setEditing((prev) =>
                                prev ? { ...prev, draft: e.target.value } : prev,
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && e.shiftKey) commitEdit(true);
                              else if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") setEditing(null);
                            }}
                            onBlur={() => commitEdit()}
                            className="w-full rounded border border-blue-400 bg-white px-1 py-0.5 outline-none dark:bg-neutral-900"
                          />
                        ) : cell === null ? (
                          <span className="italic text-neutral-400">NULL</span>
                        ) : (
                          cell
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {/* 新增草稿行：末尾追加，填值即成为 insert dirty */}
          {pendingEdits
            .filter((e) => e.kind === "insert")
            .map((insert) => (
              <div
                key={insert.rowKey}
                className="group grid bg-emerald-50/60 dark:bg-emerald-900/20"
                style={{ gridTemplateColumns }}
              >
                <div className="sticky left-0 z-10 flex items-center justify-end gap-1 border-r border-b border-neutral-100 bg-emerald-50/60 px-2 py-1 font-mono text-neutral-400 group-hover:bg-emerald-50 dark:border-neutral-900 dark:bg-emerald-900/20 dark:group-hover:bg-emerald-900/30">
                  +
                  <button
                    type="button"
                    onClick={() => onToggleDelete(insert.rowKey)}
                    aria-label="移除新增行"
                    title="移除新增行"
                    className="rounded p-0.5 text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </button>
                </div>
                {rowSet.columns.map((column, ci) => {
                  const value = insert.values[column] ?? null;
                  const isEditing =
                    editing?.rowKey === insert.rowKey && editing.column === column;
                  return (
                    <div
                      key={ci}
                      onDoubleClick={() => beginEdit(insert.rowKey, column, value)}
                      title={value ?? "NULL"}
                      className="truncate border-b border-neutral-100 px-2 py-1 dark:border-neutral-900"
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          defaultValue={editing?.draft ?? ""}
                          title="Enter 保存 · Shift+Enter 置为 NULL · Esc 取消"
                          onChange={(e) =>
                            setEditing((prev) =>
                              prev ? { ...prev, draft: e.target.value } : prev,
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && e.shiftKey) commitEdit(true);
                            else if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditing(null);
                          }}
                          onBlur={() => commitEdit()}
                          className="w-full rounded border border-blue-400 bg-white px-1 py-0.5 outline-none dark:bg-neutral-900"
                        />
                      ) : value === null ? (
                        <span className="italic text-neutral-400">NULL</span>
                      ) : (
                        value
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          {/* 表格末尾：新增行按钮 */}
          <button
            type="button"
            onClick={onAddRow}
            className="flex items-center gap-1 border-b border-neutral-100 px-3 py-1.5 text-neutral-400 hover:bg-neutral-50 hover:text-neutral-600 dark:border-neutral-900 dark:hover:bg-neutral-900"
            style={{ gridTemplateColumns }}
          >
            + 新增行
          </button>
        </div>
      </div>
    </div>
  );
}
