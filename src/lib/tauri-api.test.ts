import { describe, expect, it } from "vitest";

import { translateError } from "@/lib/tauri-api";

describe("translateError", () => {
  it("已知 i18n key 翻译成中文", () => {
    expect(translateError("error.driver.connect_failed")).toBe("MySQL 连接失败");
    expect(translateError("error.ssh.auth_failed")).toBe("SSH 认证失败");
    expect(translateError("error.driver.invalid_identifier")).toBe(
      "数据库名称或字符集配置不合法",
    );
  });

  it("未知 key 原样返回", () => {
    expect(translateError("some.unknown.key")).toBe("some.unknown.key");
  });

  it("非字符串错误转字符串", () => {
    expect(translateError(new Error("boom"))).toContain("boom");
  });
});
