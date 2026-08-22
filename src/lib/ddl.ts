// DDL 预览拼装（FR-251）：PostgreSQL 由已加载 metadata 重建建表语句。
//
// MySQL 直接走后端 `SHOW CREATE TABLE` 服务端原文，不经过本模块。
// 本模块输出是「重建预览」而非服务端原文：列定义、主键、约束、索引按
// information_schema / pg_catalog 已加载数据拼装，注释与表选项不还原。

import type { ColumnMeta, ConstraintMeta, IndexMeta } from "@/lib/tauri-api";

/** PG 双引号标识符引用（内部双引号双写转义） */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 由元数据拼装 PostgreSQL 建表预览语句。
 *
 * - 列：类型原样使用 information_schema 完整类型；default 含 nextval 时按原样保留
 *   （serial/identity 由服务端 default 表达式体现）；NOT NULL 按 nullable 输出。
 * - 主键 / 唯一 / CHECK / 外键约束从 pg_constraint 定义文本（`pg_get_constraintdef`）
 *   提取，PRIMARY KEY / UNIQUE 由 columns 列表重建，CHECK / FOREIGN KEY 用 definition。
 * - 非主键索引另起 CREATE INDEX 语句。
 */
export function buildPostgresCreateTablePreview(
  schema: string,
  table: string,
  columns: ColumnMeta[],
  constraints: ConstraintMeta[],
  indexes: IndexMeta[],
): string {
  const lines: string[] = [];
  const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  for (const column of columns) {
    let line = `  ${quoteIdent(column.name)} ${column.dataType}`;
    if (column.defaultValue !== null) {
      line += ` DEFAULT ${column.defaultValue}`;
    }
    if (!column.nullable) {
      line += " NOT NULL";
    }
    lines.push(line);
  }

  const pk = constraints.find((c) => c.constraintType === "PRIMARY KEY");
  if (pk && pk.columns.length > 0) {
    lines.push(
      `  CONSTRAINT ${quoteIdent(pk.name)} PRIMARY KEY (${pk.columns.map(quoteIdent).join(", ")})`,
    );
  }
  for (const constraint of constraints) {
    if (constraint.constraintType === "UNIQUE" && constraint.columns.length > 0) {
      lines.push(
        `  CONSTRAINT ${quoteIdent(constraint.name)} UNIQUE (${constraint.columns.map(quoteIdent).join(", ")})`,
      );
    } else if (constraint.constraintType === "CHECK" && constraint.reference) {
      lines.push(
        `  CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.reference}`,
      );
    } else if (constraint.constraintType === "FOREIGN KEY" && constraint.reference) {
      lines.push(
        `  CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.reference}`,
      );
    }
  }

  const statements = [`CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n);`];

  // 非主键索引（pg_indexes 视图不含 PK 隐式索引，防御性排除 primary 类型）
  for (const index of indexes) {
    if (index.indexType === "PRIMARY") continue;
    const unique = index.unique ? "UNIQUE " : "";
    const columnList = index.columns.map(quoteIdent).join(", ");
    statements.push(
      `CREATE ${unique}INDEX ${quoteIdent(index.name)} ON ${qualified} (${columnList});`,
    );
  }

  return statements.join("\n\n");
}
