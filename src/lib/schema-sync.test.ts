import { describe, expect, it } from "vitest";

import { diffSchemas, type SchemaSnapshot, type TableSnapshot } from "@/lib/schema-diff";
import { buildSyncStatements } from "@/lib/schema-sync";
import type { ColumnMeta } from "@/lib/tauri-api";

function col(overrides: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name: "id",
    dataType: "int",
    nullable: false,
    columnKey: "PRI",
    defaultValue: null,
    comment: null,
    ...overrides,
  };
}

function table(name: string, overrides: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    name,
    comment: null,
    columns: [col()],
    indexes: [],
    constraints: [
      { name: `${name}_pkey`, constraintType: "PRIMARY KEY", columns: ["id"], reference: null },
    ],
    ...overrides,
  };
}

function snap(tables: TableSnapshot[], id: string): SchemaSnapshot {
  return {
    driver: "mysql",
    connectionId: id,
    connectionName: id,
    database: "app",
    schema: null,
    capturedAt: "2026-08-24T00:00:00.000Z",
    tables,
  };
}

describe("buildSyncStatements", () => {
  it("跨 driver 拒绝生成", () => {
    const left = snap([table("t")], "l");
    const right = { ...snap([table("t")], "r"), driver: "postgresql" as const, schema: "public" };
    const result = buildSyncStatements(diffSchemas(left, right), "toRight");
    expect(result.error).toContain("方言不同");
    expect(result.statements).toEqual([]);
  });

  it("加列生成 ALTER ADD", () => {
    const left = snap(
      [
        table("users", {
          columns: [col(), col({ name: "email", dataType: "varchar(50)", columnKey: "", nullable: true })],
        }),
      ],
      "l",
    );
    const right = snap([table("users")], "r");
    const result = buildSyncStatements(diffSchemas(left, right), "toRight");
    expect(result.error).toBeNull();
    expect(result.statements.some((item) => item.sql.includes("ADD COLUMN") && item.sql.includes("email"))).toBe(
      true,
    );
  });

  it("删索引生成 DROP INDEX 并标危险", () => {
    const left = snap([table("users")], "l");
    const right = snap(
      [
        table("users", {
          indexes: [
            { name: "idx_email", columns: ["email"], unique: false, indexType: "INDEX" },
          ],
        }),
      ],
      "r",
    );
    const result = buildSyncStatements(diffSchemas(left, right), "toRight");
    const drop = result.statements.find((item) => item.sql.includes("DROP INDEX"));
    expect(drop?.dangerous).toBe(true);
  });

  it("仅右有表生成 DROP TABLE 并标危险", () => {
    const result = buildSyncStatements(
      diffSchemas(snap([], "l"), snap([table("legacy")], "r")),
      "toRight",
    );
    expect(result.statements).toEqual([
      { sql: "DROP TABLE `app`.`legacy`;", dangerous: true },
    ]);
  });
});

describe("buildSyncStatements · SQLite", () => {
  function sqliteSnap(tables: TableSnapshot[], id: string): SchemaSnapshot {
    return {
      driver: "sqlite",
      connectionId: id,
      connectionName: id,
      database: "main",
      // SQLite 没有 schema 层级，compare-view 一律传 null
      schema: null,
      capturedAt: "2026-08-25T00:00:00.000Z",
      tables,
    };
  }

  it("表名限定用 ATTACH 名而不是 public", () => {
    const left = sqliteSnap([table("users"), table("orders")], "l");
    const right = sqliteSnap([table("users")], "r");
    const result = buildSyncStatements(diffSchemas(left, right), "toRight");

    expect(result.error).toBeNull();
    const sql = result.statements.map((item) => item.sql).join("\n");
    expect(sql).toContain('"main"."orders"');
    expect(sql).not.toContain("public");
  });
});
