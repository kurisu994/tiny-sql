import { describe, expect, it } from "vitest";

import { preferredDatabase } from "@/lib/databases";

describe("preferredDatabase", () => {
  it("跳过 SQLite temp，选中当前库", () => {
    expect(
      preferredDatabase([
        { name: "temp", isCurrent: false, temporary: true },
        { name: "main", isCurrent: true, temporary: false },
      ]),
    ).toBe("main");
  });

  it("当前库本身是临时库时改选普通库", () => {
    expect(
      preferredDatabase([
        { name: "temp", isCurrent: true, temporary: true },
        { name: "main", isCurrent: false },
      ]),
    ).toBe("main");
  });

  it("只有临时库时不预选", () => {
    expect(preferredDatabase([{ name: "temp", isCurrent: true, temporary: true }])).toBe("");
  });
});
