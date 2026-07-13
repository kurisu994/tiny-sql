import { describe, expect, it } from "vitest";

import { needsWriteConfirmation } from "@/lib/sql-guard";

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
