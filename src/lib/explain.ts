// EXPLAIN 结果转成缩进树（FR-222）。

import type { DriverKind, RowSet } from "@/lib/tauri-api";

export interface ExplainNode {
  label: string;
  children: ExplainNode[];
  /** 只读提示（FR-275），不改写 SQL */
  hint?: string;
}

export function explainHint(label: string): string | undefined {
  const upper = label.toUpperCase();
  if (upper.includes("TYPE=ALL")) return "全表扫描";
  if (upper.includes("FILESORT")) return "额外排序";
  if (upper.includes("TEMPORARY")) return "临时表";
  if (upper.includes("SEQ SCAN")) return "顺序扫描";
  // SQLite：`SCAN t` 是全表扫描，`SCAN t USING ... INDEX ...` 是索引扫描
  if (upper.startsWith("SCAN ") && !upper.includes(" USING ")) return "全表扫描";
  return undefined;
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
    const label = parts.join(" · ");
    return { label, children: [], hint: explainHint(label) };
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
  const label = bits.join(" · ");
  return { label, children, hint: explainHint(label) };
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
      .map((line) => {
        const label = line.trim();
        return { label, children: [], hint: explainHint(label) };
      });
  }
}

/**
 * SQLite `EXPLAIN QUERY PLAN` 结果转树。
 *
 * 列是 `id / parent / notused / detail`：detail 才是人读的那行
 *（`SCAN foo`、`SEARCH foo USING INDEX ...`），层级由 id/parent 组成。
 */
function sqliteTree(rowSet: RowSet): ExplainNode[] {
  const byId = new Map<string, ExplainNode>();
  const roots: ExplainNode[] = [];
  const parents: [string, ExplainNode][] = [];

  for (const row of rowSet.rows.slice(0, MAX_NODES)) {
    const id = col(row, rowSet.columns, "id");
    const parent = col(row, rowSet.columns, "parent");
    const detail = col(row, rowSet.columns, "detail");
    const label = detail || `step ${byId.size + 1}`;
    const node: ExplainNode = { label, children: [], hint: explainHint(label) };
    byId.set(id, node);
    parents.push([parent, node]);
  }
  for (const [parent, node] of parents) {
    // parent 为 0 / 空表示顶层；父节点缺失时（截断）也挂到顶层，避免整枝丢失
    const target = parent && parent !== "0" ? byId.get(parent) : undefined;
    if (target) {
      target.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** 把 EXPLAIN 结果集转成树。超大计划截断。 */
export function buildExplainTree(driver: DriverKind, rowSet: RowSet): {
  nodes: ExplainNode[];
  truncated: boolean;
} {
  const nodes =
    driver === "postgresql"
      ? pgTree(rowSet)
      : driver === "sqlite"
        ? sqliteTree(rowSet)
        : mysqlTree(rowSet);
  return { nodes, truncated: rowSet.rows.length > MAX_NODES };
}

export function explainSql(driver: DriverKind, sql: string, analyze: boolean): string {
  const trimmed = sql.trim().replace(/;$/, "");
  if (driver === "postgresql") {
    return analyze
      ? `EXPLAIN (ANALYZE, FORMAT JSON) ${trimmed}`
      : `EXPLAIN (FORMAT JSON) ${trimmed}`;
  }
  if (driver === "sqlite") {
    // SQLite 没有 ANALYZE 变体：EXPLAIN 出的是虚拟机字节码，
    // QUERY PLAN 才是人能读的执行计划，两种情况都用后者
    return `EXPLAIN QUERY PLAN ${trimmed}`;
  }
  return analyze ? `EXPLAIN ANALYZE ${trimmed}` : `EXPLAIN ${trimmed}`;
}
