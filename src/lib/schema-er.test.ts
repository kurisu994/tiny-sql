import { describe, expect, it } from "vitest";

import {
  buildErColumns,
  buildErGraph,
  layoutErGraph,
  parseForeignKey,
  ER_HEADER_HEIGHT,
} from "@/lib/schema-er";
import type { SchemaSnapshot, TableSnapshot } from "@/lib/schema-diff";

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
    const graph = buildErGraph(snapshot.tables);
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
    const graph = buildErGraph(snapshot.tables);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].from).toBe("tree");
    expect(graph.edges[0].to).toBe("tree");
  });
});

function table(name: string, columns: string[], extra: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    name,
    comment: null,
    columns: columns.map((column) => ({
      name: column,
      dataType: "int",
      nullable: true,
      columnKey: "",
      defaultValue: null,
      comment: null,
    })),
    indexes: [],
    constraints: [],
    ...extra,
  };
}

describe("buildErColumns", () => {
  it("主键置顶，并标注外键 / 唯一 / 索引", () => {
    const columns = buildErColumns(
      table("orders", ["user_id", "code", "id", "memo"], {
        constraints: [
          { name: "PRIMARY", constraintType: "PRIMARY KEY", columns: ["id"], reference: null },
          { name: "fk", constraintType: "FOREIGN KEY", columns: ["user_id"], reference: "app.users(id)" },
          { name: "uq", constraintType: "UNIQUE", columns: ["code"], reference: null },
        ],
        indexes: [{ name: "idx_memo", columns: ["memo"], unique: false, indexType: "INDEX" }],
      }),
    );
    expect(columns.map((c) => c.name)).toEqual(["id", "user_id", "code", "memo"]);
    expect(columns[0].primary).toBe(true);
    expect(columns[1].foreign).toBe(true);
    expect(columns[2].unique).toBe(true);
    expect(columns[3].indexed).toBe(true);
  });
});

describe("layoutErGraph", () => {
  const snapshot: SchemaSnapshot = {
    driver: "mysql",
    connectionId: "c",
    connectionName: "c",
    database: "app",
    schema: null,
    capturedAt: "t",
    tables: [
      table("users", ["id"]),
      table("orders", ["id", "user_id"], {
        constraints: [
          { name: "fk_user", constraintType: "FOREIGN KEY", columns: ["user_id"], reference: "app.users(id)" },
        ],
      }),
      ...Array.from({ length: 12 }, (_, i) => table(`iso_${i}`, ["id", "name"])),
    ],
  };

  it("实体互不重叠，且按目标宽度折行而不是排成一行", () => {
    const graph = buildErGraph(snapshot.tables);
    expect(graph.nodes).toHaveLength(14);
    for (const a of graph.nodes) {
      for (const b of graph.nodes) {
        if (a.id === b.id) continue;
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
    expect(graph.height).toBeGreaterThan(200);
    expect(graph.width).toBeLessThan(2400);
  });

  it("引用方排在被引用方下方", () => {
    const graph = buildErGraph(snapshot.tables);
    const users = graph.nodes.find((n) => n.id === "users")!;
    const orders = graph.nodes.find((n) => n.id === "orders")!;
    expect(orders.y).toBeGreaterThan(users.y);
  });

  it("折叠布局只保留表头高度", () => {
    const base = buildErGraph(snapshot.tables);
    const collapsed = layoutErGraph(base.nodes, base.edges, { collapsed: true });
    for (const node of collapsed.nodes) expect(node.height).toBe(ER_HEADER_HEIGHT);
    expect(collapsed.height).toBeLessThan(base.height);
  });
});
