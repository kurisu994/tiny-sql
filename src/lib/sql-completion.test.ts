import {
  MySQL,
  PostgreSQL,
  schemaCompletionSource,
} from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  buildJoinCandidates,
  buildSqlConfig,
  extractTableReferences,
  joinCompletionSource,
  sqlDialectFor,
  type SqlCompletionMetadata,
} from "@/lib/sql-completion";

const metadata: SqlCompletionMetadata = {
  driver: "mysql",
  namespaces: ["app"],
  selectedNamespace: "app",
  tables: [
    { name: "orders", tableType: "BASE TABLE", rows: null, comment: null },
    { name: "users", tableType: "BASE TABLE", rows: null, comment: null },
  ],
  columnsByTable: {
    orders: [
      {
        name: "id",
        dataType: "bigint",
        nullable: false,
        columnKey: "PRI",
        defaultValue: null,
        comment: "订单主键",
      },
      {
        name: "user_id",
        dataType: "bigint",
        nullable: false,
        columnKey: "MUL",
        defaultValue: null,
        comment: "下单用户",
      },
    ],
    users: [
      {
        name: "id",
        dataType: "bigint",
        nullable: false,
        columnKey: "PRI",
        defaultValue: null,
        comment: "用户主键",
      },
      {
        name: "name",
        dataType: "varchar(100)",
        nullable: true,
        columnKey: "",
        defaultValue: null,
        comment: "用户名称",
      },
    ],
  },
};

describe("SQL completion metadata", () => {
  it("按 driver 选择正确方言", () => {
    expect(sqlDialectFor("mysql")).toBe(MySQL);
    expect(sqlDialectFor("postgresql")).toBe(PostgreSQL);
  });

  it("CodeMirror 原生 schema source 可按 alias 补全列", async () => {
    const config = buildSqlConfig(metadata);
    const doc = "SELECT * FROM orders AS o WHERE o.";
    const state = EditorState.create({
      doc,
      extensions: [sqlDialectFor("mysql").language.extension],
    });
    const source = schemaCompletionSource(config);
    const result = await source(
      { state, pos: doc.length, explicit: true } as Parameters<typeof source>[0],
    );

    expect(result?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "id", type: "property" }),
        expect.objectContaining({ label: "user_id", type: "property" }),
      ]),
    );
  });

  it("解析 MySQL/PostgreSQL 引号与别名", () => {
    expect(
      extractTableReferences(
        "SELECT * FROM `app`.`order items` AS o JOIN `users` u ON 1=1",
        "mysql",
      ),
    ).toEqual([
      { table: "order items", alias: "o" },
      { table: "users", alias: "u" },
    ]);
    expect(
      extractTableReferences(
        'SELECT * FROM "sales"."orders" o JOIN "users" AS u ON true',
        "postgresql",
      ),
    ).toEqual([
      { table: "orders", alias: "o" },
      { table: "users", alias: "u" },
    ]);
  });

  it("根据 user_id → users.id 生成 JOIN 片段", () => {
    expect(buildJoinCandidates("SELECT * FROM orders o JOIN ", metadata)).toEqual([
      expect.objectContaining({
        targetTable: "users",
        sourceTable: "orders",
        sourceColumn: "user_id",
        targetColumn: "id",
        predicate: "o.user_id = users.id",
        apply: "users ON o.user_id = users.id",
      }),
    ]);
  });

  it("JOIN completion source 返回可直接应用的 ON 片段", async () => {
    const doc = "SELECT * FROM orders o JOIN us";
    const state = EditorState.create({ doc });
    const result = await joinCompletionSource(metadata)(
      { state, pos: doc.length, explicit: false },
    );

    expect(result?.from).toBe(doc.length - 2);
    expect(result?.options).toEqual([
      expect.objectContaining({
        label: "users",
        detail: "JOIN o.user_id = users.id",
        apply: "users ON o.user_id = users.id",
      }),
    ]);
  });
});
