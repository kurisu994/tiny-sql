"use client";

import { useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildCreateIndexSql,
  buildDropIndexSql,
  validateCreateIndex,
} from "@/lib/ddl";
import { dbApi, translateError, type ColumnMeta, type IndexMeta } from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

interface IndexDesignerDialogProps {
  open: boolean;
  driver: "mysql" | "postgresql";
  database: string;
  schema: string | null;
  table: string;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  onOpenChange: (open: boolean) => void;
  onApplied: () => Promise<void>;
}

/**
 * 索引设计器（FR-253）：新建普通/唯一索引，或删除非主键索引。
 * 每条语句预览确认后走现有 db_query。
 */
export function IndexDesignerDialog({
  open,
  driver,
  database,
  schema,
  table,
  columns,
  indexes,
  onOpenChange,
  onApplied,
}: IndexDesignerDialogProps) {
  const confirm = useConfirmStore((s) => s.confirm);
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = useMemo(
    () => ({
      driver,
      database,
      schema,
      table,
      name,
      columns: selected,
      unique,
    }),
    [driver, database, schema, table, name, selected, unique],
  );
  const validation = validateCreateIndex(input);
  const sqlPreview = validation ? `-- ${validation}` : buildCreateIndexSql(input);
  const droppable = indexes.filter((index) => index.indexType !== "PRIMARY");

  function toggleColumn(column: string) {
    setSelected((items) =>
      items.includes(column)
        ? items.filter((item) => item !== column)
        : [...items, column],
    );
  }

  async function runSql(sql: string) {
    const openId = useSessionStore.getState().openId;
    if (!openId) {
      setError("当前没有打开的连接");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      await dbApi.query(openId, sql, { allowWrite: true, schema });
      await onApplied();
      return true;
    } catch (err) {
      setError(translateError(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (validation) {
      setError(validation);
      return;
    }
    const sql = buildCreateIndexSql(input);
    const ok = await confirm({
      title: "创建索引",
      message: `将在表「${table}」上创建索引：\n\n${sql}\n\n确定执行吗？`,
      confirmText: "执行",
    });
    if (!ok) return;
    const applied = await runSql(sql);
    if (applied) {
      setName("");
      setUnique(false);
      setSelected([]);
    }
  }

  async function onDrop(index: IndexMeta) {
    const sql = buildDropIndexSql({
      driver,
      database,
      schema,
      table,
      name: index.name,
    });
    const ok = await confirm({
      title: "删除索引",
      message: `将删除索引「${index.name}」：\n\n${sql}\n\n确定执行吗？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await runSql(sql);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>索引（{table}）</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
              现有索引
            </p>
            {droppable.length === 0 ? (
              <p className="text-xs text-neutral-400">（没有可删除的非主键索引）</p>
            ) : (
              <ul className="max-h-36 overflow-auto rounded border border-neutral-200 text-xs dark:border-neutral-800">
                {droppable.map((index) => (
                  <li
                    key={index.name}
                    className="flex items-center justify-between gap-2 border-b border-neutral-100 px-2 py-1.5 last:border-0 dark:border-neutral-800"
                  >
                    <span className="min-w-0 truncate font-mono">
                      {index.name}
                      <span className="ml-1 text-neutral-400">
                        ({index.columns.join(", ")})
                        {index.unique ? " UNIQUE" : ""}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={saving}
                      onClick={() => void onDrop(index)}
                    >
                      删除
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
              新建索引
            </p>
            <label className="flex items-center gap-2 text-xs">
              <span className="w-12">名称</span>
              <input
                value={name}
                disabled={saving}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                className="h-7 flex-1 rounded border border-neutral-300 bg-white px-1.5 font-mono outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={unique}
                disabled={saving}
                onChange={(e) => setUnique(e.target.checked)}
              />
              唯一索引
            </label>
            <div className="flex flex-wrap gap-2">
              {columns.map((column) => (
                <label
                  key={column.name}
                  className="flex items-center gap-1 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(column.name)}
                    disabled={saving}
                    onChange={() => toggleColumn(column.name)}
                  />
                  {column.name}
                </label>
              ))}
            </div>
            <pre className="overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] dark:border-neutral-800 dark:bg-neutral-950">
              {sqlPreview}
            </pre>
          </div>

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
              disabled={saving}
            >
              关闭
            </Button>
            <Button type="submit" disabled={saving || validation !== null}>
              {saving ? "执行中…" : "创建索引"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
