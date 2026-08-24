"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  dbApi,
  translateError,
  type BackupProbeResult,
} from "@/lib/tauri-api";
import { connectionSafetyLine, isReadOnly } from "@/lib/connection-meta";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

interface BackupDialogProps {
  open: boolean;
  connectionId: string;
  driver: "mysql" | "postgresql";
  database: string;
  schema: string | null;
  table: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 官方备份 / 恢复对话框（FR-260）。
 * 与「导入/导出 SQL dump」入口分离；找不到官方工具时直接报错，不回退 dump。
 */
export function BackupDialog({
  open,
  connectionId,
  driver,
  database,
  schema,
  table,
  onOpenChange,
}: BackupDialogProps) {
  const confirm = useConfirmStore((s) => s.confirm);
  const connection = useSessionStore((s) => s.activeConnection);
  const readOnly = isReadOnly(connection);
  const [dumpPath, setDumpPath] = useState("");
  const [clientPath, setClientPath] = useState("");
  const [probe, setProbe] = useState<BackupProbeResult | null>(null);
  const [scopeTable, setScopeTable] = useState(false);
  const [confirmDb, setConfirmDb] = useState("");
  const [running, setRunning] = useState(false);
  const [bytes, setBytes] = useState(0);
  const [queryId, setQueryId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setError(null);
    setBytes(0);
    setConfirmDb("");
    void dbApi
      .probeBackupTools(connectionId, dumpPath || undefined, clientPath || undefined)
      .then(setProbe)
      .catch((e) => setError(translateError(e)));
  }, [open, connectionId, dumpPath, clientPath]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ queryId: string; bytes: number }>("backup:progress", (event) => {
      if (!disposed && event.payload.queryId === queryId) {
        setBytes(event.payload.bytes);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open, queryId]);

  async function runExport() {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = driver === "mysql" ? "sql" : "dump";
    const path = await save({
      title: "官方备份导出",
      defaultPath: `${scopeTable && table ? table : database}.${ext}`,
      filters: [{ name: "官方备份", extensions: [ext] }],
    });
    if (typeof path !== "string") return;
    const preview = probe?.exportPreview ?? "";
    const ok = await confirm({
      title: "执行官方备份导出",
      message: `使用官方工具导出，不会生成 tiny-sql SQL dump。\n\n${preview}\n目标：${path}`,
      confirmText: "导出",
    });
    if (!ok) return;
    const id = crypto.randomUUID();
    setQueryId(id);
    setRunning(true);
    setError(null);
    setMessage(null);
    setBytes(0);
    try {
      const result = await dbApi.backupExport(connectionId, {
        database,
        schema,
        table: scopeTable ? table : null,
        path,
        dumpPath: dumpPath || null,
        queryId: id,
      });
      setMessage(
        `已备份 ${result.bytes} 字节（${result.toolVersion}）`,
      );
    } catch (e) {
      setError(translateError(e));
    } finally {
      setRunning(false);
      setQueryId(null);
    }
  }

  async function runRestore() {
    if (readOnly) {
      setError("该连接已设为应用只读，已拒绝恢复。");
      return;
    }
    if (confirmDb.trim() !== database.trim()) {
      setError("请手输当前数据库名以确认恢复目标");
      return;
    }
    const { open: openFile } = await import("@tauri-apps/plugin-dialog");
    const path = await openFile({
      title: "选择官方备份文件",
      multiple: false,
    });
    if (typeof path !== "string") return;
    const preview = probe?.restorePreview ?? "";
    const ok = await confirm({
      title: "执行官方恢复",
      message: `${connectionSafetyLine(connection)}\n将覆盖目标库「${database}」。\n\n${preview}\n文件：${path}\n\n这不是 SQL dump 导入。`,
      confirmText: "恢复",
      danger: true,
    });
    if (!ok) return;
    const id = crypto.randomUUID();
    setQueryId(id);
    setRunning(true);
    setError(null);
    setMessage(null);
    setBytes(0);
    try {
      const result = await dbApi.backupRestore(connectionId, {
        database,
        confirmDatabase: confirmDb,
        schema,
        path,
        clientPath: clientPath || null,
        queryId: id,
      });
      setMessage(`已恢复 ${result.bytes} 字节（${result.toolVersion}）`);
    } catch (e) {
      setError(translateError(e));
    } finally {
      setRunning(false);
      setQueryId(null);
    }
  }

  async function cancel() {
    if (queryId) {
      try {
        await dbApi.cancelQuery(queryId);
      } catch {
        // 取消失败不覆盖主错误
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>官方备份 / 恢复</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-neutral-500">
          调用本机 mysqldump/mysql 或 pg_dump/pg_restore，经当前连接（含 SSH
          隧道本地端口）。找不到工具不会改用「导出 SQL」。
        </p>
        <Tabs defaultValue="export">
          <TabsList className="grid w-48 grid-cols-2">
            <TabsTrigger value="export">备份</TabsTrigger>
            <TabsTrigger value="restore">恢复</TabsTrigger>
          </TabsList>
          <TabsContent value="export" className="flex flex-col gap-2 pt-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={scopeTable}
                disabled={!table || running}
                onChange={(e) => setScopeTable(e.target.checked)}
              />
              仅当前表{table ? `（${table}）` : "（请先打开一张表）"}
            </label>
            <label className="flex flex-col gap-1 text-xs">
              备份工具路径（可空，默认 PATH）
              <input
                value={dumpPath}
                disabled={running}
                onChange={(e) => setDumpPath(e.target.value)}
                spellCheck={false}
                className="h-7 rounded border border-neutral-300 bg-white px-1.5 font-mono dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <p className="text-xs text-neutral-500">
              {probe?.dump
                ? `已找到：${probe.dump.version}`
                : "未找到备份工具"}
            </p>
            <pre className="overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] dark:border-neutral-800 dark:bg-neutral-950">
              {probe?.exportPreview ?? ""}
            </pre>
            <Button
              type="button"
              disabled={running || !probe?.dump}
              onClick={() => void runExport()}
            >
              {running ? `导出中… ${bytes} 字节` : "选择路径并导出"}
            </Button>
          </TabsContent>
          <TabsContent value="restore" className="flex flex-col gap-2 pt-2">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              恢复会写入目标库。请手输库名「{database}」后才能执行。
            </p>
            <label className="flex flex-col gap-1 text-xs">
              目标库名
              <input
                value={confirmDb}
                disabled={running}
                onChange={(e) => setConfirmDb(e.target.value)}
                spellCheck={false}
                className="h-7 rounded border border-neutral-300 bg-white px-1.5 font-mono dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              恢复工具路径（可空，默认 PATH）
              <input
                value={clientPath}
                disabled={running}
                onChange={(e) => setClientPath(e.target.value)}
                spellCheck={false}
                className="h-7 rounded border border-neutral-300 bg-white px-1.5 font-mono dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <p className="text-xs text-neutral-500">
              {probe?.client
                ? `已找到：${probe.client.version}`
                : "未找到恢复工具"}
            </p>
            <pre className="overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] dark:border-neutral-800 dark:bg-neutral-950">
              {probe?.restorePreview ?? ""}
            </pre>
            <Button
              type="button"
              variant="destructive"
              disabled={
                readOnly ||
                running ||
                !probe?.client ||
                confirmDb.trim() !== database.trim()
              }
              onClick={() => void runRestore()}
            >
              {running ? `恢复中… ${bytes} 字节` : "选择文件并恢复"}
            </Button>
          </TabsContent>
        </Tabs>
        {running && (
          <Button type="button" variant="outline" onClick={() => void cancel()}>
            取消
          </Button>
        )}
        {message && <p className="text-xs text-neutral-600">{message}</p>}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
