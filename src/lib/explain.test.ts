import { describe, expect, it } from "vitest";

import { buildExplainTree, explainSql } from "@/lib/explain";

describe("explainSql", () => {
  it("包装双方言 EXPLAIN", () => {
    expect(explainSql("mysql", "SELECT 1;", false)).toBe("EXPLAIN SELECT 1");
    expect(explainSql("postgresql", "SELECT 1", true)).toBe(
      "EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1",
    );
  });
});

describe("buildExplainTree", () => {
  it("MySQL 行转一层树", () => {
    const { nodes } = buildExplainTree("mysql", {
      columns: ["id", "table", "type", "rows", "Extra"],
      rows: [["1", "users", "ALL", "10", "Using where"]],
      truncated: false,
    });
    expect(nodes[0].label).toContain("users");
    expect(nodes[0].label).toContain("type=ALL");
  });

  it("PG JSON 递归子计划", () => {
    const json = JSON.stringify([
      {
        Plan: {
          "Node Type": "Nested Loop",
          Plans: [{ "Node Type": "Seq Scan", "Relation Name": "users", "Plan Rows": 3 }],
        },
      },
    ]);
    const { nodes } = buildExplainTree("postgresql", {
      columns: ["QUERY PLAN"],
      rows: [[json]],
      truncated: false,
    });
    expect(nodes[0].label).toContain("Nested Loop");
    expect(nodes[0].children[0].label).toContain("users");
  });
});
