import { describe, expect, it } from "vitest";

import {
  invalidatesMetadataCache,
  needsWriteConfirmation,
} from "@/lib/sql-guard";

describe("needsWriteConfirmation", () => {
  it("首 token 非读语句一律要求确认", () => {
    expect(needsWriteConfirmation("UPDATE orders SET status = 1")).toBe(true);
    expect(needsWriteConfirmation("drop table t")).toBe(true);
    expect(needsWriteConfirmation("SET @x = 1")).toBe(true);
    expect(needsWriteConfirmation("RENAME TABLE a TO b")).toBe(true);
    expect(needsWriteConfirmation("CALL cleanup()")).toBe(true);
  });

  it("读查询与元数据语句无需确认", () => {
    expect(needsWriteConfirmation("SELECT * FROM t")).toBe(false);
    expect(
      needsWriteConfirmation("WITH x AS (SELECT 1) SELECT * FROM x"),
    ).toBe(false);
    expect(needsWriteConfirmation("SHOW TABLES")).toBe(false);
    expect(needsWriteConfirmation("EXPLAIN SELECT * FROM t")).toBe(false);
    expect(needsWriteConfirmation("desc t")).toBe(false);
    expect(needsWriteConfirmation("DESCRIBE t")).toBe(false);
  });

  it("PostgreSQL 方言识别 TABLE/VALUES 与数据修改 CTE", () => {
    expect(needsWriteConfirmation("TABLE pg_catalog.pg_type", "postgresql")).toBe(false);
    expect(needsWriteConfirmation("VALUES (1), (2)", "postgresql")).toBe(false);
    expect(
      needsWriteConfirmation(
        "WITH changed AS (DELETE FROM orders RETURNING id) SELECT * FROM changed",
        "postgresql",
      ),
    ).toBe(true);
  });

  it("忽略字符串、标识符和注释里的关键字", () => {
    expect(
      needsWriteConfirmation(
        "SELECT 'UPDATE nope' AS s, `delete` FROM t -- DROP nope",
      ),
    ).toBe(false);
  });

  it("EXPLAIN ANALYZE 按被分析语句判定", () => {
    expect(needsWriteConfirmation("EXPLAIN ANALYZE SELECT * FROM t")).toBe(
      false,
    );
    expect(
      needsWriteConfirmation("EXPLAIN ANALYZE FORMAT=TREE SELECT * FROM t"),
    ).toBe(false);
    expect(needsWriteConfirmation("EXPLAIN ANALYZE UPDATE t SET x = 1")).toBe(
      true,
    );
  });

  it("空 SQL 与纯注释不弹确认，交给后端报错", () => {
    expect(needsWriteConfirmation("")).toBe(false);
    expect(needsWriteConfirmation("-- 只有注释")).toBe(false);
  });
});

describe("invalidatesMetadataCache", () => {
  it("识别会改变 schema 元数据的 DDL", () => {
    expect(invalidatesMetadataCache("CREATE TABLE users (id int)")).toBe(true);
    expect(invalidatesMetadataCache("ALTER TABLE users ADD name text")).toBe(true);
    expect(invalidatesMetadataCache("DROP INDEX idx_users_name")).toBe(true);
    expect(invalidatesMetadataCache("TRUNCATE TABLE users")).toBe(true);
    expect(invalidatesMetadataCache("RENAME TABLE users TO members")).toBe(true);
    expect(invalidatesMetadataCache("COMMENT ON TABLE users IS '用户'")).toBe(true);
  });

  it("忽略注释与字符串里的 DDL，并保留普通 DML cache", () => {
    expect(invalidatesMetadataCache("-- DROP TABLE nope\nSELECT 1")).toBe(false);
    expect(invalidatesMetadataCache("SELECT 'CREATE TABLE nope'")).toBe(false);
    expect(invalidatesMetadataCache("UPDATE users SET name = 'ALTER'")).toBe(false);
  });
});
