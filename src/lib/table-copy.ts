// 表级数据拷贝的列映射（FR-266）。纯函数，不发 IPC。

import { identKey, type SchemaDriver } from "@/lib/schema-diff";

export type CopyMode = "append" | "replace";

export interface ColumnMapping {
  source: string;
  dest: string;
}

/** 按方言名字匹配源列到目标列；未匹配的源列跳过。 */
export function mapColumnsByName(
  sourceColumns: string[],
  destColumns: string[],
  driver: SchemaDriver,
): ColumnMapping[] {
  const destByKey = new Map(
    destColumns.map((name) => [identKey(name, driver), name]),
  );
  const mappings: ColumnMapping[] = [];
  const used = new Set<string>();
  for (const source of sourceColumns) {
    const key = identKey(source, driver);
    const dest = destByKey.get(key);
    if (!dest || used.has(key)) continue;
    used.add(key);
    mappings.push({ source, dest });
  }
  return mappings;
}

/** 把源行投影到映射后的目标列顺序。 */
export function projectCopiedRow(
  sourceColumns: string[],
  row: (string | null)[],
  mapping: ColumnMapping[],
  driver: SchemaDriver,
): (string | null)[] {
  const indexByKey = new Map(
    sourceColumns.map((name, index) => [identKey(name, driver), index]),
  );
  return mapping.map((item) => {
    const index = indexByKey.get(identKey(item.source, driver));
    if (index === undefined) return null;
    return row[index] ?? null;
  });
}

export function copyTargetToken(database: string, table: string): string {
  return `${database.trim()}.${table.trim()}`;
}
