import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 掉 tauri IPC，纯前端测 session store 逻辑
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { metadataCache } from "@/lib/metadata-cache";
import type { DriverKind, StoredConnection } from "@/lib/tauri-api";
import {
  isTabDirty,
  selectActiveTab,
  useSessionStore,
  type QueryTab,
} from "@/stores/session-store";

const mockInvoke = vi.mocked(invoke);

/** 构造一个测试 tab（与 store 内部 createTab 同构） */
function makeTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "查询 1",
    sqlText: "SELECT 1",
    initialSql: "SELECT 1",
    rowSet: null,
    loadingData: false,
    queryRunning: false,
    currentQueryId: null,
    queryErrorMsg: null,
    selectedTable: null,
    transaction: null,
    browse: null,
    multiResults: null,
    activeResultIndex: 0,
    lastErrorKey: null,
    filePath: null,
    ...overrides,
  };
}

/** 当前活跃 tab（测试断言辅助） */
function activeTab(): QueryTab {
  const s = useSessionStore.getState();
  const tab = selectActiveTab(s);
  if (!tab) throw new Error("没有活跃 tab");
  return tab;
}

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
  };
}

/** 按命令名分派 mock 返回值，避免依赖调用顺序 */
function routeInvoke(map: Record<string, unknown>) {
  mockInvoke.mockImplementation((cmd: string) =>
    Promise.resolve(map[cmd] ?? undefined),
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockInvoke.mockReset();
  metadataCache.clear();
  useSessionStore.setState({
    openId: null,
    runtimeSessionId: null,
    activeConnection: null,
    status: "idle",
    errorMsg: null,
    pendingDbSwitch: null,
    switchedDatabase: null,
    passphraseFor: null,
    databases: [],
    expandedDb: null,
    selectedDb: null,
    schemas: [],
    expandedSchema: null,
    selectedSchema: null,
    tables: [],
    expandedTable: null,
    tableColumns: [],
    columnsByTable: {},
    loadingColumns: false,
    refreshingMetadata: false,
    loadingData: false,
    tabs: [makeTab()],
    activeTabId: "tab-1",
    hopStatuses: {},
    lostHops: [],
  });
});

describe("session-store", () => {
  it("open 成功后置 connected 并加载 databases", async () => {
    routeInvoke({
      connection_open: "session-1",
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
      rememberPassphrase: null,
    });
    expect(s.status).toBe("connected");
    expect(s.openId).toBe("c1");
    expect(s.runtimeSessionId).toBe("session-1");
    expect(s.databases).toHaveLength(2);
  });

  it("事务 tab 通过独占 session 执行并在提交后自动结束 session（FR-244）", async () => {
    routeInvoke({
      connection_open: "session-1",
      db_list_databases: [],
      transaction_begin: "tx-1",
      transaction_query: {
        rowSet: { columns: ["n"], rows: [["1"]], truncated: false },
        inTransaction: true,
      },
    });
    await useSessionStore.getState().open("c1");
    await useSessionStore.getState().beginTransaction();
    expect(activeTab().transaction).toEqual({
      sessionId: "tx-1",
      inTransaction: true,
    });

    await useSessionStore.getState().executeSql("SELECT 1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "transaction_query",
      expect.objectContaining({
        id: "c1",
        input: expect.objectContaining({ sessionId: "tx-1" }),
      }),
    );
    expect(activeTab().rowSet?.rows).toEqual([["1"]]);

    await useSessionStore.getState().commitTransaction();
    expect(mockInvoke).toHaveBeenCalledWith("transaction_commit", {
      id: "c1",
      sessionId: "tx-1",
    });
    // 一次性事务模型：提交后自动关闭 session，回到普通模式
    expect(mockInvoke).toHaveBeenCalledWith("transaction_close", {
      id: "c1",
      sessionId: "tx-1",
    });
    expect(activeTab().transaction).toBeNull();
  });

  it("回滚后自动结束 session", async () => {
    routeInvoke({
      connection_open: "session-1",
      db_list_databases: [],
      transaction_begin: "tx-1",
    });
    await useSessionStore.getState().open("c1");
    await useSessionStore.getState().beginTransaction();
    await useSessionStore.getState().rollbackTransaction();
    expect(mockInvoke).toHaveBeenCalledWith("transaction_rollback", {
      id: "c1",
      sessionId: "tx-1",
    });
    expect(mockInvoke).toHaveBeenCalledWith("transaction_close", {
      id: "c1",
      sessionId: "tx-1",
    });
    expect(activeTab().transaction).toBeNull();
  });

  it("session 失效错误清除 tab 事务状态并提示", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "connection_open") return Promise.resolve("session-1");
      if (cmd === "transaction_begin") return Promise.resolve("tx-1");
      if (cmd === "transaction_query") {
        return Promise.reject({ key: "error.driver.session_broken", line: null });
      }
      return Promise.resolve(undefined);
    });
    await useSessionStore.getState().open("c1");
    await useSessionStore.getState().beginTransaction();
    await useSessionStore.getState().executeSql("SELECT 1");
    expect(activeTab().transaction).toBeNull();
    expect(activeTab().queryErrorMsg).toContain("事务会话已失效");
  });

  it("关闭事务 tab 先结束后端 session（未提交自动回滚）", async () => {
    routeInvoke({
      connection_open: "session-1",
      db_list_databases: [],
      transaction_begin: "tx-1",
    });
    await useSessionStore.getState().open("c1");
    await useSessionStore.getState().beginTransaction();
    await useSessionStore.getState().closeTab(activeTab().id);
    expect(mockInvoke).toHaveBeenCalledWith("transaction_close", {
      id: "c1",
      sessionId: "tx-1",
    });
  });

  it("多语句脚本分流到 queryMany 并展示多结果（FR-243）", async () => {
    useSessionStore.setState({ openId: "c1", selectedDb: "app" });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_query") {
        return Promise.reject({
          key: "error.driver.multiple_statements",
          line: null,
        });
      }
      if (cmd === "db_query_many") {
        return Promise.resolve({
          statements: [
            {
              sql: "SELECT 1",
              outcome: {
                status: "ok",
                rowSet: { columns: ["a"], rows: [["1"]], truncated: false },
              },
            },
            {
              sql: "SELECT 2",
              outcome: {
                status: "ok",
                rowSet: { columns: ["b"], rows: [["2"]], truncated: false },
              },
            },
          ],
        });
      }
      return Promise.resolve(undefined);
    });
    await useSessionStore.getState().executeSql("SELECT 1; SELECT 2");
    expect(mockInvoke).toHaveBeenCalledWith(
      "db_query_many",
      expect.objectContaining({ id: "c1" }),
    );
    const tab = activeTab();
    expect(tab.multiResults).toHaveLength(2);
    expect(tab.activeResultIndex).toBe(0);
    expect(tab.rowSet).toBeNull();

    // 切换查看第二个结果集
    useSessionStore.getState().setActiveResultIndex(tab.id, 1);
    expect(activeTab().activeResultIndex).toBe(1);
  });

  it("多语句写未确认时保留错误 key 供 UI 重试（FR-243）", async () => {
    useSessionStore.setState({ openId: "c1", selectedDb: "app" });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_query") {
        return Promise.reject({
          key: "error.driver.multiple_statements",
          line: null,
        });
      }
      if (cmd === "db_query_many") {
        return Promise.reject({
          key: "error.driver.write_requires_confirmation",
          line: null,
        });
      }
      return Promise.resolve(undefined);
    });
    await useSessionStore
      .getState()
      .executeSql("SELECT 1; UPDATE t SET a = 1");
    expect(activeTab().lastErrorKey).toBe(
      "error.driver.write_requires_confirmation",
    );
    expect(activeTab().multiResults).toBeNull();
  });

  it("打开 SQL 文件建 tab 并记录最近文件；重复打开同路径复用 tab（FR-240）", async () => {
    routeInvoke({
      sql_file_read: "SELECT * FROM users",
    });
    expect(await useSessionStore.getState().openSqlFileFromPath("/tmp/a.sql")).toBe(true);
    const tab = activeTab();
    expect(tab.title).toBe("a.sql");
    expect(tab.sqlText).toBe("SELECT * FROM users");
    expect(tab.filePath).toBe("/tmp/a.sql");
    expect(isTabDirty(tab)).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("sql_file_recent_touch", {
      path: "/tmp/a.sql",
    });

    // 再次打开同一路径：激活已有 tab，不重复建
    const tabCount = useSessionStore.getState().tabs.length;
    await useSessionStore.getState().openSqlFileFromPath("/tmp/a.sql");
    expect(useSessionStore.getState().tabs).toHaveLength(tabCount);
  });

  it("保存同步 initialSql 清除 dirty；外部修改返回 conflict（FR-240）", async () => {
    routeInvoke({
      sql_file_read: "SELECT 1",
    });
    await useSessionStore.getState().openSqlFileFromPath("/tmp/b.sql");
    const tabId = activeTab().id;

    // 修改后 dirty，保存后清除
    useSessionStore.getState().setSqlText("SELECT 2");
    expect(isTabDirty(activeTab())).toBe(true);
    const saved = await useSessionStore.getState().saveTabToFile(tabId, "/tmp/b.sql");
    expect(saved).toBe("saved");
    expect(isTabDirty(activeTab())).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("sql_file_write", {
      path: "/tmp/b.sql",
      content: "SELECT 2",
    });

    // 磁盘内容被外部改动 → conflict；force 后保存成功
    useSessionStore.getState().setSqlText("SELECT 3");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sql_file_read") return Promise.resolve("外部改动");
      return Promise.resolve(undefined);
    });
    const conflict = await useSessionStore.getState().saveTabToFile(tabId, "/tmp/b.sql");
    expect(conflict).toBe("conflict");
    const forced = await useSessionStore
      .getState()
      .saveTabToFile(tabId, "/tmp/b.sql", { force: true });
    expect(forced).toBe("saved");
    expect(activeTab().initialSql).toBe("SELECT 3");
  });

  it("浏览 tab 筛选 / 排序 / 翻页都重置页码并重新查询（FR-242）", async () => {
    useSessionStore.setState({ openId: "c1", selectedDb: "app" });
    routeInvoke({
      db_browse_table: {
        rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        total: 100,
        hasNextPage: true,
      },
    });
    await useSessionStore.getState().selectTable("users");
    const tabId = activeTab().id;

    // 应用筛选：page 归 0、参数透传
    await useSessionStore
      .getState()
      .browseSetFilters(tabId, [{ column: "id", op: "gt", value: "10" }]);
    expect(mockInvoke).toHaveBeenLastCalledWith("db_browse_table", {
      id: "c1",
      input: {
        database: "app",
        schema: null,
        table: "users",
        filters: [{ column: "id", op: "gt", value: "10" }],
        order: null,
        limit: 1000,
        offset: 0,
      },
    });
    expect(activeTab().browse?.filters).toHaveLength(1);

    // 排序：保持筛选、page 归 0
    await useSessionStore
      .getState()
      .browseSetOrder(tabId, { column: "id", descending: true });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "db_browse_table",
      expect.objectContaining({
        input: expect.objectContaining({
          filters: [{ column: "id", op: "gt", value: "10" }],
          order: { column: "id", descending: true },
          offset: 0,
        }),
      }),
    );

    // 翻页：offset = page × pageSize
    await useSessionStore.getState().browseSetPage(tabId, 2);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "db_browse_table",
      expect.objectContaining({
        input: expect.objectContaining({ offset: 2000, limit: 1000 }),
      }),
    );
    expect(activeTab().browse?.page).toBe(2);

    // 每页行数：page 归 0
    await useSessionStore.getState().browseSetPageSize(tabId, 100);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      "db_browse_table",
      expect.objectContaining({
        input: expect.objectContaining({ limit: 100, offset: 0 }),
      }),
    );
    expect(activeTab().browse?.page).toBe(0);
    expect(activeTab().browse?.total).toBe(100);
    expect(activeTab().browse?.hasNextPage).toBe(true);
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
    routeInvoke({ connection_open: "session-1", db_list_databases: [] });
    await useSessionStore.getState().submitPassphrase("secret");
    expect(mockInvoke).toHaveBeenCalledWith("connection_open", {
      id: "c1",
      passphrase: "secret",
      rememberPassphrase: null,
    });
  });

  it("selectTable 新开浏览 tab 并走服务端浏览查询（FR-242）", async () => {
    useSessionStore.setState({ openId: "c1", selectedDb: "app" });
    routeInvoke({
      db_browse_table: {
        rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        total: 1,
        hasNextPage: false,
      },
    });
    await useSessionStore.getState().selectTable("user`s");
    expect(mockInvoke).toHaveBeenCalledWith("db_browse_table", {
      id: "c1",
      input: {
        database: "app",
        schema: null,
        table: "user`s",
        filters: [],
        order: null,
        limit: 1000,
        offset: 0,
      },
    });
    // 表预览在新 tab 中进行，不影响原 tab
    const tab = activeTab();
    expect(tab.title).toBe("user`s");
    expect(tab.browse?.table).toBe("user`s");
    expect(tab.browse?.total).toBe(1);
    expect(tab.rowSet?.rows).toHaveLength(1);
    expect(useSessionStore.getState().tabs).toHaveLength(2);
  });

  it("selectTable 重复点击同一表复用已有浏览 tab，不产生重复 tab", async () => {
    useSessionStore.setState({ openId: "c1", selectedDb: "app" });
    routeInvoke({
      db_browse_table: {
        rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        total: 1,
        hasNextPage: false,
      },
    });
    // 模拟双击 / 反复点击同一张表
    await useSessionStore.getState().selectTable("users");
    await useSessionStore.getState().selectTable("users");
    await useSessionStore.getState().selectTable("users");

    const s = useSessionStore.getState();
    expect(s.tabs.filter((t) => t.browse?.table === "users")).toHaveLength(1);
    expect(s.tabs).toHaveLength(2); // 初始 tab + 一个浏览 tab
    expect(activeTab().selectedTable).toBe("users");
    // 只查询过一次
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "db_browse_table"),
    ).toHaveLength(1);
  });

  it("reconnect 清理旧查询状态并使用新 session 重新加载数据库", async () => {
    const connection = sampleConnection("mysql");
    useSessionStore.setState({
      openId: "c1",
      runtimeSessionId: "session-old",
      activeConnection: connection,
      status: "connected",
      tabs: [
        makeTab({
          sqlText: "SELECT * FROM users",
          queryRunning: true,
          currentQueryId: "q-old",
        }),
      ],
      lostHops: [0],
    });
    routeInvoke({
      connection_reconnect: "session-new",
      db_list_databases: [{ name: "app", isCurrent: true }],
    });

    await useSessionStore.getState().reconnect(connection);

    expect(mockInvoke).toHaveBeenCalledWith("connection_reconnect", {
      id: "c1",
      expectedSessionId: "session-old",
      passphrase: null,
      databaseOverride: null,
    });
    const state = useSessionStore.getState();
    expect(state.status).toBe("connected");
    expect(state.runtimeSessionId).toBe("session-new");
    expect(state.databases).toEqual([{ name: "app", isCurrent: true }]);
    expect(state.lostHops).toEqual([]);
    // 重连后保留 SQL 文本，复位执行态
    const tab = activeTab();
    expect(tab.currentQueryId).toBeNull();
    expect(tab.queryRunning).toBe(false);
    expect(tab.sqlText).toBe("SELECT * FROM users");
  });

  it("切换连接前按 session 代号关闭旧连接", async () => {
    const oldConnection = sampleConnection("mysql");
    const nextConnection = {
      ...sampleConnection("postgresql"),
      id: "c2",
    };
    useSessionStore.setState({
      openId: "c1",
      runtimeSessionId: "session-old",
      activeConnection: oldConnection,
      status: "connected",
    });
    routeInvoke({
      connection_close: undefined,
      connection_open: "session-next",
      db_list_databases: [{ name: "app", isCurrent: true }],
    });

    await useSessionStore.getState().open("c2", undefined, nextConnection);

    expect(mockInvoke).toHaveBeenCalledWith("connection_close", {
      id: "c1",
      expectedSessionId: "session-old",
    });
    expect(useSessionStore.getState().openId).toBe("c2");
    expect(useSessionStore.getState().runtimeSessionId).toBe("session-next");
  });

  it("重连后忽略旧 session 的迟到 SSH 状态事件", () => {
    useSessionStore.setState({
      activeConnection: sampleConnection("mysql"),
      runtimeSessionId: "session-new",
      hopStatuses: {
        0: {
          status: "connected",
          reason: null,
          rttState: "idle",
          rttMs: null,
        },
      },
      lostHops: [],
    });

    useSessionStore.getState().markHopStatus({
      connectionId: "c1",
      sessionId: "session-old",
      hopIndex: 0,
      status: "lost",
      reason: "error.ssh.tunnel_lost",
    });
    expect(useSessionStore.getState().lostHops).toEqual([]);

    useSessionStore.getState().markHopStatus({
      connectionId: "c1",
      sessionId: "session-new",
      hopIndex: 0,
      status: "lost",
      reason: "error.ssh.tunnel_lost",
    });
    expect(useSessionStore.getState().lostHops).toEqual([0]);
  });

  it("SSH RTT 只更新当前 session 指标且超时不改变连接状态", () => {
    useSessionStore.setState({
      activeConnection: sampleConnection("mysql"),
      runtimeSessionId: "session-new",
      hopStatuses: {
        0: {
          status: "connected",
          reason: null,
          rttState: "idle",
          rttMs: null,
        },
      },
    });

    useSessionStore.getState().markHopRtt({
      connectionId: "c1",
      sessionId: "session-old",
      hopIndex: 0,
      state: "measured",
      rttMs: 999,
    });
    expect(useSessionStore.getState().hopStatuses[0]?.rttState).toBe("idle");

    useSessionStore.getState().markHopRtt({
      connectionId: "c1",
      sessionId: "session-new",
      hopIndex: 0,
      state: "measured",
      rttMs: 12.6,
    });
    expect(useSessionStore.getState().hopStatuses[0]).toEqual({
      status: "connected",
      reason: null,
      rttState: "measured",
      rttMs: 12.6,
    });

    useSessionStore.getState().markHopRtt({
      connectionId: "c1",
      sessionId: "session-new",
      hopIndex: 0,
      state: "timeout",
      rttMs: null,
    });
    expect(useSessionStore.getState().hopStatuses[0]).toEqual({
      status: "connected",
      reason: null,
      rttState: "timeout",
      rttMs: null,
    });
  });

  it("重连后旧查询的迟到结果不能覆盖新会话", async () => {
    const query = deferred<unknown>();
    const connection = sampleConnection("mysql");
    mockInvoke.mockImplementation((command: string) => {
      if (command === "db_query") return query.promise;
      if (command === "connection_reconnect") return Promise.resolve("session-new");
      if (command === "db_list_databases") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    useSessionStore.setState({
      openId: "c1",
      runtimeSessionId: "session-old",
      activeConnection: connection,
      status: "connected",
    });

    const pendingQuery = useSessionStore.getState().executeSql("SELECT pg_sleep(10)");
    expect(mockInvoke).toHaveBeenCalledWith("db_query", expect.anything());
    await useSessionStore.getState().reconnect(connection);
    query.resolve({ columns: ["stale"], rows: [["old"]], truncated: false });
    await pendingQuery;

    const state = useSessionStore.getState();
    expect(state.runtimeSessionId).toBe("session-new");
    // 旧 query_id 的迟到结果不得写回 tab（T6.5 隔离）
    expect(activeTab().rowSet).toBeNull();
    expect(activeTab().queryErrorMsg).toBeNull();
  });

  it("toggleExpandedDb 只收起当前 database，不重置当前表和结果", () => {
    useSessionStore.setState({
      expandedDb: "app",
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      tabs: [
        makeTab({
          selectedTable: "users",
          rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        }),
      ],
      loadingData: true,
    });

    useSessionStore.getState().toggleExpandedDb("app");

    const s = useSessionStore.getState();
    expect(s.expandedDb).toBeNull();
    expect(s.selectedDb).toBe("app");
    expect(s.tables).toEqual([
      { name: "users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    expect(activeTab().selectedTable).toBe("users");
    expect(activeTab().rowSet).toEqual({
      columns: ["id"],
      rows: [["1"]],
      truncated: false,
    });
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
      tabs: [
        makeTab({
          selectedTable: "users",
          rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        }),
      ],
    });

    await useSessionStore.getState().selectDb("app");

    const s = useSessionStore.getState();
    expect(mockInvoke).not.toHaveBeenCalledWith("db_list_tables", expect.anything());
    expect(s.expandedDb).toBe("app");
    expect(s.selectedDb).toBe("app");
    expect(activeTab().selectedTable).toBe("users");
    expect(activeTab().rowSet).toEqual({
      columns: ["id"],
      rows: [["1"]],
      truncated: false,
    });
  });

  it("selectDb 切换 database 不污染查询 tab（FR-109 工作台独立）", async () => {
    useSessionStore.setState({
      openId: "c1",
      expandedDb: "app",
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      tabs: [
        makeTab({
          selectedTable: "users",
          rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        }),
      ],
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
    // 多 tab 工作台的 SQL 与结果独立于树的库切换
    expect(activeTab().selectedTable).toBe("users");
    expect(activeTab().rowSet).not.toBeNull();
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
      db_browse_table: {
        rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        total: 1,
        hasNextPage: false,
      },
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
    expect(mockInvoke).toHaveBeenCalledWith("db_browse_table", {
      id: "c1",
      input: {
        database: "app",
        schema: "audit",
        table: 'order"items',
        filters: [],
        order: null,
        limit: 1000,
        offset: 0,
      },
    });
  });

  it("PostgreSQL 选中非当前 database 时给出切换引导", async () => {
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("postgresql"),
    });
    mockInvoke.mockRejectedValue("error.driver.database_switch_required");

    await useSessionStore.getState().selectDb("cloudpivot");

    const s = useSessionStore.getState();
    expect(s.errorMsg).toBe("需要先切换到目标 PostgreSQL 数据库");
    expect(s.pendingDbSwitch).toBe("cloudpivot");
    expect(s.loadingData).toBe(false);
  });

  it("switchDatabase 以 session 级覆盖切库，不修改保存的连接配置", async () => {
    const conn = sampleConnection("postgresql");
    useSessionStore.setState({
      openId: "c1",
      runtimeSessionId: "session-1",
      activeConnection: conn,
      status: "connected",
      errorMsg: "需要先切换到目标 PostgreSQL 数据库",
      pendingDbSwitch: "cloudpivot",
    });
    routeInvoke({
      connection_reconnect: "session-2",
      db_list_databases: [{ name: "cloudpivot", isCurrent: true }],
      db_list_schemas: [{ name: "public", isDefault: true }],
    });

    await useSessionStore.getState().switchDatabase();

    // 不写回持久化配置，关闭后重新打开仍是原 database
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "connection_update",
      expect.anything(),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "connection_reconnect",
      expect.objectContaining({ id: "c1", databaseOverride: "cloudpivot" }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("db_list_schemas", {
      id: "c1",
      database: "cloudpivot",
    });
    const s = useSessionStore.getState();
    expect(s.activeConnection?.database).toBe("app");
    expect(s.switchedDatabase).toBe("cloudpivot");
    expect(s.pendingDbSwitch).toBeNull();
    expect(s.errorMsg).toBeNull();
    expect(s.selectedDb).toBe("cloudpivot");
    expect(s.schemas).toEqual([{ name: "public", isDefault: true }]);
  });

  it("MySQL 按需加载表列并保留完整元信息", async () => {
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("mysql"),
      selectedDb: "app",
    });
    routeInvoke({
      db_list_indexes: [],
      db_list_constraints: [],
      db_list_columns: [
        {
          name: "id",
          dataType: "bigint unsigned",
          nullable: false,
          columnKey: "PRI",
          defaultValue: "0",
          comment: "主键",
        },
      ],
    });

    await useSessionStore.getState().toggleTableColumns("users");

    expect(mockInvoke).toHaveBeenCalledWith("db_list_columns", {
      id: "c1",
      database: "app",
      schema: null,
      table: "users",
    });
    const state = useSessionStore.getState();
    expect(state.expandedTable).toBe("users");
    expect(state.tableColumns).toEqual([
      {
        name: "id",
        dataType: "bigint unsigned",
        nullable: false,
        columnKey: "PRI",
        defaultValue: "0",
        comment: "主键",
      },
    ]);
    expect(state.loadingColumns).toBe(false);

    await useSessionStore.getState().toggleTableColumns("users");
    await useSessionStore.getState().toggleTableColumns("users");
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "db_list_columns"),
    ).toHaveLength(1);
  });

  it("PostgreSQL 加载列时携带当前 schema", async () => {
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("postgresql"),
      selectedDb: "app",
      selectedSchema: "audit",
    });
    routeInvoke({ db_list_columns: [] });

    await useSessionStore.getState().toggleTableColumns("events");

    expect(mockInvoke).toHaveBeenCalledWith("db_list_columns", {
      id: "c1",
      database: "app",
      schema: "audit",
      table: "events",
    });
  });

  it("收起表后忽略仍在返回的旧列请求", async () => {
    let resolveColumns: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_list_columns") {
        return new Promise((resolve) => {
          resolveColumns = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("mysql"),
      selectedDb: "app",
    });

    const pending = useSessionStore.getState().toggleTableColumns("users");
    await useSessionStore.getState().toggleTableColumns("users");
    resolveColumns([
      {
        name: "id",
        dataType: "bigint",
        nullable: false,
        columnKey: "PRI",
        defaultValue: null,
        comment: null,
      },
    ]);
    await pending;

    const state = useSessionStore.getState();
    expect(state.expandedTable).toBeNull();
    expect(state.tableColumns).toEqual([]);
    expect(state.loadingColumns).toBe(false);
  });

  it("手动刷新会重新请求当前 database、table 与展开列", async () => {
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("mysql"),
      selectedDb: "app",
      expandedDb: "app",
      tables: [
        { name: "users", tableType: "BASE TABLE", rows: null, comment: null },
      ],
      expandedTable: "users",
      tableColumns: [],
    });
    routeInvoke({
      db_list_databases: [{ name: "app", isCurrent: true }],
      db_list_tables: [
        { name: "members", tableType: "BASE TABLE", rows: 2, comment: null },
      ],
      db_list_columns: [
        {
          name: "fresh_column",
          dataType: "varchar(20)",
          nullable: true,
          columnKey: "",
          defaultValue: null,
          comment: null,
        },
      ],
    });

    await useSessionStore.getState().refreshMetadata();

    expect(mockInvoke).toHaveBeenCalledWith("db_list_databases", { id: "c1" });
    expect(mockInvoke).toHaveBeenCalledWith("db_list_tables", {
      id: "c1",
      database: "app",
      schema: null,
    });
    expect(mockInvoke).toHaveBeenCalledWith("db_list_columns", {
      id: "c1",
      database: "app",
      schema: null,
      table: "users",
    });
    const state = useSessionStore.getState();
    expect(state.tables[0]?.name).toBe("members");
    expect(state.tableColumns[0]?.name).toBe("fresh_column");
    expect(state.refreshingMetadata).toBe(false);
  });

  it("成功执行 DDL 后清除当前连接的 metadata cache", async () => {
    metadataCache.set(
      {
        connectionId: "c1",
        driver: "mysql",
        database: "app",
        schema: null,
        resource: "tables",
      },
      [{ name: "users" }],
    );
    useSessionStore.setState({ openId: "c1" });
    routeInvoke({
      db_query: { columns: ["affected_rows"], rows: [["0"]], truncated: false },
    });

    await useSessionStore
      .getState()
      .executeSql("ALTER TABLE users ADD COLUMN name varchar(20)", {
        allowWrite: true,
      });

    expect(
      metadataCache.get({
        connectionId: "c1",
        driver: "mysql",
        database: "app",
        schema: null,
        resource: "tables",
      }),
    ).toBeUndefined();
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

  it("selectDb A→B→A 时最早的 A 响应不能覆盖最新 A", async () => {
    const firstApp = deferred<unknown>();
    const billing = deferred<unknown>();
    const latestApp = deferred<unknown>();
    let appRequestCount = 0;
    mockInvoke.mockImplementation((cmd: string, args) => {
      if (cmd !== "db_list_tables") return Promise.resolve(undefined);
      const database = (args as { database: string }).database;
      if (database === "billing") return billing.promise;
      appRequestCount += 1;
      return appRequestCount === 1 ? firstApp.promise : latestApp.promise;
    });
    useSessionStore.setState({ openId: "c1" });

    const firstPending = useSessionStore.getState().selectDb("app");
    const billingPending = useSessionStore.getState().selectDb("billing");
    billing.resolve([
      { name: "billing_orders", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await billingPending;
    const latestPending = useSessionStore.getState().selectDb("app");
    latestApp.resolve([
      { name: "new_users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await latestPending;
    firstApp.resolve([
      { name: "stale_users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await firstPending;

    expect(useSessionStore.getState().selectedDb).toBe("app");
    expect(useSessionStore.getState().tables[0]?.name).toBe("new_users");
    expect(
      metadataCache.get<unknown[]>({
        connectionId: "c1",
        driver: "mysql",
        database: "app",
        schema: null,
        resource: "tables",
      }),
    ).toEqual([
      { name: "new_users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
  });

  it("selectSchema A→B→A 时旧响应不能覆盖最新 schema", async () => {
    const firstPublic = deferred<unknown>();
    const audit = deferred<unknown>();
    const latestPublic = deferred<unknown>();
    let publicRequestCount = 0;
    mockInvoke.mockImplementation((cmd: string, args) => {
      if (cmd !== "db_list_tables") return Promise.resolve(undefined);
      const schema = (args as { schema: string }).schema;
      if (schema === "audit") return audit.promise;
      publicRequestCount += 1;
      return publicRequestCount === 1
        ? firstPublic.promise
        : latestPublic.promise;
    });
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("postgresql"),
      selectedDb: "app",
    });

    const firstPending = useSessionStore.getState().selectSchema("public");
    const auditPending = useSessionStore.getState().selectSchema("audit");
    audit.resolve([
      { name: "audit_log", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await auditPending;
    const latestPending = useSessionStore.getState().selectSchema("public");
    latestPublic.resolve([
      { name: "new_users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await latestPending;
    firstPublic.resolve([
      { name: "stale_users", tableType: "BASE TABLE", rows: null, comment: null },
    ]);
    await firstPending;

    expect(useSessionStore.getState().selectedSchema).toBe("public");
    expect(useSessionStore.getState().tables[0]?.name).toBe("new_users");
  });

  it("展开列 A→B→A 时旧响应不能污染列树和补全 metadata", async () => {
    const firstUsers = deferred<unknown>();
    const orders = deferred<unknown>();
    const latestUsers = deferred<unknown>();
    let usersRequestCount = 0;
    mockInvoke.mockImplementation((cmd: string, args) => {
      if (cmd !== "db_list_columns") return Promise.resolve(undefined);
      const table = (args as { table: string }).table;
      if (table === "orders") return orders.promise;
      usersRequestCount += 1;
      return usersRequestCount === 1
        ? firstUsers.promise
        : latestUsers.promise;
    });
    useSessionStore.setState({
      openId: "c1",
      activeConnection: sampleConnection("mysql"),
      selectedDb: "app",
    });

    const firstPending = useSessionStore.getState().toggleTableColumns("users");
    const ordersPending = useSessionStore.getState().toggleTableColumns("orders");
    const latestPending = useSessionStore.getState().toggleTableColumns("users");
    latestUsers.resolve([
      {
        name: "new_name",
        dataType: "varchar(20)",
        nullable: true,
        columnKey: "",
        defaultValue: null,
        comment: null,
      },
    ]);
    await latestPending;
    orders.resolve([]);
    await ordersPending;
    firstUsers.resolve([
      {
        name: "stale_name",
        dataType: "varchar(20)",
        nullable: true,
        columnKey: "",
        defaultValue: null,
        comment: null,
      },
    ]);
    await firstPending;

    const state = useSessionStore.getState();
    expect(state.expandedTable).toBe("users");
    expect(state.tableColumns[0]?.name).toBe("new_name");
    expect(state.columnsByTable.users?.[0]?.name).toBe("new_name");
  });

  it("createDatabase 成功后刷新列表并选中新库", async () => {
    useSessionStore.setState({
      openId: "c1",
      status: "connected",
      databases: [{ name: "app", isCurrent: true }],
      selectedDb: "app",
      tables: [{ name: "users", tableType: "BASE TABLE", rows: null, comment: null }],
      tabs: [
        makeTab({
          rowSet: { columns: ["id"], rows: [["1"]], truncated: false },
        }),
      ],
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
    expect(activeTab().rowSet).toBeNull();
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
      schema: null,
    });
  });

  it("markHopLost 去重累加断开跳", () => {
    useSessionStore.getState().markHopLost(1);
    useSessionStore.getState().markHopLost(1);
    useSessionStore.getState().markHopLost(0);
    expect(useSessionStore.getState().lostHops).toEqual([1, 0]);
  });

  // ===== FR-109 / T6.5：多 tab 并发与取消隔离 =====

  /** 按 SQL 文本分发 db_query 的 deferred promise，模拟两个并发查询 */
  function routeQueriesByText() {
    const deferreds = new Map<string, { promise: Promise<unknown>; resolve: (v: unknown) => void }>();
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "db_query") {
        const sql = (args as { sql: string }).sql;
        const d = deferred<unknown>();
        deferreds.set(sql, d);
        return d.promise;
      }
      return Promise.resolve(undefined);
    });
    return deferreds;
  }

  /** 取某次 db_query 调用实际使用的 queryId */
  function queryIdOf(sql: string): string {
    const call = mockInvoke.mock.calls.find(
      ([cmd, args]) =>
        cmd === "db_query" && (args as { sql: string }).sql === sql,
    );
    if (!call) throw new Error(`没有找到 ${sql} 的 db_query 调用`);
    return (call[1] as { queryId: string }).queryId;
  }

  it("两个 tab 并发执行互不污染（T6.5）", async () => {
    useSessionStore.setState({ openId: "c1" });
    const queries = routeQueriesByText();

    // tab-1 执行 A；新开 tab-2 执行 B
    const pendingA = useSessionStore.getState().executeSql("SELECT A");
    useSessionStore.getState().newTab();
    const tabBId = useSessionStore.getState().activeTabId!;
    const pendingB = useSessionStore.getState().executeSql("SELECT B");

    expect(useSessionStore.getState().tabs).toHaveLength(2);
    expect(useSessionStore.getState().tabs[0].queryRunning).toBe(true);
    expect(useSessionStore.getState().tabs[1].queryRunning).toBe(true);

    // A 先完成：只写回 A 的 tab
    queries.get("SELECT A")!.resolve({ columns: ["a"], rows: [["1"]], truncated: false });
    await pendingA;
    let tabs = useSessionStore.getState().tabs;
    expect(tabs[0].rowSet?.rows).toHaveLength(1);
    expect(tabs[0].queryRunning).toBe(false);
    expect(tabs[1].queryRunning).toBe(true);
    expect(tabs[1].rowSet).toBeNull();

    queries.get("SELECT B")!.resolve({ columns: ["b"], rows: [["2"]], truncated: false });
    await pendingB;
    tabs = useSessionStore.getState().tabs;
    expect(tabs[1].rowSet?.rows).toHaveLength(1);
    expect(useSessionStore.getState().activeTabId).toBe(tabBId);
  });

  it("取消 A tab 不影响 B tab（T6.5）", async () => {
    useSessionStore.setState({ openId: "c1" });
    const queries = routeQueriesByText();

    const pendingA = useSessionStore.getState().executeSql("SELECT A");
    useSessionStore.getState().newTab();
    void useSessionStore.getState().executeSql("SELECT B");

    // 回到 tab-1 取消 A
    useSessionStore.getState().setActiveTab("tab-1");
    await useSessionStore.getState().cancelQuery();

    expect(mockInvoke).toHaveBeenCalledWith("db_query_cancel", {
      queryId: queryIdOf("SELECT A"),
    });
    const tabs = useSessionStore.getState().tabs;
    expect(tabs[0].queryRunning).toBe(false);
    expect(tabs[0].queryErrorMsg).toBe("SQL 已取消");
    expect(tabs[1].queryRunning).toBe(true);

    // A 的 promise 迟到返回错误也不得覆盖 B
    queries.get("SELECT A")!.resolve(Promise.resolve({ columns: [], rows: [], truncated: false }));
    await pendingA;
    expect(useSessionStore.getState().tabs[1].queryRunning).toBe(true);
  });

  it("关闭执行中的 tab 先取消后端查询，关闭最后一个 tab 自动补新 tab", async () => {
    useSessionStore.setState({ openId: "c1" });
    routeQueriesByText();

    void useSessionStore.getState().executeSql("SELECT SLOW");
    const runningId = useSessionStore.getState().activeTabId!;

    await useSessionStore.getState().closeTab(runningId);

    expect(mockInvoke).toHaveBeenCalledWith("db_query_cancel", {
      queryId: queryIdOf("SELECT SLOW"),
    });
    const s = useSessionStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).not.toBe(runningId);
    expect(s.tabs[0].queryRunning).toBe(false);
  });

  it("关闭非活跃 tab 不改变当前活跃 tab", async () => {
    useSessionStore.setState({ openId: "c1" });
    useSessionStore.getState().newTab("SELECT 2");
    const activeBefore = useSessionStore.getState().activeTabId!;

    await useSessionStore.getState().closeTab("tab-1");

    const s = useSessionStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(activeBefore);
  });

  it("isTabDirty 跟随 sqlText 与 initialSql 的差异", async () => {
    const { isTabDirty } = await import("@/stores/session-store");
    expect(isTabDirty(makeTab())).toBe(false);
    expect(isTabDirty(makeTab({ sqlText: "SELECT 2" }))).toBe(true);
  });
});
