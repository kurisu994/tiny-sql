import { describe, expect, it } from "vitest";

import { connectionEnv, connectionSafetyLine, envLabel, isReadOnly } from "@/lib/connection-meta";

describe("connection-meta", () => {
  it("缺省不是只读，非法 env 当 none", () => {
    expect(isReadOnly({})).toBe(false);
    expect(connectionEnv({})).toBe("none");
    expect(envLabel("prod")).toBe("生产");
  });

  it("确认文案带名称和环境", () => {
    expect(
      connectionSafetyLine({
        id: "1",
        name: "生产读库",
        driver: "mysql",
        host: "h",
        port: 3306,
        user: "u",
        password: "",
        database: "",
        ssh: { enabled: false, hops: [] },
        ssl: { mode: "disabled", caPath: "", clientCertPath: "", clientKeyPath: "" },
        advanced: {
          keepAliveEnabled: true,
          keepAliveIntervalSeconds: 60,
          keepAliveFailureThreshold: 3,
          connectTimeoutEnabled: true,
          connectTimeoutSeconds: 30,
          readTimeoutEnabled: false,
          readTimeoutSeconds: 30,
          writeTimeoutEnabled: true,
          writeTimeoutSeconds: 30,
          compressionEnabled: false,
          autoConnect: false,
        },
        readOnly: true,
        env: "prod",
      }),
    ).toBe("生产读库 · 生产 · 应用只读");
  });
});
