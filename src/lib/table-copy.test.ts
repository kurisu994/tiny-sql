import { describe, expect, it } from "vitest";

import {
  copyTargetToken,
  mapColumnsByName,
  projectCopiedRow,
} from "@/lib/table-copy";

describe("mapColumnsByName", () => {
  it("按同名映射，跳过目标没有的列", () => {
    expect(
      mapColumnsByName(["id", "name", "extra"], ["name", "id", "note"], "mysql"),
    ).toEqual([
      { source: "id", dest: "id" },
      { source: "name", dest: "name" },
    ]);
  });

  it("MySQL 忽略大小写；PG 区分", () => {
    expect(mapColumnsByName(["ID"], ["id"], "mysql")).toEqual([
      { source: "ID", dest: "id" },
    ]);
    expect(mapColumnsByName(["ID"], ["id"], "postgresql")).toEqual([]);
  });

  it("空表没有映射", () => {
    expect(mapColumnsByName([], ["id"], "mysql")).toEqual([]);
    expect(mapColumnsByName(["id"], [], "mysql")).toEqual([]);
  });
});

describe("projectCopiedRow", () => {
  it("按映射重排列，缺列填 null", () => {
    const mapping = mapColumnsByName(["id", "name"], ["name", "id"], "mysql");
    expect(
      projectCopiedRow(["id", "name"], ["1", "alice"], mapping, "mysql"),
    ).toEqual(["1", "alice"]);
  });
});

describe("copyTargetToken", () => {
  it("拼 database.table", () => {
    expect(copyTargetToken(" app ", " users ")).toBe("app.users");
  });
});
