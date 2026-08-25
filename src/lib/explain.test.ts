import { describe, expect, it } from "vitest";

import { buildExplainTree, explainHint, explainSql } from "@/lib/explain";

describe("explainSql", () => {
  it("包装双方言 EXPLAIN", () => {
    expect(explainSql("mysql", "SELECT 1;", false)).toBe("EXPLAIN SELECT 1");
    expect(explainSql("postgresql", "SELECT 1", true)).toBe(
      "EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1",
    );
  });

  it("SQLite 无论是否 analyze 都用 QUERY PLAN", () => {
    expect(explainSql("sqlite", "SELECT 1;", false)).toBe(
      "EXPLAIN QUERY PLAN SELECT 1",
    );
    expect(explainSql("sqlite", "SELECT 1", true)).toBe(
      "EXPLAIN QUERY PLAN SELECT 1",
    );
  });
});

describe("buildExplainTree · SQLite", () => {
  it("用 detail 做 label 并按 id/parent 建层级", () => {
    const { nodes } = buildExplainTree("sqlite", {
      columns: ["id", "parent", "notused", "detail"],
      rows: [
        ["2", "0", "0", "SCAN users"],
        ["4", "2", "0", "SEARCH orders USING INDEX idx_orders_user (user_id=?)"],
        ["7", "0", "0", "USE TEMP B-TREE FOR ORDER BY"],
      ],
      truncated: false,
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[0].label).toBe("SCAN users");
    expect(nodes[0].hint).toBe("全表扫描");
    expect(nodes[0].children[0].label).toContain("USING INDEX");
    // 走了索引不算全表扫描
    expect(nodes[0].children[0].hint).toBeUndefined();
    expect(nodes[1].label).toContain("TEMP B-TREE");
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
    expect(nodes[0].hint).toBe("全表扫描");
    expect(explainHint("Seq Scan · users")).toBe("顺序扫描");
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
