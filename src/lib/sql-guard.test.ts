import { describe, expect, it } from "vitest";

import { needsWriteConfirmation } from "@/lib/sql-guard";

describe("needsWriteConfirmation", () => {
  it("detects destructive keywords in SQL code", () => {
    expect(needsWriteConfirmation("UPDATE orders SET status = 1")).toBe(true);
    expect(needsWriteConfirmation("drop table t")).toBe(true);
  });

  it("ignores keywords inside strings, identifiers, and comments", () => {
    expect(
      needsWriteConfirmation(
        "SELECT 'UPDATE nope' AS s, `delete` FROM t -- DROP nope",
      ),
    ).toBe(false);
  });
});
