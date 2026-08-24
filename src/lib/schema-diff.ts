// 双连接结构快照与差量（FR-220）。
//
// 纯函数：不发 IPC。MySQL 标识符按不区分大小写匹配，PostgreSQL 区分。
// 仅注释不同不视为必须同步的结构变更。

import type {
  ColumnMeta,
  ConstraintMeta,
  IndexMeta,
  TableMeta,
} from "@/lib/tauri-api";

export type SchemaDriver = "mysql" | "postgresql";

/** 单表结构快照 */
export interface TableSnapshot {
  name: string;
  comment: string | null;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  constraints: ConstraintMeta[];
}

/** 一个 database/schema 的结构快照 */
export interface SchemaSnapshot {
  driver: SchemaDriver;
  connectionId: string;
  connectionName: string;
  database: string;
  schema: string | null;
  capturedAt: string;
  tables: TableSnapshot[];
}

export type ColumnChangeKind = "type" | "nullable" | "default" | "comment";

export interface ColumnDiff {
  name: string;
  left: ColumnMeta | null;
  right: ColumnMeta | null;
  changes: ColumnChangeKind[];
}

export interface IndexDiff {
  name: string;
  left: IndexMeta | null;
  right: IndexMeta | null;
  changed: boolean;
}

export interface ConstraintDiff {
  name: string;
  left: ConstraintMeta | null;
  right: ConstraintMeta | null;
  changed: boolean;
}

export type TableDiffStatus = "leftOnly" | "rightOnly" | "changed" | "equal";

export interface TableDiff {
  name: string;
  status: TableDiffStatus;
  commentChanged: boolean;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  constraints: ConstraintDiff[];
}

export interface SchemaDiffResult {
  left: SchemaSnapshot;
  right: SchemaSnapshot;
  crossDriver: boolean;
  tables: TableDiff[];
}

/** 按方言规范化标识符，用于匹配 */
export function identKey(name: string, driver: SchemaDriver): string {
  return driver === "mysql" ? name.toLowerCase() : name;
}

function matchKey(
  name: string,
  leftDriver: SchemaDriver,
  rightDriver: SchemaDriver,
): string {
  if (leftDriver === "postgresql" && rightDriver === "postgresql") {
    return name;
  }
  return name.toLowerCase();
}

function normalizeDefault(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function normalizeType(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 从 table 列表筛 BASE TABLE（视图不进结构 diff） */
export function baseTablesOnly(tables: TableMeta[]): TableMeta[] {
  return tables.filter((table) => !table.tableType.toUpperCase().includes("VIEW"));
}

function indexSignature(index: IndexMeta, driver: SchemaDriver): string {
  return [
    identKey(index.name, driver),
    index.unique ? "u" : "i",
    index.columns.map((column) => identKey(column, driver)).join(","),
  ].join("|");
}

function constraintSignature(constraint: ConstraintMeta, driver: SchemaDriver): string {
  return [
    identKey(constraint.name, driver),
    constraint.constraintType,
    constraint.columns.map((column) => identKey(column, driver)).join(","),
    (constraint.reference ?? "").trim(),
  ].join("|");
}

function diffColumns(
  left: ColumnMeta[],
  right: ColumnMeta[],
  leftDriver: SchemaDriver,
  rightDriver: SchemaDriver,
): ColumnDiff[] {
  const rightMap = new Map(
    right.map((column) => [matchKey(column.name, leftDriver, rightDriver), column]),
  );
  const seen = new Set<string>();
  const result: ColumnDiff[] = [];

  for (const column of left) {
    const key = matchKey(column.name, leftDriver, rightDriver);
    seen.add(key);
    const other = rightMap.get(key) ?? null;
    if (!other) {
      result.push({ name: column.name, left: column, right: null, changes: [] });
      continue;
    }
    const changes: ColumnChangeKind[] = [];
    if (normalizeType(column.dataType) !== normalizeType(other.dataType)) {
      changes.push("type");
    }
    if (column.nullable !== other.nullable) changes.push("nullable");
    if (normalizeDefault(column.defaultValue) !== normalizeDefault(other.defaultValue)) {
      changes.push("default");
    }
    if ((column.comment ?? "") !== (other.comment ?? "")) changes.push("comment");
    result.push({ name: column.name, left: column, right: other, changes });
  }

  for (const column of right) {
    const key = matchKey(column.name, leftDriver, rightDriver);
    if (seen.has(key)) continue;
    result.push({ name: column.name, left: null, right: column, changes: [] });
  }
  return result;
}

function diffNamed<T extends { name: string }>(
  left: T[],
  right: T[],
  leftDriver: SchemaDriver,
  rightDriver: SchemaDriver,
  same: (a: T, b: T) => boolean,
): { name: string; left: T | null; right: T | null; changed: boolean }[] {
  const rightMap = new Map(
    right.map((item) => [matchKey(item.name, leftDriver, rightDriver), item]),
  );
  const seen = new Set<string>();
  const result: { name: string; left: T | null; right: T | null; changed: boolean }[] = [];
  for (const item of left) {
    const key = matchKey(item.name, leftDriver, rightDriver);
    seen.add(key);
    const other = rightMap.get(key) ?? null;
    result.push({
      name: item.name,
      left: item,
      right: other,
      changed: other !== null && !same(item, other),
    });
  }
  for (const item of right) {
    const key = matchKey(item.name, leftDriver, rightDriver);
    if (seen.has(key)) continue;
    result.push({ name: item.name, left: null, right: item, changed: false });
  }
  return result;
}

function structuralColumnChanges(diff: ColumnDiff): boolean {
  return diff.left === null || diff.right === null ||
    diff.changes.some((change) => change !== "comment");
}

/**
 * 对比两侧 schema 快照。
 * 表状态：仅左 / 仅右 / 结构变更 / 一致（仅注释不同仍算一致，另标 commentChanged）。
 */
export function diffSchemas(
  left: SchemaSnapshot,
  right: SchemaSnapshot,
): SchemaDiffResult {
  const crossDriver = left.driver !== right.driver;
  const rightMap = new Map(
    right.tables.map((table) => [
      matchKey(table.name, left.driver, right.driver),
      table,
    ]),
  );
  const seen = new Set<string>();
  const tables: TableDiff[] = [];

  for (const table of left.tables) {
    const key = matchKey(table.name, left.driver, right.driver);
    seen.add(key);
    const other = rightMap.get(key);
    if (!other) {
      tables.push({
        name: table.name,
        status: "leftOnly",
        commentChanged: false,
        columns: table.columns.map((column) => ({
          name: column.name,
          left: column,
          right: null,
          changes: [],
        })),
        indexes: table.indexes.map((index) => ({
          name: index.name,
          left: index,
          right: null,
          changed: false,
        })),
        constraints: table.constraints.map((constraint) => ({
          name: constraint.name,
          left: constraint,
          right: null,
          changed: false,
        })),
      });
      continue;
    }

    const columns = diffColumns(
      table.columns,
      other.columns,
      left.driver,
      right.driver,
    );
    const indexes = diffNamed(
      table.indexes,
      other.indexes,
      left.driver,
      right.driver,
      (a, b) => indexSignature(a, left.driver) === indexSignature(b, right.driver),
    );
    const constraints = diffNamed(
      table.constraints,
      other.constraints,
      left.driver,
      right.driver,
      (a, b) =>
        constraintSignature(a, left.driver) === constraintSignature(b, right.driver),
    );
    const commentChanged = (table.comment ?? "") !== (other.comment ?? "");
    const structural =
      columns.some(structuralColumnChanges) ||
      indexes.some((item) => item.left === null || item.right === null || item.changed) ||
      constraints.some((item) => item.left === null || item.right === null || item.changed);

    tables.push({
      name: table.name,
      status: structural ? "changed" : "equal",
      commentChanged,
      columns,
      indexes,
      constraints,
    });
  }

  for (const table of right.tables) {
    const key = matchKey(table.name, left.driver, right.driver);
    if (seen.has(key)) continue;
    tables.push({
      name: table.name,
      status: "rightOnly",
      commentChanged: false,
      columns: table.columns.map((column) => ({
        name: column.name,
        left: null,
        right: column,
        changes: [],
      })),
      indexes: table.indexes.map((index) => ({
        name: index.name,
        left: null,
        right: index,
        changed: false,
      })),
      constraints: table.constraints.map((constraint) => ({
        name: constraint.name,
        left: null,
        right: constraint,
        changed: false,
      })),
    });
  }

  return { left, right, crossDriver, tables };
}

export function tableCounts(diff: SchemaDiffResult): {
  leftOnly: number;
  rightOnly: number;
  changed: number;
  equal: number;
} {
  return {
    leftOnly: diff.tables.filter((table) => table.status === "leftOnly").length,
    rightOnly: diff.tables.filter((table) => table.status === "rightOnly").length,
    changed: diff.tables.filter((table) => table.status === "changed").length,
    equal: diff.tables.filter((table) => table.status === "equal").length,
  };
}

/** 把差量渲染成 Markdown 报告 */
export function formatDiffReport(diff: SchemaDiffResult): string {
  const counts = tableCounts(diff);
  const lines = [
    `# 结构对比`,
    ``,
    `- 左侧：${diff.left.connectionName} / ${diff.left.database}${diff.left.schema ? `.${diff.left.schema}` : ""}（${diff.left.driver}）`,
    `- 右侧：${diff.right.connectionName} / ${diff.right.database}${diff.right.schema ? `.${diff.right.schema}` : ""}（${diff.right.driver}）`,
    `- 快照：${diff.left.capturedAt}  vs  ${diff.right.capturedAt}`,
    `- 统计：仅左 ${counts.leftOnly} / 仅右 ${counts.rightOnly} / 变更 ${counts.changed} / 一致 ${counts.equal}`,
    diff.crossDriver ? `- 注意：方言不同，仅供人工阅读，不能一键同步。` : ``,
    ``,
  ].filter((line) => line !== undefined);

  for (const table of diff.tables) {
    if (table.status === "equal" && !table.commentChanged) continue;
    lines.push(`## ${table.name}（${table.status}）`);
    if (table.commentChanged) lines.push(`- 注释不同（默认可忽略）`);
    for (const column of table.columns) {
      if (!column.left) lines.push(`- 列 + ${column.name}（仅右）`);
      else if (!column.right) lines.push(`- 列 - ${column.name}（仅左）`);
      else if (column.changes.filter((c) => c !== "comment").length > 0) {
        lines.push(
          `- 列 ~ ${column.name}：${column.changes.filter((c) => c !== "comment").join(", ")}`,
        );
      }
    }
    for (const index of table.indexes) {
      if (!index.left) lines.push(`- 索引 + ${index.name}`);
      else if (!index.right) lines.push(`- 索引 - ${index.name}`);
      else if (index.changed) lines.push(`- 索引 ~ ${index.name}`);
    }
    for (const constraint of table.constraints) {
      if (!constraint.left) lines.push(`- 约束 + ${constraint.name}`);
      else if (!constraint.right) lines.push(`- 约束 - ${constraint.name}`);
      else if (constraint.changed) lines.push(`- 约束 ~ ${constraint.name}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
