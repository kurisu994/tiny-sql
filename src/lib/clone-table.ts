// 同库复制为新表（FR-272）。

import { buildPostgresCreateTablePreview } from "@/lib/ddl";
import { copyTargetToken } from "@/lib/table-copy";
import type { ColumnMeta, ConstraintMeta, DriverKind, IndexMeta } from "@/lib/tauri-api";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteMysqlIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export function isSafeTableName(name: string): boolean {
  return IDENT.test(name.trim());
}

/** MySQL LIKE；PG 用结构重建并改名（非服务端原文）。 */
export function buildCloneTableSql(input: {
  driver: DriverKind;
  database: string;
  schema?: string | null;
  sourceTable: string;
  destTable: string;
  columns?: ColumnMeta[];
  constraints?: ConstraintMeta[];
  indexes?: IndexMeta[];
}): string | null {
  const source = input.sourceTable.trim();
  const dest = input.destTable.trim();
  if (!isSafeTableName(source) || !isSafeTableName(dest) || source === dest) {
    return null;
  }
  if (input.driver === "mysql") {
    return `CREATE TABLE ${quoteMysqlIdent(dest)} LIKE ${quoteMysqlIdent(source)};`;
  }
  const schema = input.schema?.trim() || "public";
  if (!isSafeTableName(schema) || !input.columns) return null;
  return buildPostgresCreateTablePreview(
    schema,
    dest,
    input.columns,
    input.constraints ?? [],
    input.indexes ?? [],
  );
}

export function cloneConfirmToken(database: string, table: string): string {
  return copyTargetToken(database, table);
}
