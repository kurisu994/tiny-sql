// EXPLAIN 结果转成缩进树（FR-222）。

import type { DriverKind, RowSet } from "@/lib/tauri-api";

export interface ExplainNode {
  label: string;
  children: ExplainNode[];
}

const MAX_NODES = 200;

function col(row: (string | null)[], columns: string[], name: string): string {
  const index = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  if (index < 0) return "";
  return row[index] ?? "";
}

function mysqlTree(rowSet: RowSet): ExplainNode[] {
  return rowSet.rows.slice(0, MAX_NODES).map((row, index) => {
    const table = col(row, rowSet.columns, "table");
    const type = col(row, rowSet.columns, "type");
    const rows = col(row, rowSet.columns, "rows");
    const extra = col(row, rowSet.columns, "Extra");
    const parts = [
      table || `step ${index + 1}`,
      type && `type=${type}`,
      rows && `rows=${rows}`,
      extra,
    ].filter(Boolean);
    return { label: parts.join(" · "), children: [] };
  });
}

interface PgPlan {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  Plans?: PgPlan[];
}

function pgNode(plan: PgPlan, budget: { left: number }): ExplainNode {
  const bits = [
    plan["Node Type"] ?? "Plan",
    plan["Relation Name"],
    plan["Plan Rows"] !== undefined ? `rows=${plan["Plan Rows"]}` : "",
    plan["Actual Rows"] !== undefined ? `actual=${plan["Actual Rows"]}` : "",
  ].filter(Boolean);
  const children: ExplainNode[] = [];
  for (const child of plan.Plans ?? []) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    children.push(pgNode(child, budget));
  }
  return { label: bits.join(" · "), children };
}

function pgTree(rowSet: RowSet): ExplainNode[] {
  const raw = rowSet.rows[0]?.[0];
  if (!raw) return [{ label: "（空计划）", children: [] }];
  try {
    const parsed = JSON.parse(raw) as Array<{ Plan?: PgPlan }> | { Plan?: PgPlan };
    const plan = Array.isArray(parsed) ? parsed[0]?.Plan : parsed.Plan;
    if (!plan) return [{ label: raw.slice(0, 200), children: [] }];
    return [pgNode(plan, { left: MAX_NODES })];
  } catch {
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, MAX_NODES)
      .map((line) => ({ label: line.trim(), children: [] }));
  }
}

/** 把 EXPLAIN 结果集转成树。超大计划截断。 */
export function buildExplainTree(driver: DriverKind, rowSet: RowSet): {
  nodes: ExplainNode[];
  truncated: boolean;
} {
  const nodes = driver === "postgresql" ? pgTree(rowSet) : mysqlTree(rowSet);
  return { nodes, truncated: rowSet.rows.length > MAX_NODES };
}

export function explainSql(driver: DriverKind, sql: string, analyze: boolean): string {
  const trimmed = sql.trim().replace(/;$/, "");
  if (driver === "postgresql") {
    return analyze
      ? `EXPLAIN (ANALYZE, FORMAT JSON) ${trimmed}`
      : `EXPLAIN (FORMAT JSON) ${trimmed}`;
  }
  return analyze ? `EXPLAIN ANALYZE ${trimmed}` : `EXPLAIN ${trimmed}`;
}
