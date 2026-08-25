"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  buildAlterTableSql,
  buildAlterTableStatements,
  isValidDataType,
  validateAlterTable,
  type AlterColumnInput,
} from "@/lib/ddl";
import {
  dbApi,
  translateError,
  type ColumnMeta,
  type DriverKind,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

const MYSQL_TYPES = [
  "int",
  "bigint",
  "varchar(255)",
  "text",
  "decimal(10, 2)",
  "datetime",
  "timestamp",
  "date",
  "json",
  "tinyint(1)",
];

const PG_TYPES = [
  "integer",
  "bigint",
  "character varying(255)",
  "text",
  "numeric(10, 2)",
  "timestamp without time zone",
  "timestamp with time zone",
  "date",
  "boolean",
  "jsonb",
];

/** SQLite 只有 5 种存储类别，这里给常用的声明类型（亲和性由声明名推导） */
const SQLITE_TYPES = [
  "INTEGER",
  "TEXT",
  "REAL",
  "NUMERIC",
  "BLOB",
  "BOOLEAN",
  "DATETIME",
  "DATE",
];

function emptyColumn(): AlterColumnInput {
  return {
    originName: null,
    name: "",
    dataType: "",
    nullable: true,
    defaultValue: "",
  };
}

function fromMeta(column: ColumnMeta): AlterColumnInput {
  return {
    originName: column.name,
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    defaultValue: column.defaultValue ?? "",
  };
}

interface AlterTableDialogProps {
  open: boolean;
  driver: DriverKind;
  database: string;
  schema: string | null;
  table: string;
  original: ColumnMeta[];
  onOpenChange: (open: boolean) => void;
  /** 执行成功后刷新结构页与 schema 树 */
  onApplied: () => Promise<void>;
}

/**
 * 修改表对话框（FR-253）：回填现有列 → 双方言 ALTER 预览 → 二次确认后逐条执行。
 * 不改主键；非主键列可 RENAME COLUMN。失败保留表单。
 */
export function AlterTableDialog({
  open,
  driver,
  database,
  schema,
  table,
  original,
  onOpenChange,
  onApplied,
}: AlterTableDialogProps) {
  const confirm = useConfirmStore((s) => s.confirm);
  const [columns, setColumns] = useState<AlterColumnInput[]>(() =>
    original.map(fromMeta),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setColumns(original.map(fromMeta));
    setError(null);
    setSaving(false);
  }, [open, original]);

  const typeOptions =
    driver === "mysql" ? MYSQL_TYPES : driver === "sqlite" ? SQLITE_TYPES : PG_TYPES;
  const pkNames = useMemo(
    () =>
      new Set(
        original
          .filter((column) => column.columnKey === "PRI")
          .map((column) => column.name.toLowerCase()),
      ),
    [original],
  );

  const input = useMemo(
    () => ({
      driver,
      database,
      schema,
      table,
      original,
      columns,
    }),
    [driver, database, schema, table, original, columns],
  );

  const validation = validateAlterTable(input);
  const statements = useMemo(
    () => (validation ? [] : buildAlterTableStatements(input)),
    [input, validation],
  );
  const sqlPreview = validation
    ? `-- ${validation}`
    : statements.length === 0
      ? "-- 没有结构变更"
      : statements
          .map((item) => (item.dangerous ? `${item.sql}  -- 危险` : item.sql))
          .join("\n");

  function patchColumn(index: number, patch: Partial<AlterColumnInput>) {
    setColumns((items) =>
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  function isPrimary(column: AlterColumnInput): boolean {
    const key = (column.originName ?? column.name).trim().toLowerCase();
    return pkNames.has(key);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (validation) {
      setError(validation);
      return;
    }
    if (statements.length === 0) {
      setError("没有结构变更");
      return;
    }
    const sql = buildAlterTableSql(input);
    const ok = await confirm({
      title: "执行改表 DDL",
      message: `将修改表「${table}」：\n\n${sql}\n\n确定执行吗？`,
      confirmText: "执行",
      danger: statements.some((item) => item.dangerous),
    });
    if (!ok) return;
    const openId = useSessionStore.getState().openId;
    if (!openId) {
      setError("当前没有打开的连接");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      for (const statement of statements) {
        await dbApi.query(openId, statement.sql, {
          allowWrite: true,
          schema,
        });
      }
      await onApplied();
      onOpenChange(false);
    } catch (err) {
      setError(translateError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={false}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              修改表 {table}（
              {driver === "postgresql" ? (schema ?? "public") : database}）
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="general">
            <TabsList className="grid w-48 grid-cols-2">
              <TabsTrigger value="general">列定义</TabsTrigger>
              <TabsTrigger value="sql">SQL 预览</TabsTrigger>
            </TabsList>

            <TabsContent value="general">
              <div className="flex flex-col gap-3 py-2">
                <p className="text-xs text-neutral-500">
                  不能重命名或删除主键列；危险变更会在预览里单独成条。
                </p>
                <div className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                        <th className="px-2 py-1.5 font-medium">列名</th>
                        <th className="px-2 py-1.5 font-medium">类型</th>
                        <th className="px-2 py-1.5 font-medium">可空</th>
                        <th className="px-2 py-1.5 font-medium">默认值</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column, index) => {
                        const primary = isPrimary(column);
                        const existing = column.originName !== null;
                        return (
                          <tr
                            key={column.originName ?? `new-${index}`}
                            className="border-b border-neutral-100 dark:border-neutral-800"
                          >
                            <td className="px-1.5 py-1">
                              <input
                                value={column.name}
                                disabled={existing || saving}
                                onChange={(e) =>
                                  patchColumn(index, { name: e.target.value })
                                }
                                spellCheck={false}
                                className="h-7 w-full rounded border border-neutral-300 bg-white px-1.5 outline-none focus:border-blue-500 disabled:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <input
                                value={column.dataType}
                                disabled={saving}
                                onChange={(e) =>
                                  patchColumn(index, {
                                    dataType: e.target.value,
                                  })
                                }
                                list={`alter-type-options-${driver}`}
                                spellCheck={false}
                                className={`h-7 w-full rounded border bg-white px-1.5 font-mono outline-none focus:border-blue-500 dark:bg-neutral-950 ${
                                  column.dataType &&
                                  !isValidDataType(column.dataType)
                                    ? "border-red-400 dark:border-red-600"
                                    : "border-neutral-300 dark:border-neutral-700"
                                }`}
                              />
                            </td>
                            <td className="px-1.5 py-1 text-center">
                              <input
                                type="checkbox"
                                checked={column.nullable}
                                disabled={primary || saving}
                                onChange={(e) =>
                                  patchColumn(index, {
                                    nullable: e.target.checked,
                                  })
                                }
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <input
                                value={column.defaultValue}
                                disabled={saving}
                                onChange={(e) =>
                                  patchColumn(index, {
                                    defaultValue: e.target.value,
                                  })
                                }
                                placeholder="表达式原样使用"
                                spellCheck={false}
                                className="h-7 w-full rounded border border-neutral-300 bg-white px-1.5 font-mono outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-950"
                              />
                            </td>
                            <td className="px-1.5 py-1 text-center">
                              <button
                                type="button"
                                onClick={() =>
                                  setColumns((items) =>
                                    items.filter((_, i) => i !== index),
                                  )
                                }
                                disabled={primary || saving || columns.length <= 1}
                                aria-label="删除列"
                                className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950"
                              >
                                <Trash2Icon className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <datalist id={`alter-type-options-${driver}`}>
                    {typeOptions.map((type) => (
                      <option key={type} value={type} />
                    ))}
                  </datalist>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    setColumns((items) => [...items, emptyColumn()])
                  }
                  className="flex w-fit items-center gap-1 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  添加列
                </button>
              </div>
            </TabsContent>

            <TabsContent value="sql">
              <pre className="min-h-36 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs leading-5 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
                {sqlPreview}
              </pre>
            </TabsContent>
          </Tabs>

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
              取消
            </Button>
            <Button
              type="submit"
              disabled={saving || validation !== null || statements.length === 0}
            >
              {saving ? "执行中…" : "执行变更"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
