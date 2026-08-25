import { describe, expect, it } from "vitest";

import { buildCloneTableSql, isSafeTableName } from "@/lib/clone-table";

describe("clone-table", () => {
  it("MySQL 用 LIKE，拒绝同名与注入", () => {
    expect(
      buildCloneTableSql({
        driver: "mysql",
        database: "shop",
        sourceTable: "orders",
        destTable: "orders_copy",
      }),
    ).toBe("CREATE TABLE `orders_copy` LIKE `orders`;");
    expect(
      buildCloneTableSql({
        driver: "mysql",
        database: "shop",
        sourceTable: "orders",
        destTable: "orders",
      }),
    ).toBeNull();
    expect(isSafeTableName("a;drop")).toBe(false);
  });

  it("PG 用改名后的重建 DDL", () => {
    const sql = buildCloneTableSql({
      driver: "postgresql",
      database: "app",
      schema: "public",
      sourceTable: "users",
      destTable: "users_2",
      columns: [
        {
          name: "id",
          dataType: "integer",
          nullable: false,
          defaultValue: null,
          comment: null,
          columnKey: "PRI",
        },
      ],
      constraints: [],
      indexes: [],
    });
    expect(sql).toContain('CREATE TABLE "public"."users_2"');
    expect(sql).toContain('"id" integer NOT NULL');
  });

  it("SQLite 用重建 DDL，不带库限定也不带索引", () => {
    const sql = buildCloneTableSql({
      driver: "sqlite",
      database: "main",
      sourceTable: "users",
      destTable: "users_2",
      columns: [
        {
          name: "id",
          dataType: "INTEGER",
          nullable: false,
          defaultValue: null,
          comment: null,
          columnKey: "PRI",
        },
      ],
      constraints: [
        { name: "PRIMARY", constraintType: "PRIMARY KEY", columns: ["id"], reference: null },
      ],
      indexes: [],
    });
    expect(sql).toContain('CREATE TABLE "users_2"');
    expect(sql).toContain('"id" INTEGER NOT NULL');
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(sql).not.toContain("CREATE INDEX");
    // 缺少列元数据时不猜结构
    expect(
      buildCloneTableSql({
        driver: "sqlite",
        database: "main",
        sourceTable: "users",
        destTable: "users_2",
      }),
    ).toBeNull();
  });
});
