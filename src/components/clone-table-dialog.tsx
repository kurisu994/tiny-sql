"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildCloneTableSql, cloneConfirmToken, isSafeTableName } from "@/lib/clone-table";
import { connectionSafetyLine, isReadOnly } from "@/lib/connection-meta";
import { dbApi, translateError, type StoredConnection } from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

/**
 * 同库复制为新表（FR-272）：预览 CREATE，可选再灌数据。
 */
export function CloneTableDialog({
  open,
  connection,
  database,
  schema,
  sourceTable,
  onOpenChange,
}: {
  open: boolean;
  connection: StoredConnection;
  database: string;
  schema: string | null;
  sourceTable: string;
  onOpenChange: (open: boolean) => void;
}) {
  const confirm = useConfirmStore((s) => s.confirm);
  const refreshMetadata = useSessionStore((s) => s.refreshMetadata);
  const [destTable, setDestTable] = useState(`${sourceTable}_copy`);
  const [copyData, setCopyData] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState("");
  const [sql, setSql] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const expected = cloneConfirmToken(database, destTable);

  useEffect(() => {
    if (!open) return;
    setDestTable(`${sourceTable}_copy`);
    setConfirmTarget("");
    setCopyData(false);
  }, [open, sourceTable]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      if (!isSafeTableName(destTable) || destTable === sourceTable) {
        setSql(null);
        return;
      }
      try {
        const [columns, constraints, indexes] = await Promise.all([
          dbApi.listColumns(connection.id, database, schema, sourceTable),
          dbApi.listConstraints(connection.id, database, schema, sourceTable),
          dbApi.listIndexes(connection.id, database, schema, sourceTable),
        ]);
        if (cancelled) return;
        setSql(
          buildCloneTableSql({
            driver: connection.driver,
            database,
            schema,
            sourceTable,
            destTable,
            columns,
            constraints,
            indexes,
          }),
        );
        setNote(
          connection.driver === "mysql"
            ? "MySQL：CREATE TABLE … LIKE 会复制列与索引，不含数据。"
            : "PostgreSQL：由元数据重建 DDL（非服务端原文），不含数据。",
        );
      } catch (e) {
        if (!cancelled) setError(translateError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connection, database, schema, sourceTable, destTable]);

  async function run() {
    if (!sql || confirmTarget.trim() !== expected || isReadOnly(connection)) return;
    const ok = await confirm({
      title: "复制为新表",
      message: `${connectionSafetyLine(connection)}\n${sql}${copyData ? "\n建完后追加拷贝源表数据。" : ""}`,
      confirmText: "创建",
      danger: false,
    });
    if (!ok) return;
    setError(null);
    try {
      await dbApi.query(connection.id, sql, { allowWrite: true });
      if (copyData) {
        await dbApi.copyTableRows({
          source: { id: connection.id, database, schema, table: sourceTable },
          dest: { id: connection.id, database, schema, table: destTable },
          mode: "append",
          confirmTarget: expected,
        });
      }
      await refreshMetadata();
      onOpenChange(false);
    } catch (e) {
      setError(translateError(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>复制为新表</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-xs">
          <p className="text-neutral-500">
            源表 {database}.{sourceTable} → 同连接同库新表
          </p>
          <label>
            新表名
            <input
              value={destTable}
              onChange={(e) => setDestTable(e.target.value)}
              className="ml-1 h-7 rounded border px-1 font-mono dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label>
            手输目标 {expected}
            <input
              value={confirmTarget}
              onChange={(e) => setConfirmTarget(e.target.value)}
              className="ml-1 h-7 rounded border px-1 font-mono dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={copyData}
              onChange={(e) => setCopyData(e.target.checked)}
            />
            建完后拷贝数据（追加）
          </label>
          {note && <p className="text-neutral-500">{note}</p>}
          <pre className="max-h-48 overflow-auto rounded border bg-neutral-50 p-2 font-mono dark:border-neutral-800 dark:bg-neutral-950">
            {sql ?? "表名不合法或与源表相同"}
          </pre>
          {error && <p className="text-red-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={
              !sql ||
              confirmTarget.trim() !== expected ||
              isReadOnly(connection)
            }
            onClick={() => void run()}
          >
            预览并创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
