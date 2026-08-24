"use client";

import { useState } from "react";
import { CheckIcon, PencilIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { EditableTable } from "@/components/editable-table";
import { ImportCsvDialog } from "@/components/import-csv-dialog";
import { ResultTable } from "@/components/schema-browser";
import { TableStructureView } from "@/components/table-structure-view";
import { isReadOnly } from "@/lib/connection-meta";
import { cn } from "@/lib/utils";
import {
  dbApi,
  translateError,
  type ColumnMeta,
  type FilterOp,
  type TableFilter,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
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
  const {
    browseSetFilters,
    browseSetOrder,
    browseSetPage,
    browseSetPageSize,
    browseRefresh,
    browseSetEditMode,
    browseApplyCellEdit,
    browseAddRow,
    browseToggleDelete,
    browseCommitEdits,
    browseDiscardEdits,
  } = useSessionStore();
  const confirm = useConfirmStore((s) => s.confirm);
  const selectedDb = useSessionStore((s) => s.selectedDb);
  const selectedSchema = useSessionStore((s) => s.selectedSchema);
  const tables = useSessionStore((s) => s.tables);
  const driver = useSessionStore((s) => s.activeConnection?.driver ?? "mysql");
  const tableType =
    tables.find((item) => item.name === browse?.table)?.tableType ?? "BASE TABLE";
  // 筛选草稿：本地编辑，点「应用」才提交查询（应用后 store 的 filters 即生效值）
  const [drafts, setDrafts] = useState<TableFilter[]>(browse?.filters ?? []);
  // 子视图：数据 / 结构（FR-251）；结构视图下暂停数据表格渲染
  const [subView, setSubView] = useState<"data" | "structure">("data");
  // CSV 导入（FR-252）：对话框开关 + 目标表列元数据
  const [importOpen, setImportOpen] = useState(false);
  const [importColumns, setImportColumns] = useState<ColumnMeta[]>([]);
  // SQL dump 导出（FR-252）
  const [dumping, setDumping] = useState(false);
  const [dumpMsg, setDumpMsg] = useState<string | null>(null);
  if (!browse) return null;

  const columns = tab.rowSet?.columns ?? [];
  const running = tab.queryRunning;
  const editMode = browse.editMode;
  const readOnly = isReadOnly(useSessionStore((s) => s.activeConnection));
  const pendingCount = browse.pendingEdits.length;
  const insertCount = browse.pendingEdits.filter((e) => e.kind === "insert").length;
  const updateCount = browse.pendingEdits.filter((e) => e.kind === "update").length;
  const deleteCount = browse.pendingEdits.filter((e) => e.kind === "delete").length;

  /** 提交前二次确认（FR-250）：展示变更摘要，确认后调用 store 提交 */
  async function handleCommit() {
    const ok = await confirm({
      title: "提交表格编辑",
      message: `确定提交 ${pendingCount} 条变更？（新增 ${insertCount} / 修改 ${updateCount} / 删除 ${deleteCount}）\n提交将在单个事务中执行，任一失败将整体回滚。`,
      confirmText: "提交",
      danger: deleteCount > 0,
    });
    if (!ok) return;
    const success = await browseCommitEdits(tab.id);
    if (success) {
      // 提交成功后自动退出编辑模式，回到只读浏览
      browseSetEditMode(tab.id, false);
    }
  }

  /** 放弃前二次确认（仅当存在 dirty） */
  async function handleDiscard() {
    if (pendingCount === 0) return;
    const ok = await confirm({
      title: "放弃表格编辑",
      message: `确定放弃 ${pendingCount} 条未提交变更吗？此操作不可撤销。`,
      confirmText: "放弃",
      danger: true,
    });
    if (ok) browseDiscardEdits(tab.id);
  }

  /** 切换编辑模式：退出时若有 dirty 需确认 */
  async function handleToggleEditMode() {
    if (editMode && pendingCount > 0) {
      const ok = await confirm({
        title: "退出编辑模式",
        message: `还有 ${pendingCount} 条未提交变更，退出将保留在编辑区（不会丢失），可在重新进入后继续；确定退出吗？`,
        confirmText: "退出",
      });
      if (!ok) return;
    }
    browseSetEditMode(tab.id, !editMode);
  }

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

  /** 翻页 / 筛选 / 排序前检查：编辑 dirty 会随数据刷新悬空（FR-250），需确认丢弃 */
  async function confirmIfDirty(): Promise<boolean> {
    if (!editMode || pendingCount === 0) return true;
    return confirm({
      title: "丢弃未提交变更",
      message: `还有 ${pendingCount} 条未提交变更，翻页 / 筛选 / 排序将丢弃它们。确定继续吗？`,
      confirmText: "丢弃并继续",
      danger: true,
    });
  }

  /** 列头点击排序：无 → 升序 → 降序 → 无 */
  const toggleSort = (column: string) => {
    void (async () => {
      if (!(await confirmIfDirty())) return;
      if (pendingCount > 0) browseDiscardEdits(tab.id);
      const current = browse.order;
      if (current?.column !== column) {
        await browseSetOrder(tab.id, { column, descending: false });
      } else if (!current.descending) {
        await browseSetOrder(tab.id, { column, descending: true });
      } else {
        await browseSetOrder(tab.id, null);
      }
    })();
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
            onClick={() => {
              void (async () => {
                if (!(await confirmIfDirty())) return;
                if (pendingCount > 0) browseDiscardEdits(tab.id);
                applyDrafts();
              })();
            }}
            disabled={running}
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            应用
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                if (!(await confirmIfDirty())) return;
                if (pendingCount > 0) browseDiscardEdits(tab.id);
                await browseRefresh(tab.id);
              })();
            }}
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
          {/* 编辑模式开关（FR-250）：仅显式主键表可进入 */}
          {browse.editable && !readOnly && (
            <button
              type="button"
              onClick={() => void handleToggleEditMode()}
              className={cn(
                "ml-1 flex items-center gap-1 rounded px-2 py-1 text-xs font-medium",
                editMode
                  ? "bg-amber-500 text-white hover:bg-amber-600"
                  : "border border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
              )}
            >
              <PencilIcon className="h-3 w-3" />
              {editMode ? "编辑中" : "编辑"}
            </button>
          )}
          {readOnly && (
            <span className="text-xs text-neutral-400" title="应用只读连接不可编辑">
              应用只读
            </span>
          )}
          {!browse.editable && !readOnly && (
            <span className="text-xs text-neutral-400" title="仅带主键的表可编辑">
              无主键，不可编辑
            </span>
          )}
          {/* 数据 / 结构子视图切换（FR-251） */}
          <div className="ml-1 flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            {(["data", "structure"] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setSubView(view)}
                className={cn(
                  "px-2 py-1 text-xs",
                  subView === view
                    ? "bg-neutral-700 text-white dark:bg-neutral-600"
                    : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800",
                )}
              >
                {view === "data" ? "数据" : "结构"}
              </button>
            ))}
          </div>
          {/* CSV 导入（FR-252） */}
          <button
            type="button"
            onClick={() => {
              void (async () => {
                if (!selectedDb) return;
                try {
                  const columns = await dbApi.listColumns(
                    connectionId,
                    selectedDb,
                    driver === "postgresql" ? selectedSchema : null,
                    browse.table,
                  );
                  setImportColumns(columns);
                  setImportOpen(true);
                } catch {
                  // 列元数据拉取失败不打开对话框（错误由全局错误条兜底）
                }
              })();
            }}
            disabled={!selectedDb || editMode || readOnly}
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            导入 CSV
          </button>
          {/* 导出 SQL dump（FR-252）：当前表 DDL + 数据 */}
          <button
            type="button"
            onClick={() => {
              void (async () => {
                if (!selectedDb) return;
                const { save } = await import("@tauri-apps/plugin-dialog");
                const path = await save({
                  title: "导出 SQL dump",
                  defaultPath: `${browse.table}.sql`,
                  filters: [{ name: "SQL", extensions: ["sql"] }],
                });
                if (typeof path !== "string") return;
                setDumpMsg(null);
                setDumping(true);
                try {
                  const result = await dbApi.exportDump(connectionId, {
                    database: selectedDb,
                    schema: driver === "postgresql" ? selectedSchema : null,
                    table: browse.table,
                    path,
                  });
                  setDumpMsg(`已导出 ${result.rows} 行`);
                } catch (e) {
                  setDumpMsg(translateError(e));
                } finally {
                  setDumping(false);
                }
              })();
            }}
            disabled={!selectedDb || editMode || dumping}
            title="导出当前表的建表 DDL 与数据为 SQL 文件"
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {dumping ? "导出中…" : "导出 SQL"}
          </button>
          {dumpMsg && (
            <span className="text-xs text-neutral-400">{dumpMsg}</span>
          )}
        </div>
      </div>

      {/* 编辑模式操作条（FR-250）：dirty 计数 + 提交 / 放弃 */}
      {editMode && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs dark:border-amber-900/50 dark:bg-amber-950/30">
          <span className="text-amber-700 dark:text-amber-300">
            {pendingCount > 0
              ? `未提交变更：新增 ${insertCount} / 修改 ${updateCount} / 删除 ${deleteCount}`
              : "双击单元格编辑（Enter 保存 · Shift+Enter 置 NULL），或点“+ 新增行”"}
          </span>
          <button
            type="button"
            onClick={() => void handleCommit()}
            disabled={pendingCount === 0 || browse.submitting}
            className="ml-auto flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <CheckIcon className="h-3 w-3" />
            {browse.submitting ? "提交中…" : "提交"}
          </button>
          <button
            type="button"
            onClick={() => void handleDiscard()}
            disabled={pendingCount === 0 || browse.submitting}
            className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            放弃
          </button>
        </div>
      )}

      {/* 结果表格（列头点击排序；编辑模式下用可编辑表格；结构子视图展示结构） */}
      <div className="min-h-0 flex-1">
        {subView === "structure" && selectedDb ? (
          <TableStructureView
            connectionId={connectionId}
            driver={driver}
            database={selectedDb}
            schema={driver === "postgresql" ? selectedSchema : null}
            table={browse.table}
            tableType={tableType}
          />
        ) : tab.rowSet ? (
          editMode ? (
            <EditableTable
              rowSet={tab.rowSet}
              connectionId={connectionId}
              pkColumns={browse.pkColumns}
              pendingEdits={browse.pendingEdits}
              onCellEdit={(rowKey, column, value) =>
                browseApplyCellEdit(tab.id, rowKey, column, value)
              }
              onToggleDelete={(rowKey) => browseToggleDelete(tab.id, rowKey)}
              onAddRow={() => browseAddRow(tab.id)}
            />
          ) : (
            <ResultTable
              rowSet={tab.rowSet}
              connectionId={connectionId}
              sort={browse.order}
              onSort={toggleSort}
            />
          )
        ) : (
          <p className="p-4 text-sm text-neutral-500">
            {running ? "加载中…" : "暂无数据"}
          </p>
        )}
      </div>      {tab.queryErrorMsg && (
        <p className="border-t border-neutral-200 px-3 py-1.5 text-xs text-red-600 dark:border-neutral-800 dark:text-red-300">
          {tab.queryErrorMsg}
        </p>
      )}

      {/* 分页器 */}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800">
        <button
          type="button"
          onClick={() => {
            void (async () => {
              if (!(await confirmIfDirty())) return;
              if (pendingCount > 0) browseDiscardEdits(tab.id);
              await browseSetPage(tab.id, browse.page - 1);
            })();
          }}
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
          onClick={() => {
            void (async () => {
              if (!(await confirmIfDirty())) return;
              if (pendingCount > 0) browseDiscardEdits(tab.id);
              await browseSetPage(tab.id, browse.page + 1);
            })();
          }}
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
          onChange={(e) => {
            void (async () => {
              if (!(await confirmIfDirty())) return;
              if (pendingCount > 0) browseDiscardEdits(tab.id);
              await browseSetPageSize(tab.id, Number(e.target.value));
            })();
          }}
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

      {/* CSV 导入对话框（FR-252） */}
      {selectedDb && (
        <ImportCsvDialog
          open={importOpen}
          connectionId={connectionId}
          driver={driver}
          database={selectedDb}
          schema={driver === "postgresql" ? selectedSchema : null}
          table={browse.table}
          tableColumns={importColumns}
          onOpenChange={setImportOpen}
          onImported={() => {
            // 导入成功后刷新当前页（可能回到已有 dirty 时需先确认——导入按钮在编辑模式下已禁用）
          }}
        />
      )}
    </div>
  );
}
