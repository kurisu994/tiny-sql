import { describe, expect, it } from "vitest";

import {
  baseTablesOnly,
  diffSchemas,
  formatDiffReport,
  identKey,
  type SchemaSnapshot,
  type TableSnapshot,
} from "@/lib/schema-diff";
import type {
  ColumnMeta,
  ConstraintMeta,
  DriverKind,
  IndexMeta,
  TableMeta,
} from "@/lib/tauri-api";

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

function snap(
  driver: DriverKind,
  tables: TableSnapshot[],
  extras: Partial<SchemaSnapshot> = {},
): SchemaSnapshot {
  return {
    driver,
    connectionId: extras.connectionId ?? `${driver}-1`,
    connectionName: extras.connectionName ?? driver,
    database: extras.database ?? "app",
    schema: extras.schema ?? (driver === "postgresql" ? "public" : null),
    capturedAt: extras.capturedAt ?? "2026-08-24T00:00:00.000Z",
    tables,
  };
}

describe("identKey / baseTablesOnly", () => {
  it("MySQL 不区分大小写，PG 区分", () => {
    expect(identKey("Users", "mysql")).toBe("users");
    expect(identKey("Users", "postgresql")).toBe("Users");
  });

  it("只保留 BASE TABLE", () => {
    const tables: TableMeta[] = [
      { name: "t", tableType: "BASE TABLE", rows: 1, comment: null },
      { name: "v", tableType: "VIEW", rows: null, comment: null },
    ];
    expect(baseTablesOnly(tables).map((item) => item.name)).toEqual(["t"]);
  });
});

describe("diffSchemas", () => {
  it("空库对空库没有表差", () => {
    const diff = diffSchemas(snap("mysql", []), snap("mysql", []));
    expect(diff.tables).toEqual([]);
    expect(diff.crossDriver).toBe(false);
  });

  it("只加表：仅左", () => {
    const diff = diffSchemas(snap("mysql", [table("users")]), snap("mysql", []));
    expect(diff.tables).toHaveLength(1);
    expect(diff.tables[0].status).toBe("leftOnly");
    expect(diff.tables[0].name).toBe("users");
  });

  it("只删列：结构变更，不含仅注释", () => {
    const left = table("users", {
      columns: [col(), col({ name: "email", dataType: "varchar(50)", columnKey: "" })],
    });
    const right = table("users", { columns: [col()] });
    const diff = diffSchemas(snap("mysql", [left]), snap("mysql", [right]));
    expect(diff.tables[0].status).toBe("changed");
    const email = diff.tables[0].columns.find((item) => item.name === "email");
    expect(email?.right).toBeNull();
    expect(email?.left?.dataType).toBe("varchar(50)");
  });

  it("仅注释不同视为 equal，并单独标记", () => {
    const left = table("users", {
      comment: "a",
      columns: [col({ comment: "pk" })],
    });
    const right = table("users", {
      comment: "b",
      columns: [col({ comment: "id" })],
    });
    const diff = diffSchemas(snap("mysql", [left]), snap("mysql", [right]));
    expect(diff.tables[0].status).toBe("equal");
    expect(diff.tables[0].commentChanged).toBe(true);
    expect(diff.tables[0].columns[0].changes).toEqual(["comment"]);
  });

  it("复合主键：列集变化算结构变更", () => {
    const left = table("kv", {
      columns: [
        col({ name: "a", columnKey: "PRI" }),
        col({ name: "b", columnKey: "PRI" }),
      ],
      constraints: [
        { name: "kv_pkey", constraintType: "PRIMARY KEY", columns: ["a", "b"], reference: null },
      ],
    });
    const right = table("kv", {
      columns: [
        col({ name: "a", columnKey: "PRI" }),
        col({ name: "b", columnKey: "PRI" }),
      ],
      constraints: [
        { name: "kv_pkey", constraintType: "PRIMARY KEY", columns: ["a"], reference: null },
      ],
    });
    const diff = diffSchemas(snap("postgresql", [left]), snap("postgresql", [right]));
    expect(diff.tables[0].status).toBe("changed");
    expect(diff.tables[0].constraints[0].changed).toBe(true);
  });

  it("MySQL 表名大小写不同仍配对；PG 则拆成两张", () => {
    const mysql = diffSchemas(
      snap("mysql", [table("Users")]),
      snap("mysql", [table("users")]),
    );
    expect(mysql.tables).toHaveLength(1);
    expect(mysql.tables[0].status).toBe("equal");

    const pg = diffSchemas(
      snap("postgresql", [table("Users")]),
      snap("postgresql", [table("users")]),
    );
    expect(pg.tables.map((item) => item.status).sort()).toEqual(["leftOnly", "rightOnly"]);
  });

  it("跨 driver 只标记，不阻止展示", () => {
    const diff = diffSchemas(snap("mysql", [table("t")]), snap("postgresql", [table("t")]));
    expect(diff.crossDriver).toBe(true);
    expect(diff.tables[0].status).toBe("equal");
  });

  it("报告包含统计且可忽略纯注释表", () => {
    const left = table("users", { comment: "x" });
    const right = table("users", { comment: "y" });
    const report = formatDiffReport(
      diffSchemas(snap("mysql", [left], { connectionName: "prod" }), snap("mysql", [right])),
    );
    expect(report).toContain("仅左 0");
    expect(report).toContain("注释不同");
  });
});
