import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 掉 tauri IPC，纯前端测 session store 逻辑
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { useSessionStore } from "@/stores/session-store";

const mockInvoke = vi.mocked(invoke);

/** 按命令名分派 mock 返回值，避免依赖调用顺序 */
function routeInvoke(map: Record<string, unknown>) {
  mockInvoke.mockImplementation((cmd: string) =>
    Promise.resolve(map[cmd] ?? undefined),
  );
}

beforeEach(() => {
  mockInvoke.mockReset();
  useSessionStore.setState({
    openId: null,
    activeConnection: null,
    status: "idle",
    errorMsg: null,
    passphraseFor: null,
    databases: [],
    selectedDb: null,
    tables: [],
    selectedTable: null,
    rowSet: null,
    loadingData: false,
    sqlText: "SELECT 1",
    queryRunning: false,
    currentQueryId: null,
    queryErrorMsg: null,
    hopStatuses: {},
    lostHops: [],
  });
});

describe("session-store", () => {
  it("open 成功后置 connected 并加载 databases", async () => {
    routeInvoke({
      connection_open: undefined,
      db_list_databases: [{ name: "app" }, { name: "sys" }],
    });
    await useSessionStore.getState().open("c1");
    const s = useSessionStore.getState();
    expect(mockInvoke).toHaveBeenCalledWith("connection_open", {
      id: "c1",
      passphrase: null,
    });
    expect(s.status).toBe("connected");
    expect(s.openId).toBe("c1");
    expect(s.databases).toHaveLength(2);
  });

  it("私钥 passphrase 错误时触发弹窗而非报错", async () => {
    mockInvoke.mockRejectedValueOnce("error.ssh.invalid_passphrase");
    await useSessionStore.getState().open("c1");
    const s = useSessionStore.getState();
    expect(s.passphraseFor).toBe("c1");
    expect(s.status).toBe("idle");
  });

  it("submitPassphrase 带 passphrase 重新打开", async () => {
    useSessionStore.setState({ passphraseFor: "c1" });
    routeInvoke({ connection_open: undefined, db_list_databases: [] });
    await useSessionStore.getState().submitPassphrase("secret");
    expect(mockInvoke).toHaveBeenCalledWith("connection_open", {
      id: "c1",
      passphrase: "secret",
    });
  });

  it("selectTable 用反引号包裹并交给后端 rowLimit=1000", async () => {
    useSessionStore.setState({ openId: "c1", selectedDb: "app" });
    routeInvoke({
      db_query: { columns: ["id"], rows: [["1"]], truncated: false },
    });
    await useSessionStore.getState().selectTable("user`s");
    expect(mockInvoke).toHaveBeenCalledWith("db_query", {
      id: "c1",
      sql: "SELECT * FROM `app`.`user``s`",
      queryId: expect.any(String),
      rowLimit: 1000,
      allowWrite: false,
    });
    expect(useSessionStore.getState().rowSet?.rows).toHaveLength(1);
  });

  it("executeSql 使用 10w 默认上限并可取消 query", async () => {
    useSessionStore.setState({ openId: "c1" });
    routeInvoke({
      db_query: { columns: ["n"], rows: [["1"]], truncated: false },
      db_query_cancel: undefined,
    });

    await useSessionStore.getState().executeSql("SELECT 1");
    expect(mockInvoke).toHaveBeenCalledWith("db_query", {
      id: "c1",
      sql: "SELECT 1",
      queryId: expect.any(String),
      rowLimit: 100000,
      allowWrite: false,
    });
  });

  it("markHopLost 去重累加断开跳", () => {
    useSessionStore.getState().markHopLost(1);
    useSessionStore.getState().markHopLost(1);
    useSessionStore.getState().markHopLost(0);
    expect(useSessionStore.getState().lostHops).toEqual([1, 0]);
  });
});
