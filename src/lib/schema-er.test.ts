import { describe, expect, it } from "vitest";

import { buildErGraph, parseForeignKey } from "@/lib/schema-er";
import type { SchemaSnapshot } from "@/lib/schema-diff";

describe("parseForeignKey", () => {
  it("解析 MySQL schema.table(cols)", () => {
    expect(
      parseForeignKey({
        name: "fk_user",
        constraintType: "FOREIGN KEY",
        columns: ["user_id"],
        reference: "app.users(id)",
      }),
    ).toEqual({ table: "users", columns: ["id"] });
  });

  it("解析 PG REFERENCES", () => {
    expect(
      parseForeignKey({
        name: "orders_user_id_fkey",
        constraintType: "FOREIGN KEY",
        columns: ["user_id"],
        reference: "FOREIGN KEY (user_id) REFERENCES users(id)",
      }),
    ).toEqual({ table: "users", columns: ["id"] });
  });

  it("画不出的约束返回 null", () => {
    expect(
      parseForeignKey({
        name: "fk",
        constraintType: "FOREIGN KEY",
        columns: ["a"],
        reference: "看不懂的文本",
      }),
    ).toBeNull();
  });
});

describe("buildErGraph", () => {
  it("无 FK 库仍列出全部表且不崩", () => {
    const snapshot: SchemaSnapshot = {
      driver: "mysql",
      connectionId: "c",
      connectionName: "c",
      database: "app",
      schema: null,
      capturedAt: "t",
      tables: [
        {
          name: "a",
          comment: null,
          columns: [],
          indexes: [],
          constraints: [],
        },
      ],
    };
    const graph = buildErGraph(snapshot);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("自引用与复合外键能连边", () => {
    const snapshot: SchemaSnapshot = {
      driver: "mysql",
      connectionId: "c",
      connectionName: "c",
      database: "app",
      schema: null,
      capturedAt: "t",
      tables: [
        {
          name: "tree",
          comment: null,
          columns: [],
          indexes: [],
          constraints: [
            {
              name: "fk_parent",
              constraintType: "FOREIGN KEY",
              columns: ["parent_id"],
              reference: "app.tree(id)",
            },
          ],
        },
      ],
    };
    const graph = buildErGraph(snapshot);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].from).toBe("tree");
    expect(graph.edges[0].to).toBe("tree");
  });
});
