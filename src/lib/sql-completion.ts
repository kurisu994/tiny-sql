import {
  MySQL,
  PostgreSQL,
  SQLite,
  type SQLConfig,
  type SQLDialect,
  type SQLNamespace,
} from "@codemirror/lang-sql";

import type {
  ColumnMeta,
  DriverKind,
  TableMeta,
} from "@/lib/tauri-api";

interface CompletionOption {
  label: string;
  type?: string;
  detail?: string;
  info?: string;
  apply?: string;
  boost?: number;
}

interface CompletionContextLike {
  state: { sliceDoc(from?: number, to?: number): string };
  pos: number;
  explicit: boolean;
}

interface CompletionResultLike {
  from: number;
  options: CompletionOption[];
  validFor?: RegExp;
}

type CompletionSourceLike = (
  context: CompletionContextLike,
) => CompletionResultLike | null;

/** SQL 编辑器补全使用的当前命名空间元数据。 */
export interface SqlCompletionMetadata {
  driver: DriverKind;
  namespaces: string[];
  selectedNamespace: string | null;
  tables: TableMeta[];
  columnsByTable: Record<string, ColumnMeta[]>;
}

interface TableReference {
  table: string;
  alias: string;
}

export interface JoinCandidate {
  targetTable: string;
  sourceTable: string;
  sourceColumn: string;
  targetColumn: string;
  predicate: string;
  apply: string;
}

/** 按连接 driver 选择 CodeMirror SQL 方言。 */
export function sqlDialectFor(driver: DriverKind): SQLDialect {
  if (driver === "postgresql") return PostgreSQL;
  if (driver === "sqlite") return SQLite;
  return MySQL;
}

/** 构造 CodeMirror 原生 schema completion 配置，列信息含类型与约束摘要。 */
export function buildSqlConfig(metadata: SqlCompletionMetadata): SQLConfig {
  return {
    dialect: sqlDialectFor(metadata.driver),
    schema: buildSqlNamespace(metadata),
    defaultSchema: metadata.selectedNamespace ?? undefined,
    upperCaseKeywords: true,
  };
}

export function buildSqlNamespace(
  metadata: SqlCompletionMetadata,
): SQLNamespace {
  const namespace: Record<string, SQLNamespace> = {};
  for (const name of metadata.namespaces) namespace[name] = [];
  if (metadata.selectedNamespace) {
    namespace[metadata.selectedNamespace] = Object.fromEntries(
      metadata.tables.map((table) => [
        table.name,
        (metadata.columnsByTable[table.name] ?? []).map(columnCompletion),
      ]),
    );
  }
  return namespace;
}

/**
 * 为 `JOIN <光标>` 提供基于实际列元数据的连接片段。
 *
 * 关系采用保守启发式：`target_id → target.id`、反向关系或同名 key/id 列。
 */
export function joinCompletionSource(
  metadata: SqlCompletionMetadata,
): CompletionSourceLike {
  return (context) => {
    const before = context.state.sliceDoc(0, context.pos);
    const match = before.match(/\bJOIN\s+([A-Za-z_][\w$]*)?$/i);
    if (!match) return null;
    const candidates = buildJoinCandidates(before, metadata);
    if (candidates.length === 0) return null;
    const typed = match[1] ?? "";
    return {
      from: context.pos - typed.length,
      options: candidates.map((candidate) => ({
        label: candidate.targetTable,
        type: "type",
        detail: `JOIN ${candidate.predicate}`,
        apply: candidate.apply,
        boost: 80,
      })),
      validFor: /^\w*$/,
    };
  };
}

export function buildJoinCandidates(
  sqlText: string,
  metadata: SqlCompletionMetadata,
): JoinCandidate[] {
  const references = extractTableReferences(sqlText, metadata.driver);
  if (references.length === 0) return [];
  const referencedTables = new Set(references.map((reference) => reference.table));
  const candidates: JoinCandidate[] = [];
  const seen = new Set<string>();

  for (const source of references) {
    const sourceColumns = metadata.columnsByTable[source.table] ?? [];
    for (const target of metadata.tables) {
      if (target.name === source.table || referencedTables.has(target.name)) continue;
      const targetColumns = metadata.columnsByTable[target.name] ?? [];
      const relation = inferRelation(
        source.table,
        sourceColumns,
        target.name,
        targetColumns,
      );
      if (!relation) continue;
      const sourceRef = quoteIdentifier(source.alias, metadata.driver);
      const targetRef = quoteIdentifier(target.name, metadata.driver);
      const sourceColumn = quoteIdentifier(relation.sourceColumn, metadata.driver);
      const targetColumn = quoteIdentifier(relation.targetColumn, metadata.driver);
      const predicate = `${sourceRef}.${sourceColumn} = ${targetRef}.${targetColumn}`;
      const key = `${target.name}\0${predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        targetTable: target.name,
        sourceTable: source.table,
        sourceColumn: relation.sourceColumn,
        targetColumn: relation.targetColumn,
        predicate,
        apply: `${targetRef} ON ${predicate}`,
      });
    }
  }
  return candidates;
}

export function extractTableReferences(
  sqlText: string,
  driver: DriverKind,
): TableReference[] {
  const tokens = tokenizeSql(sqlText, driver);
  const references: TableReference[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.upper !== "FROM" && token.upper !== "JOIN") continue;
    const first = tokens[index + 1];
    if (!first || first.value === "(") continue;
    let cursor = index + 1;
    const path: string[] = [];
    while (tokens[cursor]?.kind === "identifier") {
      path.push(tokens[cursor].value);
      if (tokens[cursor + 1]?.value !== ".") break;
      cursor += 2;
    }
    if (path.length === 0) continue;
    const table = path.at(-1) ?? "";
    cursor += 1;
    let alias = table;
    if (tokens[cursor]?.upper === "AS") cursor += 1;
    const aliasToken = tokens[cursor];
    if (
      aliasToken?.kind === "identifier" &&
      !ALIAS_STOP_WORDS.has(aliasToken.upper)
    ) {
      alias = aliasToken.value;
    }
    references.push({ table, alias });
  }
  return references;
}

function columnCompletion(column: ColumnMeta): CompletionOption {
  const constraints = [
    column.nullable ? "NULL" : "NOT NULL",
    column.columnKey || null,
  ].filter(Boolean);
  return {
    label: column.name,
    type: "property",
    detail: [column.dataType, ...constraints].join(" · "),
    info: column.comment || undefined,
  };
}

function inferRelation(
  sourceTable: string,
  sourceColumns: ColumnMeta[],
  targetTable: string,
  targetColumns: ColumnMeta[],
): { sourceColumn: string; targetColumn: string } | null {
  const sourceNames = new Map(
    sourceColumns.map((column) => [column.name.toLowerCase(), column]),
  );
  const targetNames = new Map(
    targetColumns.map((column) => [column.name.toLowerCase(), column]),
  );
  const targetStem = singularize(targetTable);
  const sourceStem = singularize(sourceTable);
  for (const foreignKey of [`${targetStem}_id`, `${targetTable.toLowerCase()}_id`]) {
    if (sourceNames.has(foreignKey) && targetNames.has("id")) {
      return {
        sourceColumn: sourceNames.get(foreignKey)?.name ?? foreignKey,
        targetColumn: targetNames.get("id")?.name ?? "id",
      };
    }
  }
  for (const foreignKey of [`${sourceStem}_id`, `${sourceTable.toLowerCase()}_id`]) {
    if (sourceNames.has("id") && targetNames.has(foreignKey)) {
      return {
        sourceColumn: sourceNames.get("id")?.name ?? "id",
        targetColumn: targetNames.get(foreignKey)?.name ?? foreignKey,
      };
    }
  }
  for (const [name, sourceColumn] of sourceNames) {
    const targetColumn = targetNames.get(name);
    if (
      targetColumn &&
      (name === "id" ||
        name.endsWith("_id") ||
        sourceColumn.columnKey !== "" ||
        targetColumn.columnKey !== "")
    ) {
      return {
        sourceColumn: sourceColumn.name,
        targetColumn: targetColumn.name,
      };
    }
  }
  return null;
}

function singularize(table: string): string {
  const lower = table.toLowerCase();
  if (lower.endsWith("ies") && lower.length > 3) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("ses") && lower.length > 3) return lower.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

function quoteIdentifier(identifier: string, driver: DriverKind): string {
  if (/^[A-Za-z_][\w$]*$/.test(identifier)) return identifier;
  // 只有 MySQL 用反引号，PG / SQLite 都是标准双引号
  if (driver === "mysql") return `\`${identifier.replace(/`/g, "``")}\``;
  return `"${identifier.replace(/"/g, '""')}"`;
}

interface SqlToken {
  value: string;
  upper: string;
  kind: "identifier" | "punctuation";
}

const ALIAS_STOP_WORDS = new Set([
  "ON",
  "JOIN",
  "LEFT",
  "RIGHT",
  "FULL",
  "INNER",
  "OUTER",
  "CROSS",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "FOR",
  "UNION",
  "INTERSECT",
  "EXCEPT",
]);

function tokenizeSql(sqlText: string, driver: DriverKind): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sqlText.length; ) {
    const char = sqlText[index];
    const next = sqlText[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if ((char === "-" && next === "-") || (char === "#" && driver === "mysql")) {
      const end = sqlText.indexOf("\n", index + 1);
      index = end === -1 ? sqlText.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sqlText.indexOf("*/", index + 2);
      index = end === -1 ? sqlText.length : end + 2;
      continue;
    }
    if (char === "'") {
      index = skipQuoted(sqlText, index, "'");
      continue;
    }
    if (char === "`" || char === '"') {
      const closing = char;
      const start = index;
      index += 1;
      let value = "";
      while (index < sqlText.length) {
        if (sqlText[index] === closing) {
          if (sqlText[index + 1] === closing) {
            value += closing;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += sqlText[index];
        index += 1;
      }
      if (index > start + 1) {
        tokens.push({ value, upper: value.toUpperCase(), kind: "identifier" });
      }
      continue;
    }
    const identifier = sqlText.slice(index).match(/^[A-Za-z_][\w$]*/)?.[0];
    if (identifier) {
      tokens.push({
        value: identifier,
        upper: identifier.toUpperCase(),
        kind: "identifier",
      });
      index += identifier.length;
      continue;
    }
    if (".,();".includes(char)) {
      tokens.push({ value: char, upper: char, kind: "punctuation" });
    }
    index += 1;
  }
  return tokens;
}

function skipQuoted(sqlText: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sqlText.length) {
    if (sqlText[index] === quote) {
      if (sqlText[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    if (sqlText[index] === "\\") index += 1;
    index += 1;
  }
  return sqlText.length;
}
