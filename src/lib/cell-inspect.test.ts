import { describe, expect, it } from "vitest";

import { formatCellDisplay } from "@/lib/cell-inspect";

describe("formatCellDisplay", () => {
  it("区分 NULL、空串和 JSON", () => {
    expect(formatCellDisplay(null).kind).toBe("null");
    expect(formatCellDisplay("").kind).toBe("empty");
    expect(formatCellDisplay('{"a":1}').kind).toBe("json");
    expect(formatCellDisplay('{"a":').kind).toBe("text");
  });
});
