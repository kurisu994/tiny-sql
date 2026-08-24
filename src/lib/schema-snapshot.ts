// 拉取单个连接上的结构快照（FR-220）。视图排除在外。

import { baseTablesOnly, type SchemaDriver, type SchemaSnapshot, type TableSnapshot } from "@/lib/schema-diff";
import { dbApi } from "@/lib/tauri-api";

async function mapPool<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    results.push(...(await Promise.all(chunk.map(mapper))));
  }
  return results;
}

/** 拉取 BASE TABLE 的列 / 索引 / 约束快照 */
export async function loadSchemaSnapshot(input: {
  connectionId: string;
  connectionName: string;
  driver: SchemaDriver;
  database: string;
  schema: string | null;
}): Promise<SchemaSnapshot> {
  const tables = baseTablesOnly(
    await dbApi.listTables(input.connectionId, input.database, input.schema),
  );
  const snapshots: TableSnapshot[] = await mapPool(tables, 6, async (table) => {
    const [columns, indexes, constraints] = await Promise.all([
      dbApi.listColumns(input.connectionId, input.database, input.schema, table.name),
      dbApi.listIndexes(input.connectionId, input.database, input.schema, table.name),
      dbApi.listConstraints(input.connectionId, input.database, input.schema, table.name),
    ]);
    return {
      name: table.name,
      comment: table.comment,
      columns,
      indexes,
      constraints,
    };
  });
  return {
    driver: input.driver,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    database: input.database,
    schema: input.schema,
    capturedAt: new Date().toISOString(),
    tables: snapshots,
  };
}
