"use client";

import { useMemo, useState, type FormEvent } from "react";
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
  buildCreateTableSql,
  isValidDataType,
  validateCreateTable,
  type CreateTableColumnInput,
} from "@/lib/ddl";
import { dbApi, translateError, type DriverKind } from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

/** 双方言常用类型清单（下拉预选；也可自由输入，由白名单格式校验兜底） */
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

/** 默认主键列类型：SQLite 的 AUTOINCREMENT 只认 INTEGER。 */
function defaultIdType(driver: DriverKind): string {
  if (driver === "mysql") return "int";
  if (driver === "sqlite") return "INTEGER";
  return "integer";
}

interface CreateTableDialogProps {
  open: boolean;
  driver: DriverKind;
  database: string;
  schema: string | null;
  onOpenChange: (open: boolean) => void;
}

function emptyColumn(): CreateTableColumnInput {
  return {
    name: "",
    dataType: "",
    nullable: true,
    defaultValue: "",
    primaryKey: false,
    autoIncrement: false,
  };
}

/**
 * 新建表对话框（FR-251）：结构化列编辑 → 双方言 SQL 预览 → 二次确认后执行。
 * 执行成功刷新 schema 树（metadata cache 失效由 refreshMetadata 处理）。
 */
export function CreateTableDialog({
  open,
  driver,
  database,
  schema,
  onOpenChange,
}: CreateTableDialogProps) {
  const refreshMetadata = useSessionStore((s) => s.refreshMetadata);
  const confirm = useConfirmStore((s) => s.confirm);
  const [table, setTable] = useState("");
  const [comment, setComment] = useState("");
  const [columns, setColumns] = useState<CreateTableColumnInput[]>([
    { ...emptyColumn(), name: "id", dataType: defaultIdType(driver), nullable: false, primaryKey: true, autoIncrement: driver !== "postgresql" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeOptions =
    driver === "mysql" ? MYSQL_TYPES : driver === "sqlite" ? SQLITE_TYPES : PG_TYPES;

  const input = useMemo(
    () => ({
      driver,
      database,
      schema,
      table,
      columns,
      comment: driver === "mysql" ? comment : undefined,
    }),
    [driver, database, schema, table, columns, comment],
  );

  const validation = validateCreateTable(input);
  const sqlPreview = useMemo(() => {
    if (validation) return `-- ${validation}`;
    return buildCreateTableSql(input);
  }, [input, validation]);

  function patchColumn(
    index: number,
    patch: Partial<CreateTableColumnInput>,
  ) {
    setColumns((items) =>
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        // 勾选主键强制 NOT NULL；自增列同理
        if (patch.primaryKey === true || patch.autoIncrement === true) {
          next.nullable = false;
        }
        return next;
      }),
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (validation) {
      setError(validation);
      return;
    }
    const sql = buildCreateTableSql(input);
    // 执行 DDL 前必须展示完整 SQL 并二次确认（V4-R06）
    const ok = await confirm({
      title: "执行建表 DDL",
      message: `将在 ${driver === "postgresql" ? (schema ?? "public") : database} 下创建表「${table.trim()}」：\n\n${sql}\n\n确定执行吗？`,
      confirmText: "执行",
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      await dbApi.query(useSessionStore.getState().openId!, sql, {
        allowWrite: true,
      });
      await refreshMetadata();
      onOpenChange(false);
      // 重置表单为初始状态，下次打开是干净的
      setTable("");
      setComment("");
      setColumns([
        { ...emptyColumn(), name: "id", dataType: defaultIdType(driver), nullable: false, primaryKey: true, autoIncrement: driver !== "postgresql" },
      ]);
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
              新建表（{driver === "postgresql" ? (schema ?? "public") : database}）
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="general">
            <TabsList className="grid w-48 grid-cols-2">
              <TabsTrigger value="general">列定义</TabsTrigger>
              <TabsTrigger value="sql">SQL 预览</TabsTrigger>
            </TabsList>

            <TabsContent value="general">
              <div className="flex flex-col gap-3 py-2">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="font-medium">表名:</span>
                    <input
                      autoFocus
                      value={table}
                      onChange={(e) => setTable(e.target.value)}
                      spellCheck={false}
                      className="h-8 w-56 rounded-md border border-neutral-300 bg-white px-2 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-950"
                    />
                  </label>
                  {driver === "mysql" && (
                    <label className="flex items-center gap-2 text-sm">
                      <span className="font-medium">注释:</span>
                      <input
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        spellCheck={false}
                        className="h-8 w-56 rounded-md border border-neutral-300 bg-white px-2 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-950"
                      />
                    </label>
                  )}
                </div>

                {/* 列编辑表格 */}
                <div className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                        <th className="px-2 py-1.5 font-medium">列名</th>
                        <th className="px-2 py-1.5 font-medium">类型</th>
                        <th className="px-2 py-1.5 font-medium">可空</th>
                        <th className="px-2 py-1.5 font-medium">默认值</th>
                        <th className="px-2 py-1.5 font-medium">主键</th>
                        {driver === "mysql" && (
                          <th className="px-2 py-1.5 font-medium">自增</th>
                        )}
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column, index) => (
                        <tr
                          key={index}
                          className="border-b border-neutral-100 dark:border-neutral-800"
                        >
                          <td className="px-1.5 py-1">
                            <input
                              value={column.name}
                              onChange={(e) =>
                                patchColumn(index, { name: e.target.value })
                              }
                              spellCheck={false}
                              className="h-7 w-full rounded border border-neutral-300 bg-white px-1.5 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-950"
                            />
                          </td>
                          <td className="px-1.5 py-1">
                            <input
                              value={column.dataType}
                              onChange={(e) =>
                                patchColumn(index, { dataType: e.target.value })
                              }
                              list={`type-options-${driver}`}
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
                              disabled={column.primaryKey || column.autoIncrement}
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
                            <input
                              type="checkbox"
                              checked={column.primaryKey}
                              onChange={(e) =>
                                patchColumn(index, {
                                  primaryKey: e.target.checked,
                                })
                              }
                            />
                          </td>
                          {driver === "mysql" && (
                            <td className="px-1.5 py-1 text-center">
                              <input
                                type="checkbox"
                                checked={column.autoIncrement}
                                onChange={(e) =>
                                  patchColumn(index, {
                                    autoIncrement: e.target.checked,
                                  })
                                }
                              />
                            </td>
                          )}
                          <td className="px-1.5 py-1 text-center">
                            <button
                              type="button"
                              onClick={() =>
                                setColumns((items) =>
                                  items.filter((_, i) => i !== index),
                                )
                              }
                              disabled={columns.length <= 1}
                              aria-label="删除列"
                              className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950"
                            >
                              <Trash2Icon className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <datalist id={`type-options-${driver}`}>
                    {typeOptions.map((type) => (
                      <option key={type} value={type} />
                    ))}
                  </datalist>
                </div>
                <button
                  type="button"
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
            <Button type="submit" disabled={saving || validation !== null}>
              {saving ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
