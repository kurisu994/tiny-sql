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

// === 修改表 SQL 生成（FR-253）===

/** 修改表单中的一列。v0.8 支持非主键 RENAME COLUMN。 */
export interface AlterColumnInput {
  /** 原列名；新增列为 null */
  originName: string | null;
  name: string;
  dataType: string;
  nullable: boolean;
  /** 默认值表达式（空 = 无默认值） */
  defaultValue: string;
}

/** 修改表输入：original 为当前服务端列，columns 为表单目标态 */
export interface AlterTableInput {
  driver: "mysql" | "postgresql";
  database: string;
  schema?: string | null;
  table: string;
  original: ColumnMeta[];
  columns: AlterColumnInput[];
}

/** 单条 ALTER 的语义分类，便于预览里把危险语句单独成条 */
export type AlterKind =
  | "add"
  | "drop"
  | "modify_type"
  | "set_not_null"
  | "drop_not_null"
  | "set_default"
  | "drop_default"
  | "rename";

/** 一条独立 ALTER TABLE 语句 */
export interface AlterStatement {
  kind: AlterKind;
  sql: string;
  /** 改类型 / 丢默认值 / DROP COLUMN / 改空性 */
  dangerous: boolean;
}

function qualifiedTable(input: {
  driver: "mysql" | "postgresql";
  database: string;
  schema?: string | null;
  table: string;
}): string {
  if (input.driver === "mysql") {
    return `${quoteMysqlIdent(input.database)}.${quoteMysqlIdent(input.table.trim())}`;
  }
  return `${quoteIdent(input.schema?.trim() || "public")}.${quoteIdent(input.table.trim())}`;
}

function normalizeType(dataType: string): string {
  return dataType.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDefault(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function isPrimaryColumn(column: ColumnMeta): boolean {
  return column.columnKey === "PRI";
}

/** 修改表单校验：返回首个错误文案，合法返回 null */
export function validateAlterTable(input: AlterTableInput): string | null {
  if (!input.table.trim()) return "表名不能为空";
  if (input.columns.length === 0) return "至少需要一列";
  for (const column of input.columns) {
    if (!column.name.trim()) return "列名不能为空";
    if (!isValidDataType(column.dataType)) {
      return `列「${column.name}」类型不合法：${column.dataType}`;
    }
    if (
      column.originName &&
      column.originName.trim() !== column.name.trim()
    ) {
      const original = input.original.find(
        (item) => item.name.toLowerCase() === column.originName!.trim().toLowerCase(),
      );
      if (original && isPrimaryColumn(original)) {
        return `不能重命名主键列「${original.name}」`;
      }
    }
  }
  const names = input.columns.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "列名不能重复";

  const kept = new Set(
    input.columns
      .filter((c) => c.originName)
      .map((c) => c.originName!.trim().toLowerCase()),
  );
  for (const original of input.original) {
    if (isPrimaryColumn(original) && !kept.has(original.name.toLowerCase())) {
      return `不能删除主键列「${original.name}」`;
    }
  }
  return null;
}

function mysqlColumnDef(
  column: { dataType: string; nullable: boolean; defaultValue: string },
): string {
  let def = column.dataType.trim();
  if (!column.nullable) def += " NOT NULL";
  const defaultValue = normalizeDefault(column.defaultValue);
  if (defaultValue !== null) def += ` DEFAULT ${defaultValue}`;
  return def;
}

/**
 * 生成双方言列级 ALTER 语句序列（FR-253）。
 * 每条危险语义独立成句，不与 ADD COLUMN 合并。调用前须先过 [`validateAlterTable`]。
 */
export function buildAlterTableStatements(input: AlterTableInput): AlterStatement[] {
  const quote = input.driver === "mysql" ? quoteMysqlIdent : quoteIdent;
  const table = qualifiedTable(input);
  const originals = new Map(
    input.original.map((column) => [column.name.toLowerCase(), column]),
  );
  const kept = new Set<string>();
  const adds: AlterStatement[] = [];
  const changes: AlterStatement[] = [];
  const drops: AlterStatement[] = [];

  const push = (
    bucket: AlterStatement[],
    kind: AlterKind,
    clause: string,
    dangerous: boolean,
  ) => {
    bucket.push({
      kind,
      sql: `ALTER TABLE ${table} ${clause};`,
      dangerous,
    });
  };

  for (const column of input.columns) {
    const key = (column.originName ?? column.name).trim().toLowerCase();
    if (!column.originName) {
      if (input.driver === "mysql") {
        push(
          adds,
          "add",
          `ADD COLUMN ${quote(column.name.trim())} ${mysqlColumnDef(column)}`,
          false,
        );
      } else {
        let clause = `ADD COLUMN ${quote(column.name.trim())} ${column.dataType.trim()}`;
        if (!column.nullable) clause += " NOT NULL";
        const defaultValue = normalizeDefault(column.defaultValue);
        if (defaultValue !== null) clause += ` DEFAULT ${defaultValue}`;
        push(adds, "add", clause, false);
      }
      continue;
    }

    const original = originals.get(key);
    if (!original) continue;
    kept.add(key);

    const renamed = original.name !== column.name.trim();
    if (renamed && !isPrimaryColumn(original)) {
      push(
        changes,
        "rename",
        `RENAME COLUMN ${quote(original.name)} TO ${quote(column.name.trim())}`,
        false,
      );
    }

    const typeChanged =
      normalizeType(original.dataType) !== normalizeType(column.dataType);
    const nullChanged = original.nullable !== column.nullable;
    const oldDefault = normalizeDefault(original.defaultValue);
    const newDefault = normalizeDefault(column.defaultValue);
    const defaultChanged = oldDefault !== newDefault;

    if (input.driver === "mysql") {
      if (typeChanged) {
        // 改类型时沿用旧空性与旧默认，避免和改空性/默认混在一句
        push(
          changes,
          "modify_type",
          `MODIFY COLUMN ${quote(column.name.trim())} ${mysqlColumnDef({
            dataType: column.dataType,
            nullable: original.nullable,
            defaultValue: oldDefault ?? "",
          })}`,
          true,
        );
      }
      if (nullChanged) {
        push(
          changes,
          original.nullable ? "set_not_null" : "drop_not_null",
          `MODIFY COLUMN ${quote(column.name.trim())} ${mysqlColumnDef({
            dataType: column.dataType,
            nullable: column.nullable,
            defaultValue: oldDefault ?? "",
          })}`,
          true,
        );
      }
    } else {
      if (typeChanged) {
        push(
          changes,
          "modify_type",
          `ALTER COLUMN ${quote(column.name.trim())} TYPE ${column.dataType.trim()}`,
          true,
        );
      }
      if (nullChanged) {
        push(
          changes,
          original.nullable ? "set_not_null" : "drop_not_null",
          `ALTER COLUMN ${quote(column.name.trim())} ${column.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`,
          true,
        );
      }
    }

    if (defaultChanged) {
      if (newDefault === null) {
        push(
          changes,
          "drop_default",
          `ALTER COLUMN ${quote(column.name.trim())} DROP DEFAULT`,
          true,
        );
      } else {
        push(
          changes,
          "set_default",
          `ALTER COLUMN ${quote(column.name.trim())} SET DEFAULT ${newDefault}`,
          false,
        );
      }
    }
  }

  for (const original of input.original) {
    if (kept.has(original.name.toLowerCase())) continue;
    if (
      input.columns.some(
        (c) => !c.originName && c.name.trim().toLowerCase() === original.name.toLowerCase(),
      )
    ) {
      continue;
    }
    push(drops, "drop", `DROP COLUMN ${quote(original.name)}`, true);
  }

  return [...adds, ...changes, ...drops];
}

/** 将 ALTER 序列拼成预览文本（每条独立成行） */
export function buildAlterTableSql(input: AlterTableInput): string {
  return buildAlterTableStatements(input)
    .map((item) => item.sql)
    .join("\n");
}

// === 索引 / 约束 SQL（FR-253）===

const IDENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 新建索引输入 */
export interface CreateIndexInput {
  driver: "mysql" | "postgresql";
  database: string;
  schema?: string | null;
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
}

/** 删除索引 / 约束的公共定位 */
export interface DropObjectInput {
  driver: "mysql" | "postgresql";
  database: string;
  schema?: string | null;
  table: string;
  name: string;
}

function validateIdentName(label: string, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return `${label}不能为空`;
  if (!IDENT_NAME_PATTERN.test(trimmed)) return `${label}不合法：${trimmed}`;
  return null;
}

/** 新建索引校验 */
export function validateCreateIndex(input: CreateIndexInput): string | null {
  const nameError = validateIdentName("索引名", input.name);
  if (nameError) return nameError;
  if (input.columns.length === 0) return "至少选择一列";
  for (const column of input.columns) {
    if (!column.trim()) return "列名不能为空";
    if (!IDENT_NAME_PATTERN.test(column.trim())) {
      return `列名不合法：${column}`;
    }
  }
  return null;
}

/** 双方言 CREATE INDEX / MySQL ALTER TABLE ADD INDEX */
export function buildCreateIndexSql(input: CreateIndexInput): string {
  const name = input.name.trim();
  if (input.driver === "mysql") {
    const unique = input.unique ? "UNIQUE " : "";
    const cols = input.columns.map((c) => quoteMysqlIdent(c.trim())).join(", ");
    return `ALTER TABLE ${qualifiedTable(input)} ADD ${unique}INDEX ${quoteMysqlIdent(name)} (${cols});`;
  }
  const unique = input.unique ? "UNIQUE " : "";
  const cols = input.columns.map((c) => quoteIdent(c.trim())).join(", ");
  return `CREATE ${unique}INDEX ${quoteIdent(name)} ON ${qualifiedTable(input)} (${cols});`;
}

/** 双方言 DROP INDEX（禁止用于主键） */
export function buildDropIndexSql(input: DropObjectInput): string {
  if (input.driver === "mysql") {
    return `ALTER TABLE ${qualifiedTable(input)} DROP INDEX ${quoteMysqlIdent(input.name.trim())};`;
  }
  const schema = quoteIdent(input.schema?.trim() || "public");
  return `DROP INDEX ${schema}.${quoteIdent(input.name.trim())};`;
}

/**
 * 删除约束：MySQL 外键 / CHECK 走 ALTER TABLE DROP …；
 * UNIQUE 请用 [`buildDropIndexSql`]；PostgreSQL 统一 DROP CONSTRAINT。
 */
export function buildDropConstraintSql(
  input: DropObjectInput & { constraintType: string },
): string {
  const table = qualifiedTable(input);
  if (input.driver === "postgresql") {
    return `ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(input.name.trim())};`;
  }
  const kind = input.constraintType.toUpperCase();
  if (kind === "FOREIGN KEY") {
    return `ALTER TABLE ${table} DROP FOREIGN KEY ${quoteMysqlIdent(input.name.trim())};`;
  }
  if (kind === "CHECK") {
    return `ALTER TABLE ${table} DROP CHECK ${quoteMysqlIdent(input.name.trim())};`;
  }
  return `ALTER TABLE ${table} DROP INDEX ${quoteMysqlIdent(input.name.trim())}`;
}
