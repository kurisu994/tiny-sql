// 活跃连接会话状态（zustand）
//
// v0.1 同一时刻浏览一条已打开连接：管理连接打开/关闭、passphrase 弹窗、
// schema/table 浏览与 keepalive 断开提示。

import { create } from "zustand";

import {
  connectionApi,
  dbApi,
  translateError,
  type CreateDatabaseInput,
  type DatabaseMeta,
  type HopStatusPayload,
  type RowSet,
  type SchemaMeta,
  type StoredConnection,
  type TableMeta,
} from "@/lib/tauri-api";

/** 按 driver 方言引用标识符。 */
function quoteIdent(name: string, driver: StoredConnection["driver"]): string {
  return driver === "postgresql"
    ? '"' + name.replace(/"/g, '""') + '"'
    : "`" + name.replace(/`/g, "``") + "`";
}

type Status = "idle" | "connecting" | "connected" | "error";
type HopRuntimeStatus = "pending" | "connected" | "failed" | "lost";

export interface TopologyHopStatus {
  status: HopRuntimeStatus;
  reason: string | null;
}

function createQueryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `q_${Date.now()}_${Math.random()}`;
}

function initialHopStatuses(
  connection?: StoredConnection | null,
): Record<number, TopologyHopStatus> {
  if (!connection?.ssh.enabled) return {};
  return Object.fromEntries(
    connection.ssh.hops.map((_, index) => [
      index,
      { status: "pending" as HopRuntimeStatus, reason: null },
    ]),
  );
}

function connectedHopStatuses(
  connection?: StoredConnection | null,
): Record<number, TopologyHopStatus> {
  if (!connection?.ssh.enabled) return {};
  return Object.fromEntries(
    connection.ssh.hops.map((_, index) => [
      index,
      { status: "connected" as HopRuntimeStatus, reason: null },
    ]),
  );
}

interface SessionState {
  /** 当前打开的连接 id（未连接为 null） */
  openId: string | null;
  /** 当前正在连接 / 浏览的连接配置，用于连接中与失败态也能显示拓扑 */
  activeConnection: StoredConnection | null;
  status: Status;
  errorMsg: string | null;
  /** 需要私钥 passphrase 时挂起的连接 id（触发弹窗） */
  passphraseFor: string | null;
  databases: DatabaseMeta[];
  /** 左侧 schema 树当前展开的 database；只控制折叠视觉状态 */
  expandedDb: string | null;
  selectedDb: string | null;
  schemas: SchemaMeta[];
  expandedSchema: string | null;
  selectedSchema: string | null;
  tables: TableMeta[];
  selectedTable: string | null;
  rowSet: RowSet | null;
  loadingData: boolean;
  sqlText: string;
  queryRunning: boolean;
  currentQueryId: string | null;
  queryErrorMsg: string | null;
  hopStatuses: Record<number, TopologyHopStatus>;
  /** keepalive 已断开的跳序号 */
  lostHops: number[];

  open: (
    id: string,
    passphrase?: string,
    connection?: StoredConnection,
  ) => Promise<void>;
  close: () => Promise<void>;
  submitPassphrase: (passphrase: string) => Promise<void>;
  cancelPassphrase: () => void;
  selectDb: (db: string) => Promise<void>;
  toggleExpandedDb: (db: string) => void;
  selectSchema: (schema: string) => Promise<void>;
  toggleExpandedSchema: (schema: string) => void;
  createDatabase: (id: string, input: CreateDatabaseInput) => Promise<void>;
  selectTable: (table: string) => Promise<void>;
  setSqlText: (sql: string) => void;
  executeSql: (
    sql: string,
    options?: { rowLimit?: number; allowWrite?: boolean },
  ) => Promise<void>;
  cancelQuery: () => Promise<void>;
  markHopStatus: (payload: HopStatusPayload) => void;
  markHopLost: (hopIndex: number) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
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

  open: async (id, passphrase, connection) => {
    set({
      activeConnection: connection ?? get().activeConnection,
      status: "connecting",
      errorMsg: null,
      lostHops: [],
      hopStatuses: initialHopStatuses(connection ?? get().activeConnection),
      passphraseFor: null,
    });
    try {
      await connectionApi.open(id, passphrase);
      const databases = await dbApi.listDatabases(id);
      set({
        openId: id,
        activeConnection: connection ?? get().activeConnection,
        status: "connected",
        databases,
        expandedDb: null,
        selectedDb: null,
        schemas: [],
        expandedSchema: null,
        selectedSchema: null,
        tables: [],
        selectedTable: null,
        rowSet: null,
        hopStatuses: connectedHopStatuses(connection ?? get().activeConnection),
      });
    } catch (e) {
      const key = typeof e === "string" ? e : String(e);
      // 私钥需要 passphrase → 弹窗收集后重试
      if (key === "error.ssh.invalid_passphrase") {
        set({ status: "idle", passphraseFor: id });
        return;
      }
      set({
        status: "error",
        errorMsg: translateError(e),
        openId: null,
        activeConnection: connection ?? get().activeConnection,
      });
    }
  },

  close: async () => {
    const { openId } = get();
    if (openId) {
      try {
        await connectionApi.close(openId);
      } catch {
        // 关闭失败不阻塞 UI 复位
      }
    }
    set({
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
      sqlText: "SELECT 1",
      queryRunning: false,
      currentQueryId: null,
      queryErrorMsg: null,
      hopStatuses: {},
      lostHops: [],
    });
  },

  submitPassphrase: async (passphrase) => {
    const { passphraseFor } = get();
    if (passphraseFor) await get().open(passphraseFor, passphrase);
  },

  cancelPassphrase: () => set({ passphraseFor: null, status: "idle" }),

  selectDb: async (db) => {
    const { openId, selectedDb, activeConnection } = get();
    if (!openId) return;
    if (selectedDb === db) {
      set({ expandedDb: db });
      return;
    }
    set({
      expandedDb: db,
      selectedDb: db,
      schemas: [],
      expandedSchema: null,
      selectedSchema: null,
      tables: [],
      selectedTable: null,
      rowSet: null,
      loadingData: true,
    });
    try {
      if (activeConnection?.driver === "postgresql") {
        const schemas = await dbApi.listSchemas(openId, db);
        if (get().selectedDb !== db) return;
        set({ schemas, loadingData: false });
        return;
      }
      const tables = await dbApi.listTables(openId, db, null);
      if (get().selectedDb !== db) return;
      set({ tables, loadingData: false });
    } catch (e) {
      if (get().selectedDb !== db) return;
      set({ errorMsg: translateError(e), loadingData: false });
    }
  },

  toggleExpandedDb: (db) =>
    set((s) => {
      if (s.selectedDb !== db) return s;
      return { expandedDb: s.expandedDb === db ? null : db };
    }),

  selectSchema: async (schema) => {
    const { openId, selectedDb, selectedSchema } = get();
    if (!openId || !selectedDb) return;
    if (selectedSchema === schema) {
      set({ expandedSchema: schema });
      return;
    }
    set({
      expandedSchema: schema,
      selectedSchema: schema,
      tables: [],
      selectedTable: null,
      rowSet: null,
      loadingData: true,
    });
    try {
      const tables = await dbApi.listTables(openId, selectedDb, schema);
      if (get().selectedDb !== selectedDb || get().selectedSchema !== schema) return;
      set({ tables, loadingData: false });
    } catch (error) {
      if (get().selectedDb !== selectedDb || get().selectedSchema !== schema) return;
      set({ errorMsg: translateError(error), loadingData: false });
    }
  },

  toggleExpandedSchema: (schema) =>
    set((state) => {
      if (state.selectedSchema !== schema) return state;
      return {
        expandedSchema: state.expandedSchema === schema ? null : schema,
      };
    }),

  createDatabase: async (id, input) => {
    const { openId } = get();
    if (openId !== id) {
      const err = "error.connection.not_open";
      set({ errorMsg: translateError(err) });
      return Promise.reject(err);
    }
    const name = input.name.trim();
    set({
      loadingData: true,
      errorMsg: null,
      queryErrorMsg: null,
    });
    try {
      await dbApi.createDatabase(id, {
        name,
        charset: input.charset,
        collation: input.collation,
      });
      const databases = await dbApi.listDatabases(id);
      set({
        databases,
        expandedDb: name,
        selectedDb: name,
        schemas: [],
        expandedSchema: null,
        selectedSchema: null,
        tables: [],
        selectedTable: null,
        rowSet: null,
        loadingData: false,
      });
    } catch (e) {
      set({ errorMsg: translateError(e), loadingData: false });
      throw e;
    }
  },

  selectTable: async (table) => {
    const { openId, selectedDb, selectedSchema, activeConnection } = get();
    if (!openId || !selectedDb) return;
    const driver = activeConnection?.driver ?? "mysql";
    const namespace = driver === "postgresql" ? selectedSchema : selectedDb;
    if (!namespace) return;
    const sql = `SELECT * FROM ${quoteIdent(namespace, driver)}.${quoteIdent(table, driver)}`;
    const queryId = createQueryId();
    set({
      selectedTable: table,
      loadingData: true,
      queryRunning: true,
      currentQueryId: queryId,
      queryErrorMsg: null,
      sqlText: sql,
    });
    try {
      const rowSet = await dbApi.query(openId, sql, {
        queryId,
        rowLimit: 1000,
      });
      set({
        rowSet,
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
      });
    } catch (e) {
      set({
        errorMsg: translateError(e),
        queryErrorMsg: translateError(e),
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
        rowSet: null,
      });
    }
  },

  setSqlText: (sqlText) => set({ sqlText }),

  executeSql: async (sql, options) => {
    const { openId } = get();
    if (!openId) return;
    const queryId = createQueryId();
    set({
      sqlText: sql,
      loadingData: true,
      queryRunning: true,
      currentQueryId: queryId,
      queryErrorMsg: null,
      rowSet: null,
    });
    try {
      const rowSet = await dbApi.query(openId, sql, {
        queryId,
        rowLimit: options?.rowLimit ?? 100000,
        allowWrite: options?.allowWrite ?? false,
      });
      set({
        rowSet,
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
      });
    } catch (e) {
      set({
        queryErrorMsg: translateError(e),
        errorMsg: translateError(e),
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
      });
    }
  },

  cancelQuery: async () => {
    const { currentQueryId } = get();
    if (!currentQueryId) return;
    try {
      await dbApi.cancelQuery(currentQueryId);
    } catch {
      // 取消失败不阻塞 UI 停止等待；后端 query promise 会返回最终错误。
    }
    set({
      queryRunning: false,
      loadingData: false,
      currentQueryId: null,
      queryErrorMsg: "SQL 已取消",
    });
  },

  markHopStatus: (payload) =>
    set((s) => {
      if (s.activeConnection?.id && payload.connectionId !== s.activeConnection.id) {
        return s;
      }
      const next = {
        ...s.hopStatuses,
        [payload.hopIndex]: {
          status: payload.status,
          reason: payload.reason,
        },
      };
      const lostHops =
        payload.status === "lost" && !s.lostHops.includes(payload.hopIndex)
          ? [...s.lostHops, payload.hopIndex]
          : s.lostHops;
      return { hopStatuses: next, lostHops };
    }),

  markHopLost: (hopIndex) =>
    set((s) =>
      s.lostHops.includes(hopIndex)
        ? s
        : { lostHops: [...s.lostHops, hopIndex] },
    ),
}));
