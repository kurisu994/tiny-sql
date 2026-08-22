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

/** MySQL 反引号标识符引用（内部反引号双写转义） */
function quoteMysqlIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

// === 新建表 SQL 生成（FR-251）===

/** 新建表单列输入 */
export interface CreateTableColumnInput {
  name: string;
  /** 类型文本，须通过 [`isValidDataType`] 白名单格式校验 */
  dataType: string;
  nullable: boolean;
  /** 默认值表达式（空 = 无默认值）；原样拼入 SQL，由 SQL 预览展示给用户确认 */
  defaultValue: string;
  primaryKey: boolean;
  /** MySQL AUTO_INCREMENT（仅数值主键列有意义） */
  autoIncrement: boolean;
}

/** 新建表输入 */
export interface CreateTableInput {
  driver: "mysql" | "postgresql";
  /** MySQL 用于全限定表名 */
  database: string;
  /** PostgreSQL 目标 schema（缺省 public） */
  schema?: string | null;
  table: string;
  columns: CreateTableColumnInput[];
  /** MySQL 表注释 */
  comment?: string;
}

/** 类型白名单格式：类型名 + 可选修饰词（varying 可在括号前）+ 可选 (n) / (n,n) 精度 + 常见修饰词，拒绝注入字符 */
const DATA_TYPE_PATTERN =
  /^[a-zA-Z][a-zA-Z0-9_]*(\s+(varying))?(\s*\(\s*\d+(\s*,\s*\d+)*\s*\))?(\s+(unsigned|zerofill|with time zone|without time zone))*$/i;

/** 类型文本合法性（新建表表单用；非法类型禁止生成 SQL） */
export function isValidDataType(dataType: string): boolean {
  return DATA_TYPE_PATTERN.test(dataType.trim());
}

/** 新建表表单校验：返回首个错误文案，合法返回 null */
export function validateCreateTable(input: CreateTableInput): string | null {
  if (!input.table.trim()) return "表名不能为空";
  if (input.columns.length === 0) return "至少需要一列";
  for (const column of input.columns) {
    if (!column.name.trim()) return "列名不能为空";
    if (!isValidDataType(column.dataType)) {
      return `列「${column.name}」类型不合法：${column.dataType}`;
    }
  }
  const names = input.columns.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "列名不能重复";
  const pkColumns = input.columns.filter((c) => c.primaryKey);
  for (const pk of pkColumns) {
    if (pk.nullable) return `主键列「${pk.name}」必须 NOT NULL`;
  }
  return null;
}

/** 转义 SQL 字符串字面量（MySQL 表注释用）：单引号双写 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 生成双方言 CREATE TABLE SQL（FR-251）。
 * 调用前必须先过 [`validateCreateTable`]；默认值表达式原样拼入（SQL 预览给用户确认）。
 */
export function buildCreateTableSql(input: CreateTableInput): string {
  const mysql = input.driver === "mysql";
  const quote = mysql ? quoteMysqlIdent : quoteIdent;
  const qualified = mysql
    ? `${quoteMysqlIdent(input.database)}.${quoteMysqlIdent(input.table.trim())}`
    : `${quoteIdent(input.schema?.trim() || "public")}.${quoteIdent(input.table.trim())}`;

  const pkColumns = input.columns.filter((c) => c.primaryKey);
  const lines: string[] = [];
  for (const column of input.columns) {
    let line = `  ${quote(column.name.trim())} ${column.dataType.trim()}`;
    if (!column.nullable) line += " NOT NULL";
    if (column.defaultValue.trim()) line += ` DEFAULT ${column.defaultValue.trim()}`;
    if (mysql && column.autoIncrement) line += " AUTO_INCREMENT";
    lines.push(line);
  }
  if (pkColumns.length > 0) {
    lines.push(
      `  PRIMARY KEY (${pkColumns.map((c) => quote(c.name.trim())).join(", ")})`,
    );
  }

  let sql = `CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n)`;
  if (mysql && input.comment?.trim()) {
    sql += ` COMMENT = ${quoteLiteral(input.comment.trim())}`;
  }
  return `${sql};`;
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
