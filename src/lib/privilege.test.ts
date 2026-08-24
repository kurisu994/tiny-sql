import { describe, expect, it } from "vitest";

import {
  buildCreateUserSql,
  buildDropUserSql,
  buildGrantSql,
  buildRevokeSql,
} from "@/lib/privilege";

describe("privilege SQL", () => {
  it("生成合法 GRANT / REVOKE / USER", () => {
    expect(buildCreateUserSql("app", "%", "s3cret")).toBe(
      "CREATE USER 'app'@'%' IDENTIFIED BY 's3cret';",
    );
    expect(buildDropUserSql("app", "localhost")).toBe("DROP USER 'app'@'localhost';");
    expect(buildGrantSql("app", "%", "SELECT", "shop")).toBe(
      "GRANT SELECT ON `shop`.* TO 'app'@'%';",
    );
    expect(buildRevokeSql("app", "%", "SELECT", "*")).toBe(
      "REVOKE SELECT ON *.* FROM 'app'@'%';",
    );
  });

  it("拒绝注入字符", () => {
    expect(buildCreateUserSql("a';drop", "%", "x")).toBeNull();
    expect(buildGrantSql("app", "%", "SELECT; DROP", "shop")).toBeNull();
    expect(buildCreateUserSql("app", "%", "pw'or")).toBeNull();
  });
});
