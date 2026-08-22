import { describe, expect, it } from "vitest";

import { buildPostgresCreateTablePreview } from "@/lib/ddl";
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
