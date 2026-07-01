import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 掉 tauri IPC，纯前端测 store 逻辑
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import type { StoredConnection } from "@/lib/tauri-api";
import { useConnectionStore } from "@/stores/connection-store";

const mockInvoke = vi.mocked(invoke);
const defaultSsl = {
  mode: "disabled" as const,
  caPath: "",
  clientCertPath: "",
  clientKeyPath: "",
};
const defaultAdvanced = {
  keepAliveEnabled: false,
  keepAliveIntervalSeconds: 240,
  connectTimeoutEnabled: true,
  connectTimeoutSeconds: 30,
  readTimeoutEnabled: false,
  readTimeoutSeconds: 30,
  writeTimeoutEnabled: true,
  writeTimeoutSeconds: 30,
  compressionEnabled: false,
  autoConnect: false,
};

const sampleConn: StoredConnection = {
  id: "1",
  name: "a",
  host: "h",
  port: 3306,
  user: "u",
  password: "",
  database: "",
  ssh: { enabled: false, hops: [] },
  ssl: defaultSsl,
  advanced: defaultAdvanced,
};

beforeEach(() => {
  mockInvoke.mockReset();
  useConnectionStore.setState({ connections: [], loading: false, error: null });
});

describe("connection-store", () => {
  it("load 拉取列表并清空 loading", async () => {
    mockInvoke.mockResolvedValueOnce([sampleConn]);
    await useConnectionStore.getState().load();
    expect(mockInvoke).toHaveBeenCalledWith("connection_list");
    expect(useConnectionStore.getState().connections).toHaveLength(1);
    expect(useConnectionStore.getState().loading).toBe(false);
  });

  it("load 出错时把 i18n key 翻译进 error", async () => {
    mockInvoke.mockRejectedValueOnce("error.driver.connect_failed");
    await useConnectionStore.getState().load();
    expect(useConnectionStore.getState().error).toBe("MySQL 连接失败");
  });

  it("create 后重新拉取列表", async () => {
    mockInvoke.mockResolvedValueOnce(sampleConn).mockResolvedValueOnce([sampleConn]);
    await useConnectionStore.getState().create({
      name: "a",
      host: "h",
      port: 3306,
      user: "u",
      password: "",
      database: "",
      ssh: { enabled: false, hops: [] },
      ssl: defaultSsl,
      advanced: defaultAdvanced,
    });
    expect(mockInvoke).toHaveBeenCalledWith("connection_create", {
      input: expect.objectContaining({ name: "a" }),
    });
    expect(mockInvoke).toHaveBeenCalledWith("connection_list");
  });

  it("remove 调 connection_delete 后重新拉取", async () => {
    mockInvoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);
    await useConnectionStore.getState().remove("1");
    expect(mockInvoke).toHaveBeenCalledWith("connection_delete", { id: "1" });
    expect(mockInvoke).toHaveBeenCalledWith("connection_list");
  });
});
