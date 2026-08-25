"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  dbApi,
  translateError,
  type ColumnMeta,
  type CsvPreview,
  type DriverKind,
} from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

interface ImportCsvDialogProps {
  open: boolean;
  connectionId: string;
  driver: DriverKind;
  database: string;
  schema: string | null;
  table: string;
  /** 目标表列（列映射下拉选项） */
  tableColumns: ColumnMeta[];
  onOpenChange: (open: boolean) => void;
  /** 导入成功后刷新浏览数据 */
  onImported: () => void;
}

/**
 * CSV 导入对话框（FR-252）：选文件 → 预览 → 列映射 → 错误策略 → 执行。
 *
 * 空值语义与导出闭环：无引号 NULL → SQL NULL；"" → 空串。值不做类型推断，
 * 统一文本由数据库隐式转换；失败行按数据行号（不含表头）报告。
 */
export function ImportCsvDialog({
  open,
  connectionId,
  driver,
  database,
  schema,
  table,
  tableColumns,
  onOpenChange,
  onImported,
}: ImportCsvDialogProps) {
  const browseRefresh = useSessionStore((s) => s.browseRefresh);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const [path, setPath] = useState<string | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [skipErrors, setSkipErrors] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inserted: number;
    failedRows: number[];
  } | null>(null);

  // 打开时重置
  useEffect(() => {
    if (open) {
      setPath(null);
      setPreview(null);
      setMapping([]);
      setHasHeader(true);
      setSkipErrors(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  /** 默认映射：CSV 列名与表列同名自动匹配（大小写不敏感） */
  const defaultMapping = useMemo(() => {
    if (!preview) return [];
    const known = new Map(
      tableColumns.map((c) => [c.name.toLowerCase(), c.name]),
    );
    return preview.headers.map((header) => {
      if (!hasHeader) return null;
      return known.get(header.trim().toLowerCase()) ?? null;
    });
  }, [preview, tableColumns, hasHeader]);

  useEffect(() => {
    if (preview) setMapping(defaultMapping);
  }, [preview, defaultMapping]);

  const mappedCount = mapping.filter((m) => m !== null).length;

  async function pickFile() {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openDialog({
      title: "选择 CSV 文件",
      filters: [{ name: "CSV", extensions: ["csv", "txt"] }],
      multiple: false,
    });
    if (typeof selected !== "string") return;
    setPath(selected);
    setError(null);
    setResult(null);
    try {
      const data = await dbApi.csvImportPreview(selected, hasHeader, 100);
      setPreview(data);
    } catch (e) {
      setError(translateError(e));
      setPreview(null);
    }
  }

  async function reloadPreview(nextHasHeader: boolean) {
    setHasHeader(nextHasHeader);
    if (!path) return;
    try {
      const data = await dbApi.csvImportPreview(path, nextHasHeader, 100);
      setPreview(data);
    } catch (e) {
      setError(translateError(e));
    }
  }

  async function runImport() {
    if (!path || !preview || mappedCount === 0) return;
    setImporting(true);
    setError(null);
    try {
      const imported = await dbApi.importCsv(connectionId, {
        database,
        schema: driver === "postgresql" ? schema : null,
        table,
        path,
        mapping,
        hasHeader,
        skipErrors,
      });
      setResult(imported);
      onImported();
      if (activeTabId) void browseRefresh(activeTabId);
    } catch (e) {
      setError(translateError(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>导入 CSV 到 {table}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={pickFile}>
              选择文件…
            </Button>
            {path && (
              <span className="min-w-0 truncate font-mono text-xs text-neutral-500">
                {path}
              </span>
            )}
          </div>

          {preview && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => void reloadPreview(e.target.checked)}
                />
                首行是表头（{preview.totalRows} 行数据待导入）
              </label>

              {/* 列映射 */}
              <div className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                      <th className="px-2 py-1.5 font-medium">CSV 列</th>
                      <th className="px-2 py-1.5 font-medium">示例值</th>
                      <th className="px-2 py-1.5 font-medium">导入到表列</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.headers.map((header, index) => (
                      <tr
                        key={index}
                        className="border-b border-neutral-100 dark:border-neutral-800"
                      >
                        <td className="px-2 py-1 font-medium">
                          {hasHeader ? header : `第 ${index + 1} 列`}
                        </td>
                        <td className="max-w-40 truncate px-2 py-1 font-mono text-neutral-500">
                          {preview.rows[0]?.[index] ?? (
                            <span className="italic">NULL</span>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={mapping[index] ?? ""}
                            onChange={(e) =>
                              setMapping((items) =>
                                items.map((item, i) =>
                                  i === index
                                    ? e.target.value || null
                                    : item,
                                ),
                              )
                            }
                            className="h-7 rounded border border-neutral-300 bg-white px-1.5 dark:border-neutral-700 dark:bg-neutral-950"
                          >
                            <option value="">（跳过）</option>
                            {tableColumns.map((column) => (
                              <option key={column.name} value={column.name}>
                                {column.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={skipErrors}
                  onChange={(e) => setSkipErrors(e.target.checked)}
                />
                跳过失败行继续导入（默认任一行失败即整体停止并回滚该批）
              </label>
            </>
          )}

          {result && (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              导入完成：成功 {result.inserted} 行
              {result.failedRows.length > 0 &&
                `，失败 ${result.failedRows.length} 行（行号：${result.failedRows.slice(0, 20).join("、")}${result.failedRows.length > 20 ? "…" : ""}）`}
            </p>
          )}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            关闭
          </Button>
          <Button
            type="button"
            onClick={() => void runImport()}
            disabled={!preview || mappedCount === 0 || importing}
          >
            {importing ? "导入中…" : `导入 ${preview?.totalRows ?? 0} 行`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
