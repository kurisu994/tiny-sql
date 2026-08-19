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
  buildSqlNamespace,
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

  it("MySQL/PostgreSQL 补全结果按当前命名空间隔离", async () => {
    const postgresMetadata: SqlCompletionMetadata = {
      driver: "postgresql",
      namespaces: ["public"],
      selectedNamespace: "public",
      tables: [
        { name: "events", tableType: "BASE TABLE", rows: null, comment: null },
      ],
      columnsByTable: {
        events: [
          {
            name: "event_id",
            dataType: "uuid",
            nullable: false,
            columnKey: "PRI",
            defaultValue: null,
            comment: null,
          },
        ],
      },
    };
    const mysqlDoc = "SELECT * FROM orders o WHERE o.";
    const mysqlState = EditorState.create({
      doc: mysqlDoc,
      extensions: [MySQL.language.extension],
    });
    const mysqlSource = schemaCompletionSource(buildSqlConfig(metadata));
    const mysqlResult = await mysqlSource(
      {
        state: mysqlState,
        pos: mysqlDoc.length,
        explicit: true,
      } as Parameters<typeof mysqlSource>[0],
    );
    const postgresDoc = "SELECT * FROM events e WHERE e.";
    const postgresState = EditorState.create({
      doc: postgresDoc,
      extensions: [PostgreSQL.language.extension],
    });
    const postgresSource = schemaCompletionSource(
      buildSqlConfig(postgresMetadata),
    );
    const postgresResult = await postgresSource(
      {
        state: postgresState,
        pos: postgresDoc.length,
        explicit: true,
      } as Parameters<typeof postgresSource>[0],
    );

    expect(mysqlResult?.options.map((option) => option.label)).toContain(
      "user_id",
    );
    expect(mysqlResult?.options.map((option) => option.label)).not.toContain(
      "event_id",
    );
    expect(postgresResult?.options.map((option) => option.label)).toEqual([
      "event_id",
    ]);
  });

  it("2000 表 schema namespace 构建保持在线性时间预算内", () => {
    const tables = Array.from({ length: 2000 }, (_, index) => ({
      name: `table_${index}`,
      tableType: "BASE TABLE",
      rows: null,
      comment: null,
    }));
    const columnsByTable = Object.fromEntries(
      tables.map((table) => [
        table.name,
        Array.from({ length: 8 }, (_, index) => ({
          name: `column_${index}`,
          dataType: "bigint",
          nullable: index % 2 === 0,
          columnKey: index === 0 ? "PRI" : "",
          defaultValue: null,
          comment: null,
        })),
      ]),
    );
    const startedAt = performance.now();
    const namespace = buildSqlNamespace({
      driver: "mysql",
      namespaces: ["large_db"],
      selectedNamespace: "large_db",
      tables,
      columnsByTable,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(250);
    expect(
      (namespace as Record<string, Record<string, unknown[]>>).large_db
        .table_1999,
    ).toHaveLength(8);
  });
});
