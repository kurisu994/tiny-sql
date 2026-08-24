"use client";

import { useEffect, useState } from "react";

import { AlterTableDialog } from "@/components/alter-table-dialog";
import { IndexDesignerDialog } from "@/components/index-designer-dialog";
import { Button } from "@/components/ui/button";
import { buildDropConstraintSql, buildPostgresCreateTablePreview } from "@/lib/ddl";
import {
  dbApi,
  translateError,
  type ColumnMeta,
  type ConstraintMeta,
  type IndexMeta,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore } from "@/stores/session-store";

/** 表结构数据：列定义 + 索引 + 约束 + DDL 预览文本 */
interface StructureData {
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  constraints: ConstraintMeta[];
  ddl: string;
  /** PostgreSQL 的 DDL 是元数据拼装预览，需要向用户明示 */
  ddlIsRebuild: boolean;
}

/**
 * 表结构详情视图（FR-251）：列定义 / 索引 / 约束整合展示 + DDL 只读预览。
 *
 * - MySQL：DDL 走后端 `SHOW CREATE TABLE` 服务端原文；
 * - PostgreSQL：DDL 由已加载 metadata 拼装（重建预览，非服务端原文）。
 */
export function TableStructureView({
  connectionId,
  driver,
  database,
  schema,
  table,
  tableType = "BASE TABLE",
}: {
  connectionId: string;
  driver: "mysql" | "postgresql";
  database: string;
  /** MySQL 忽略 */
  schema: string | null;
  table: string;
  /** VIEW 只读，不提供改表 / 索引设计器 */
  tableType?: string;
}) {
  const [data, setData] = useState<StructureData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [alterOpen, setAlterOpen] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const refreshMetadata = useSessionStore((s) => s.refreshMetadata);
  const confirm = useConfirmStore((s) => s.confirm);
  const isView = tableType.toUpperCase().includes("VIEW");

  async function reloadStructure() {
    await refreshMetadata();
    setReloadToken((n) => n + 1);
  }

  async function dropConstraint(constraint: ConstraintMeta) {
    if (constraint.constraintType === "PRIMARY KEY") return;
    const sql = buildDropConstraintSql({
      driver,
      database,
      schema,
      table,
      name: constraint.name,
      constraintType: constraint.constraintType,
    });
    const ok = await confirm({
      title: "删除约束",
      message: `将删除约束「${constraint.name}」：\n\n${sql}\n\n确定执行吗？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await dbApi.query(connectionId, sql, { allowWrite: true, schema });
      await reloadStructure();
    } catch (e) {
      setError(translateError(e));
    }
  }

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    void (async () => {
      try {
        const [columns, indexes, constraints] = await Promise.all([
          dbApi.listColumns(connectionId, database, schema, table),
          dbApi.listIndexes(connectionId, database, schema, table),
          dbApi.listConstraints(connectionId, database, schema, table),
        ]);
        let ddl: string;
        if (driver === "mysql") {
          const quoted = `\`${database.replace(/`/g, "``")}\`.\`${table.replace(/`/g, "``")}\``;
          const result = await dbApi.query(connectionId, `SHOW CREATE TABLE ${quoted}`);
          // SHOW CREATE TABLE 返回 (Table, Create Table) 两列一行
          ddl = result.rows[0]?.[1] ?? "";
        } else {
          ddl = buildPostgresCreateTablePreview(
            schema ?? "public",
            table,
            columns,
            constraints,
            indexes,
          );
        }
        if (!cancelled) {
          setData({
            columns,
            indexes,
            constraints,
            ddl,
            ddlIsRebuild: driver === "postgresql",
          });
        }
      } catch (e) {
        if (!cancelled) setError(translateError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, driver, database, schema, table, reloadToken]);

  if (error) {
    return (
      <p className="p-4 text-sm text-red-600 dark:text-red-300">{error}</p>
    );
  }
  if (!data) {
    return <p className="p-4 text-sm text-neutral-500">加载结构…</p>;
  }

  return (
    <div className="h-full overflow-auto p-3 text-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-neutral-500">
          {isView ? "视图（只读结构，不能改表或改索引）" : tableType}
        </p>
        {!isView && (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setIndexOpen(true)}>
              索引
            </Button>
            <Button type="button" size="sm" onClick={() => setAlterOpen(true)}>
              修改表
            </Button>
          </div>
        )}
      </div>
      <AlterTableDialog
        open={alterOpen}
        driver={driver}
        database={database}
        schema={schema}
        table={table}
        original={data.columns}
        onOpenChange={setAlterOpen}
        onApplied={reloadStructure}
      />
      <IndexDesignerDialog
        open={indexOpen}
        driver={driver}
        database={database}
        schema={schema}
        table={table}
        columns={data.columns}
        indexes={data.indexes}
        onOpenChange={setIndexOpen}
        onApplied={reloadStructure}
      />
      {/* 列定义 */}
      <Section title={`列（${data.columns.length}）`}>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-700">
              <Th>名称</Th>
              <Th>类型</Th>
              <Th>可空</Th>
              <Th>默认值</Th>
              <Th>注释</Th>
            </tr>
          </thead>
          <tbody>
            {data.columns.map((column) => (
              <tr
                key={column.name}
                className="border-b border-neutral-100 dark:border-neutral-800"
              >
                <Td className="font-medium">
                  {column.name}
                  {column.columnKey === "PRI" && (
                    <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                      PK
                    </span>
                  )}
                </Td>
                <Td className="font-mono">{column.dataType}</Td>
                <Td>{column.nullable ? "是" : "否"}</Td>
                <Td className="font-mono">{column.defaultValue ?? "—"}</Td>
                <Td className="text-neutral-500">{column.comment ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 索引 */}
      <Section title={`索引（${data.indexes.length}）`}>
        {data.indexes.length === 0 ? (
          <p className="text-neutral-400">（无索引）</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-700">
                <Th>名称</Th>
                <Th>列</Th>
                <Th>类型</Th>
                <Th>唯一</Th>
              </tr>
            </thead>
            <tbody>
              {data.indexes.map((index) => (
                <tr
                  key={index.name}
                  className="border-b border-neutral-100 dark:border-neutral-800"
                >
                  <Td className="font-medium">{index.name}</Td>
                  <Td className="font-mono">{index.columns.join(", ")}</Td>
                  <Td>{index.indexType}</Td>
                  <Td>{index.unique ? "是" : "否"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* 约束 */}
      <Section title={`约束（${data.constraints.length}）`}>
        {data.constraints.length === 0 ? (
          <p className="text-neutral-400">（无约束）</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-700">
                <Th>名称</Th>
                <Th>类型</Th>
                <Th>列</Th>
                <Th>引用 / 定义</Th>
                {!isView && <Th />}
              </tr>
            </thead>
            <tbody>
              {data.constraints.map((constraint) => (
                <tr
                  key={constraint.name}
                  className="border-b border-neutral-100 dark:border-neutral-800"
                >
                  <Td className="font-medium">{constraint.name}</Td>
                  <Td>{constraint.constraintType}</Td>
                  <Td className="font-mono">{constraint.columns.join(", ")}</Td>
                  <Td className="font-mono text-neutral-500">
                    {constraint.reference ?? ""}
                  </Td>
                  {!isView && (
                    <Td>
                      {constraint.constraintType !== "PRIMARY KEY" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => void dropConstraint(constraint)}
                        >
                          删除
                        </Button>
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* DDL 预览 */}
      <Section title="建表 DDL">
        {data.ddlIsRebuild && (
          <p className="mb-1.5 text-amber-600 dark:text-amber-300">
            PostgreSQL DDL 由元数据重建（预览用，非服务端原文）
          </p>
        )}
        <pre className="overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono whitespace-pre-wrap dark:border-neutral-700 dark:bg-neutral-900">
          {data.ddl || "（无 DDL）"}
        </pre>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 font-medium text-neutral-700 dark:text-neutral-300">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-2 py-1 font-medium">{children}</th>;
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-2 py-1 ${className ?? ""}`}>{children}</td>;
}
