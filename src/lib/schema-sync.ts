// 由结构 diff 生成可审阅同步 SQL（FR-261）。
// 方向：把 target 改成与 source 一致。不做数据拷贝 / RENAME / 换主键。

import {
  buildAlterTableStatements,
  buildCreateIndexSql,
  buildCreateTableSql,
  buildDropConstraintSql,
  buildDropIndexSql,
  validateAlterTable,
  validateCreateTable,
  type AlterColumnInput,
} from "@/lib/ddl";
import { identKey, type SchemaDiffResult, type SchemaDriver, type TableSnapshot } from "@/lib/schema-diff";

export type SyncDirection = "toRight" | "toLeft";

export interface SyncStatement {
  sql: string;
  dangerous: boolean;
}

function quoteIdent(driver: SchemaDriver, name: string): string {
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTable(
  driver: SchemaDriver,
  database: string,
  schema: string | null,
  table: string,
): string {
  if (driver === "mysql") {
    return `${quoteIdent(driver, database)}.${quoteIdent(driver, table)}`;
  }
  // SQLite 没有 schema 层级，限定的是 ATTACH 名（主库 main），不是 public
  if (driver === "sqlite") {
    return `${quoteIdent(driver, database || "main")}.${quoteIdent(driver, table)}`;
  }
  return `${quoteIdent(driver, schema || "public")}.${quoteIdent(driver, table)}`;
}

function findTable(tables: TableSnapshot[], name: string, driver: SchemaDriver): TableSnapshot | undefined {
  return tables.find((table) => identKey(table.name, driver) === identKey(name, driver));
}

/**
 * 生成结构同步语句。跨 driver 返回错误文案。
 */
export function buildSyncStatements(
  diff: SchemaDiffResult,
  direction: SyncDirection,
): { error: string | null; statements: SyncStatement[] } {
  if (diff.crossDriver) {
    return { error: "方言不同，不能生成可执行同步脚本", statements: [] };
  }
  const source = direction === "toRight" ? diff.left : diff.right;
  const target = direction === "toRight" ? diff.right : diff.left;
  const driver = target.driver;
  const statements: SyncStatement[] = [];

  for (const tableDiff of diff.tables) {
    const sourceTable = findTable(source.tables, tableDiff.name, driver);
    const targetTable = findTable(target.tables, tableDiff.name, driver);

    if (sourceTable && !targetTable) {
      const input = {
        driver,
        database: target.database,
        schema: target.schema,
        table: sourceTable.name,
        columns: sourceTable.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          defaultValue: column.defaultValue ?? "",
          primaryKey: column.columnKey === "PRI",
          autoIncrement: false,
        })),
        comment: sourceTable.comment ?? undefined,
      };
      if (validateCreateTable(input)) {
        statements.push({
          sql: `-- 跳过 CREATE TABLE ${sourceTable.name}：类型无法安全生成`,
          dangerous: false,
        });
      } else {
        statements.push({ sql: buildCreateTableSql(input), dangerous: false });
      }
      continue;
    }

    if (!sourceTable && targetTable) {
      statements.push({
        sql: `DROP TABLE ${qualifiedTable(driver, target.database, target.schema, targetTable.name)};`,
        dangerous: true,
      });
      continue;
    }

    if (!sourceTable || !targetTable || tableDiff.status !== "changed") continue;

    const desired: AlterColumnInput[] = sourceTable.columns.map((column) => {
      const origin = targetTable.columns.find(
        (item) => identKey(item.name, driver) === identKey(column.name, driver),
      );
      return {
        originName: origin?.name ?? null,
        name: origin?.name ?? column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        defaultValue: column.defaultValue ?? "",
      };
    });
    const alterInput = {
      driver,
      database: target.database,
      schema: target.schema,
      table: targetTable.name,
      original: targetTable.columns,
      columns: desired,
    };
    if (!validateAlterTable(alterInput)) {
      for (const item of buildAlterTableStatements(alterInput)) {
        statements.push({ sql: item.sql, dangerous: item.dangerous });
      }
    }

    for (const index of targetTable.indexes) {
      if (index.indexType === "PRIMARY") continue;
      const keep = sourceTable.indexes.some(
        (item) => identKey(item.name, driver) === identKey(index.name, driver),
      );
      if (!keep) {
        statements.push({
          sql: buildDropIndexSql({
            driver,
            database: target.database,
            schema: target.schema,
            table: targetTable.name,
            name: index.name,
          }),
          dangerous: true,
        });
      }
    }
    for (const index of sourceTable.indexes) {
      if (index.indexType === "PRIMARY") continue;
      const exists = targetTable.indexes.some(
        (item) => identKey(item.name, driver) === identKey(index.name, driver),
      );
      if (!exists) {
        statements.push({
          sql: buildCreateIndexSql({
            driver,
            database: target.database,
            schema: target.schema,
            table: targetTable.name,
            name: index.name,
            columns: index.columns,
            unique: index.unique,
          }),
          dangerous: false,
        });
      }
    }

    for (const constraint of targetTable.constraints) {
      if (constraint.constraintType === "PRIMARY KEY") continue;
      const keep = sourceTable.constraints.some(
        (item) => identKey(item.name, driver) === identKey(constraint.name, driver),
      );
      if (!keep) {
        statements.push({
          sql: buildDropConstraintSql({
            driver,
            database: target.database,
            schema: target.schema,
            table: targetTable.name,
            name: constraint.name,
            constraintType: constraint.constraintType,
          }),
          dangerous: true,
        });
      }
    }
  }

  return { error: null, statements };
}

export function joinSyncSql(statements: SyncStatement[]): string {
  return statements.map((item) => item.sql).join("\n");
}
