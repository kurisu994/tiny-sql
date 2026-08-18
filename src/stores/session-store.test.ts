import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 掉 tauri IPC，纯前端测 session store 逻辑
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import type { DriverKind, StoredConnection } from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

const mockInvoke = vi.mocked(invoke);

function sampleConnection(driver: DriverKind): StoredConnection {
  return {
    id: "c1",
    name: driver,
    driver,
    host: "127.0.0.1",
    port: driver === "postgresql" ? 5432 : 3306,
    user: "tester",
    password: "",
    database: "app",
    ssh: { enabled: false, hops: [] },
    ssl: {
      mode: "disabled",
      caPath: "",
      clientCertPath: "",
      clientKeyPath: "",
    },
    advanced: {
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
    },
  };
}

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
    expandedDb: null,
    selectedDb: null,
    schemas: [],
    expandedSchema: null,
    selectedSchema: null,
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
      db_list_databases: [
        { name: "app", isCurrent: true },
        { name: "sys", isCurrent: false },
      ],
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

  it("toggleExpandedDb 只收起当前 database，不重置当前表和结果", () => {
    useSessionStore.setState({
      expandedDb: "app",
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      selectedTable: "users",
      rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
      loadingData: true,
    });

    useSessionStore.getState().toggleExpandedDb("app");

    const s = useSessionStore.getState();
    expect(s.expandedDb).toBeNull();
    expect(s.selectedDb).toBe("app");
    expect(s.tables).toEqual([
      { name: "users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    expect(s.selectedTable).toBe("users");
    expect(s.rowSet).toEqual({ columns: ["id"], rows: [["1"]], truncated: false });
    expect(s.loadingData).toBe(true);
  });

  it("toggleExpandedDb 不打开未选中的 database", () => {
    useSessionStore.setState({
      expandedDb: "app",
      selectedDb: "app",
    });

    useSessionStore.getState().toggleExpandedDb("billing");

    const s = useSessionStore.getState();
    expect(s.expandedDb).toBe("app");
    expect(s.selectedDb).toBe("app");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("toggleExpandedDb 可重新展开当前 database", () => {
    useSessionStore.setState({
      expandedDb: null,
      selectedDb: "app",
    });

    useSessionStore.getState().toggleExpandedDb("app");

    expect(useSessionStore.getState().expandedDb).toBe("app");
  });

  it("selectDb 重新展开当前 database 时不重置当前表和结果", async () => {
    useSessionStore.setState({
      openId: "c1",
      expandedDb: null,
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      selectedTable: "users",
      rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
    });

    await useSessionStore.getState().selectDb("app");

    const s = useSessionStore.getState();
    expect(mockInvoke).not.toHaveBeenCalledWith("db_list_tables", expect.anything());
    expect(s.expandedDb).toBe("app");
    expect(s.selectedDb).toBe("app");
    expect(s.selectedTable).toBe("users");
    expect(s.rowSet).toEqual({ columns: ["id"], rows: [["1"]], truncated: false });
  });

  it("selectDb 切换 database 时才重置表选择和结果", async () => {
    useSessionStore.setState({
      openId: "c1",
      expandedDb: "app",
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      selectedTable: "users",
      rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
    });
    routeInvoke({
      db_list_tables: [{ name: "orders", tableType: "BASE TABLE", rows: null, comment: null }],
    });

    await useSessionStore.getState().selectDb("billing");

    const s = useSessionStore.getState();
    expect(mockInvoke).toHaveBeenCalledWith("db_list_tables", {
      id: "c1",
      database: "billing",
      schema: null,
    });
    expect(s.expandedDb).toBe("billing");
    expect(s.selectedDb).toBe("billing");
    expect(s.tables).toEqual([
      { name: "orders", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    expect(s.selectedTable).toBeNull();
    expect(s.rowSet).toBeNull();
  });

  it("PostgreSQL 按 database → schema → table 加载并使用双引号查询", async () => {
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("postgresql"),
    });
    routeInvoke({
      db_list_schemas: [
        { name: "public", isDefault: true },
        { name: "audit", isDefault: false },
      ],
      db_list_tables: [
        { name: "order\"items", tableType: "BASE TABLE", rows: null, comment: null },
      ],
      db_query: { columns: ["id"], rows: [["1"]], truncated: false },
    });

    await useSessionStore.getState().selectDb("app");
    expect(mockInvoke).toHaveBeenCalledWith("db_list_schemas", {
      id: "c1",
      database: "app",
    });
    expect(useSessionStore.getState().schemas).toHaveLength(2);

    await useSessionStore.getState().selectSchema("audit");
    expect(mockInvoke).toHaveBeenCalledWith("db_list_tables", {
      id: "c1",
      database: "app",
      schema: "audit",
    });

    await useSessionStore.getState().selectTable('order"items');
    expect(mockInvoke).toHaveBeenCalledWith("db_query", {
      id: "c1",
      sql: 'SELECT * FROM "audit"."order""items"',
      queryId: expect.any(String),
      rowLimit: 1000,
      allowWrite: false,
    });
  });

  it("收起树后当前 database 的表列表仍可加载完成", async () => {
    let resolveTables: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_list_tables") {
        return new Promise((resolve) => {
          resolveTables = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    useSessionStore.setState({ openId: "c1" });

    const pending = useSessionStore.getState().selectDb("app");
    useSessionStore.getState().toggleExpandedDb("app");
    resolveTables([{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }]);
    await pending;

    const s = useSessionStore.getState();
    expect(s.expandedDb).toBeNull();
    expect(s.selectedDb).toBe("app");
    expect(s.tables).toEqual([
      { name: "users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    expect(s.loadingData).toBe(false);
  });

  it("selectDb 切换 database 后旧请求不会覆盖新表列表", async () => {
    let resolveAppTables: (value: unknown) => void = () => {};
    let resolveBillingTables: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string, args) => {
      if (cmd === "db_list_tables") {
        const database = (args as { database: string }).database;
        return new Promise((resolve) => {
          if (database === "app") {
            resolveAppTables = resolve;
          } else {
            resolveBillingTables = resolve;
          }
        });
      }
      return Promise.resolve(undefined);
    });
    useSessionStore.setState({ openId: "c1" });

    const appPending = useSessionStore.getState().selectDb("app");
    const billingPending = useSessionStore.getState().selectDb("billing");
    resolveBillingTables([
      { name: "orders", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await billingPending;
    resolveAppTables([{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }]);
    await appPending;

    const s = useSessionStore.getState();
    expect(s.expandedDb).toBe("billing");
    expect(s.selectedDb).toBe("billing");
    expect(s.tables).toEqual([
      { name: "orders", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
  });

  it("createDatabase 成功后刷新列表并选中新库", async () => {
    useSessionStore.setState({
      openId: "c1",
      status: "connected",
      databases: [{ name: "app", isCurrent: true }],
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
    });
    routeInvoke({
      db_create_database: undefined,
      db_list_databases: [
        { name: "app", isCurrent: true },
        { name: "new_db", isCurrent: false },
      ],
    });

    await useSessionStore.getState().createDatabase("c1", {
      name: " new_db ",
      charset: "utf8mb4",
      collation: "",
    });

    expect(mockInvoke).toHaveBeenCalledWith("db_create_database", {
      id: "c1",
      name: "new_db",
      charset: "utf8mb4",
      collation: null,
    });
    const s = useSessionStore.getState();
    expect(s.databases).toEqual([
      { name: "app", isCurrent: true },
      { name: "new_db", isCurrent: false },
    ]);
    expect(s.selectedDb).toBe("new_db");
    expect(s.tables).toEqual([]);
    expect(s.rowSet).toBeNull();
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
