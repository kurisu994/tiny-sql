import { describe, expect, it } from "vitest";

import {
  buildAlterTableSql,
  buildAlterTableStatements,
  buildCreateTableSql,
  buildPostgresCreateTablePreview,
  isValidDataType,
  validateAlterTable,
  validateCreateTable,
  type AlterColumnInput,
  type AlterTableInput,
  type CreateTableInput,
} from "@/lib/ddl";
import type { ColumnMeta, ConstraintMeta, IndexMeta } from "@/lib/tauri-api";

function col(overrides: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name: "id",
    dataType: "integer",
    nullable: false,
    columnKey: "",
    defaultValue: null,
    comment: null,
    ...overrides,
  };
}

describe("buildPostgresCreateTablePreview", () => {
  it("拼装列定义、默认值、NOT NULL 与主键", () => {
    const ddl = buildPostgresCreateTablePreview(
      "public",
      "users",
      [
        col({ name: "id", dataType: "integer", defaultValue: "nextval('users_id_seq'::regclass)" }),
        col({ name: "name", dataType: "character varying(50)", nullable: true }),
        col({ name: "created_at", dataType: "timestamp without time zone", defaultValue: "now()" }),
      ],
      [{ name: "users_pkey", constraintType: "PRIMARY KEY", columns: ["id"], reference: null }],
      [],
    );
    expect(ddl).toContain('CREATE TABLE "public"."users" (');
    expect(ddl).toContain('"id" integer DEFAULT nextval(\'users_id_seq\'::regclass) NOT NULL');
    expect(ddl).toContain('"name" character varying(50)');
    expect(ddl).not.toContain('"name" character varying(50) NOT NULL');
    expect(ddl).toContain('"created_at" timestamp without time zone DEFAULT now() NOT NULL');
    expect(ddl).toContain('CONSTRAINT "users_pkey" PRIMARY KEY ("id")');
  });

  it("拼装唯一约束、CHECK、外键与非主键索引", () => {
    const ddl = buildPostgresCreateTablePreview(
      "app",
      "orders",
      [
        col({ name: "id" }),
        col({ name: "email", dataType: "text", nullable: false }),
        col({ name: "user_id", dataType: "integer", nullable: false }),
      ],
      [
        { name: "orders_pkey", constraintType: "PRIMARY KEY", columns: ["id"], reference: null },
        { name: "orders_email_key", constraintType: "UNIQUE", columns: ["email"], reference: null },
        { name: "orders_id_check", constraintType: "CHECK", columns: [], reference: "CHECK ((id > 0))" },
        { name: "orders_user_id_fkey", constraintType: "FOREIGN KEY", columns: ["user_id"], reference: "FOREIGN KEY (user_id) REFERENCES users(id)" },
      ],
      [
        { name: "orders_pkey", indexType: "PRIMARY", columns: ["id"], unique: true },
        { name: "idx_orders_user", indexType: "INDEX", columns: ["user_id"], unique: false },
        { name: "idx_orders_email", indexType: "UNIQUE", columns: ["email"], unique: true },
      ],
    );
    expect(ddl).toContain('CONSTRAINT "orders_email_key" UNIQUE ("email")');
    expect(ddl).toContain('CONSTRAINT "orders_id_check" CHECK ((id > 0))');
    expect(ddl).toContain(
      'CONSTRAINT "orders_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id)',
    );
    // PRIMARY 类型索引不重复输出 CREATE INDEX
    expect(ddl).not.toContain('CREATE UNIQUE INDEX "orders_pkey"');
    expect(ddl).toContain('CREATE INDEX "idx_orders_user" ON "app"."orders" ("user_id");');
    expect(ddl).toContain('CREATE UNIQUE INDEX "idx_orders_email" ON "app"."orders" ("email");');
  });

  it("标识符转义：内部双引号双写", () => {
    const ddl = buildPostgresCreateTablePreview(
      "public",
      'we"ird',
      [col({ name: 'col"1' })],
      [],
      [],
    );
    expect(ddl).toContain('CREATE TABLE "public"."we""ird"');
    expect(ddl).toContain('"col""1" integer NOT NULL');
  });

  it("无主键表只输出列定义", () => {
    const ddl = buildPostgresCreateTablePreview(
      "public",
      "logs",
      [col({ name: "msg", dataType: "text", nullable: true })],
      [],
      [],
    );
    expect(ddl).toBe('CREATE TABLE "public"."logs" (\n  "msg" text\n);');
  });
});

describe("buildCreateTableSql（FR-251 新建表）", () => {
  function input(overrides: Partial<CreateTableInput> = {}): CreateTableInput {
    return {
      driver: "mysql",
      database: "app",
      table: "users",
      columns: [
        { name: "id", dataType: "int", nullable: false, defaultValue: "", primaryKey: true, autoIncrement: true },
        { name: "name", dataType: "varchar(50)", nullable: false, defaultValue: "", primaryKey: false, autoIncrement: false },
        { name: "note", dataType: "text", nullable: true, defaultValue: "", primaryKey: false, autoIncrement: false },
      ],
      ...overrides,
    };
  }

  it("MySQL：全限定表名、NOT NULL、AUTO_INCREMENT、PRIMARY KEY 与表注释", () => {
    const sql = buildCreateTableSql(input({ comment: "用户表" }));
    expect(sql).toBe(
      "CREATE TABLE `app`.`users` (\n" +
        "  `id` int NOT NULL AUTO_INCREMENT,\n" +
        "  `name` varchar(50) NOT NULL,\n" +
        "  `note` text,\n" +
        "  PRIMARY KEY (`id`)\n" +
        ") COMMENT = '用户表';",
    );
  });

  it("PostgreSQL：schema 限定、双引号、无 AUTO_INCREMENT", () => {
    const sql = buildCreateTableSql(
      input({
        driver: "postgresql",
        schema: "audit",
        columns: [
          { name: "id", dataType: "integer", nullable: false, defaultValue: "", primaryKey: true, autoIncrement: false },
          { name: "email", dataType: "character varying(255)", nullable: false, defaultValue: "''", primaryKey: false, autoIncrement: false },
        ],
      }),
    );
    expect(sql).toContain('CREATE TABLE "audit"."users" (');
    expect(sql).toContain('"id" integer NOT NULL');
    expect(sql).toContain(`"email" character varying(255) NOT NULL DEFAULT ''`);
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(sql).not.toContain("AUTO_INCREMENT");
  });

  it("复合主键与默认值表达式", () => {
    const sql = buildCreateTableSql(
      input({
        columns: [
          { name: "a", dataType: "int", nullable: false, defaultValue: "", primaryKey: true, autoIncrement: false },
          { name: "b", dataType: "int", nullable: false, defaultValue: "0", primaryKey: true, autoIncrement: false },
          { name: "ts", dataType: "timestamp", nullable: false, defaultValue: "CURRENT_TIMESTAMP", primaryKey: false, autoIncrement: false },
        ],
      }),
    );
    expect(sql).toContain("PRIMARY KEY (`a`, `b`)");
    expect(sql).toContain("`ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP");
  });

  it("validateCreateTable 拒绝空表名 / 重复列 / 可空主键 / 非法类型", () => {
    expect(validateCreateTable(input({ table: "  " }))).toBe("表名不能为空");
    expect(validateCreateTable(input({ columns: [] }))).toBe("至少需要一列");
    expect(
      validateCreateTable(
        input({
          columns: [
            { name: "id", dataType: "int", nullable: false, defaultValue: "", primaryKey: true, autoIncrement: false },
            { name: "ID", dataType: "int", nullable: false, defaultValue: "", primaryKey: false, autoIncrement: false },
          ],
        }),
      ),
    ).toBe("列名不能重复");
    expect(
      validateCreateTable(
        input({
          columns: [
            { name: "id", dataType: "int", nullable: true, defaultValue: "", primaryKey: true, autoIncrement: false },
          ],
        }),
      ),
    ).toBe("主键列「id」必须 NOT NULL");
    expect(
      validateCreateTable(
        input({
          columns: [
            { name: "x", dataType: "int; DROP TABLE t", nullable: false, defaultValue: "", primaryKey: false, autoIncrement: false },
          ],
        }),
      ),
    ).toContain("类型不合法");
    expect(validateCreateTable(input())).toBeNull();
  });

  it("isValidDataType 白名单：常规类型通过，注入字符拒绝", () => {
    expect(isValidDataType("int")).toBe(true);
    expect(isValidDataType("varchar(255)")).toBe(true);
    expect(isValidDataType("decimal(10, 2)")).toBe(true);
    expect(isValidDataType("int unsigned")).toBe(true);
    expect(isValidDataType("timestamp with time zone")).toBe(true);
    expect(isValidDataType("character varying(50)")).toBe(true);
    expect(isValidDataType("int); DROP")).toBe(false);
    expect(isValidDataType("int --")).toBe(false);
    expect(isValidDataType("")).toBe(false);
  });
});

describe("buildAlterTableStatements（FR-253 修改表）", () => {
  function alterCol(
    originName: string | null,
    overrides: Partial<AlterColumnInput> = {},
  ): AlterColumnInput {
    return {
      originName,
      name: originName ?? "new_col",
      dataType: "int",
      nullable: true,
      defaultValue: "",
      ...overrides,
    };
  }

  function mysqlInput(overrides: Partial<AlterTableInput> = {}): AlterTableInput {
    return {
      driver: "mysql",
      database: "app",
      table: "users",
      original: [
        col({ name: "id", dataType: "int", nullable: false, columnKey: "PRI" }),
        col({ name: "name", dataType: "varchar(50)", nullable: true }),
      ],
      columns: [
        alterCol("id", { dataType: "int", nullable: false }),
        alterCol("name", { dataType: "varchar(50)", nullable: true }),
      ],
      ...overrides,
    };
  }

  it("无变更时输出空序列", () => {
    expect(buildAlterTableStatements(mysqlInput())).toEqual([]);
    expect(buildAlterTableSql(mysqlInput())).toBe("");
  });

  it("MySQL：ADD / DROP / 改类型各自独立成句，不与 ADD 合并", () => {
    const statements = buildAlterTableStatements(
      mysqlInput({
        columns: [
          alterCol("id", { dataType: "int", nullable: false }),
          alterCol("name", { dataType: "varchar(100)", nullable: true }),
          alterCol(null, { name: "note", dataType: "text", nullable: true }),
        ],
      }),
    );
    expect(statements.map((s) => s.sql)).toEqual([
      "ALTER TABLE `app`.`users` ADD COLUMN `note` text;",
      "ALTER TABLE `app`.`users` MODIFY COLUMN `name` varchar(100);",
    ]);
    expect(statements.find((s) => s.kind === "add")?.dangerous).toBe(false);
    expect(statements.find((s) => s.kind === "modify_type")?.dangerous).toBe(true);
  });

  it("MySQL：改类型、改空性、丢默认值拆成三条危险语句", () => {
    const statements = buildAlterTableStatements(
      mysqlInput({
        original: [
          col({ name: "id", dataType: "int", nullable: false, columnKey: "PRI" }),
          col({
            name: "age",
            dataType: "int",
            nullable: true,
            defaultValue: "0",
          }),
        ],
        columns: [
          alterCol("id", { dataType: "int", nullable: false }),
          alterCol("age", {
            dataType: "bigint",
            nullable: false,
            defaultValue: "",
          }),
        ],
      }),
    );
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatchObject({ kind: "modify_type", dangerous: true });
    expect(statements[0].sql).toBe(
      "ALTER TABLE `app`.`users` MODIFY COLUMN `age` bigint DEFAULT 0;",
    );
    expect(statements[1]).toMatchObject({
      kind: "set_not_null",
      dangerous: true,
    });
    expect(statements[1].sql).toBe(
      "ALTER TABLE `app`.`users` MODIFY COLUMN `age` bigint NOT NULL DEFAULT 0;",
    );
    expect(statements[2]).toMatchObject({
      kind: "drop_default",
      dangerous: true,
    });
    expect(statements[2].sql).toBe(
      "ALTER TABLE `app`.`users` ALTER COLUMN `age` DROP DEFAULT;",
    );
  });

  it("PostgreSQL：TYPE / SET NOT NULL / DROP DEFAULT / ADD / DROP 分句", () => {
    const statements = buildAlterTableStatements({
      driver: "postgresql",
      database: "app",
      schema: "public",
      table: "users",
      original: [
        col({ name: "id", dataType: "integer", nullable: false, columnKey: "PRI" }),
        col({
          name: "name",
          dataType: "character varying(50)",
          nullable: true,
          defaultValue: "''",
        }),
        col({ name: "legacy", dataType: "text", nullable: true }),
      ],
      columns: [
        alterCol("id", { dataType: "integer", nullable: false }),
        alterCol("name", {
          dataType: "text",
          nullable: false,
          defaultValue: "",
        }),
        alterCol(null, { name: "email", dataType: "text", nullable: true }),
      ],
    });
    expect(statements.map((s) => s.sql)).toEqual([
      'ALTER TABLE "public"."users" ADD COLUMN "email" text;',
      'ALTER TABLE "public"."users" ALTER COLUMN "name" TYPE text;',
      'ALTER TABLE "public"."users" ALTER COLUMN "name" SET NOT NULL;',
      'ALTER TABLE "public"."users" ALTER COLUMN "name" DROP DEFAULT;',
      'ALTER TABLE "public"."users" DROP COLUMN "legacy";',
    ]);
    expect(statements.filter((s) => s.dangerous).map((s) => s.kind)).toEqual([
      "modify_type",
      "set_not_null",
      "drop_default",
      "drop",
    ]);
  });

  it("复合主键表：不删除主键列，只改非主键列", () => {
    const input: AlterTableInput = {
      driver: "mysql",
      database: "app",
      table: "kv",
      original: [
        col({ name: "a", dataType: "int", nullable: false, columnKey: "PRI" }),
        col({ name: "b", dataType: "int", nullable: false, columnKey: "PRI" }),
        col({ name: "val", dataType: "text", nullable: true }),
      ],
      columns: [
        alterCol("a", { dataType: "int", nullable: false }),
        alterCol("b", { dataType: "int", nullable: false }),
        alterCol("val", { dataType: "varchar(20)", nullable: true }),
      ],
    };
    expect(validateAlterTable(input)).toBeNull();
    expect(buildAlterTableSql(input)).toBe(
      "ALTER TABLE `app`.`kv` MODIFY COLUMN `val` varchar(20);",
    );
  });

  it("标识符转义 + 拒绝重命名 / 删主键 / 非法类型", () => {
    expect(
      buildAlterTableSql(
        mysqlInput({
          table: 'we`ird',
          columns: [
            alterCol("id", { dataType: "int", nullable: false }),
            alterCol("name", {
              name: "name",
              dataType: "varchar(50)",
              nullable: true,
            }),
            alterCol(null, { name: 'c`1', dataType: "int", nullable: true }),
          ],
        }),
      ),
    ).toContain("ADD COLUMN `c``1` int");

    expect(
      validateAlterTable(
        mysqlInput({
          columns: [
            alterCol("id", { name: "uid", dataType: "int", nullable: false }),
            alterCol("name", { dataType: "varchar(50)", nullable: true }),
          ],
        }),
      ),
    ).toContain("不支持重命名");

    expect(
      validateAlterTable(
        mysqlInput({
          columns: [alterCol("name", { dataType: "varchar(50)", nullable: true })],
        }),
      ),
    ).toBe("不能删除主键列「id」");

    expect(
      validateAlterTable(
        mysqlInput({
          columns: [
            alterCol("id", { dataType: "int", nullable: false }),
            alterCol("name", {
              dataType: "int); DROP TABLE t",
              nullable: true,
            }),
          ],
        }),
      ),
    ).toContain("类型不合法");
  });
});
