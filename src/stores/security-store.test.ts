import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { useSecurityStore } from "@/stores/security-store";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  useSecurityStore.setState({
    status: "disabled",
    canPersistPassphrase: false,
    initialized: false,
  });
});

describe("security-store", () => {
  it("refresh 映射后端状态载荷", async () => {
    mockInvoke.mockResolvedValue({
      status: "unlocked",
      canPersistPassphrase: true,
    });

    await useSecurityStore.getState().refresh();

    expect(mockInvoke).toHaveBeenCalledWith("security_status");
    const s = useSecurityStore.getState();
    expect(s.status).toBe("unlocked");
    expect(s.canPersistPassphrase).toBe(true);
    expect(s.initialized).toBe(true);
  });

  it("unlock 成功后刷新状态", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "security_unlock") return Promise.resolve(undefined);
      if (cmd === "security_status") {
        return Promise.resolve({
          status: "unlocked",
          canPersistPassphrase: true,
        });
      }
      return Promise.resolve(undefined);
    });

    await useSecurityStore.getState().unlock("pw");

    expect(mockInvoke).toHaveBeenCalledWith("security_unlock", {
      password: "pw",
    });
    expect(useSecurityStore.getState().status).toBe("unlocked");
  });

  it("错误密码把稳定 key 抛给 UI 层", async () => {
    mockInvoke.mockRejectedValueOnce("error.security.wrong_password");

    await expect(useSecurityStore.getState().unlock("bad")).rejects.toBe(
      "error.security.wrong_password",
    );
    // 失败后状态不变
    expect(useSecurityStore.getState().status).toBe("disabled");
  });

  it("reset 后回到 disabled", async () => {
    useSecurityStore.setState({ status: "locked", initialized: true });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "security_status") {
        return Promise.resolve({
          status: "disabled",
          canPersistPassphrase: false,
        });
      }
      return Promise.resolve(undefined);
    });

    await useSecurityStore.getState().reset();

    expect(mockInvoke).toHaveBeenCalledWith("security_reset");
    expect(useSecurityStore.getState().status).toBe("disabled");
  });
});
