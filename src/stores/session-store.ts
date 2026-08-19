// 活跃连接会话状态（zustand）
//
// v0.2 起查询工作台为多 tab（FR-109）：SQL 文本、结果集、query_id、取消 token、
// 表预览来源与 dirty state 全部按 tab 隔离；连接级状态（schema 树、拓扑、
// passphrase 弹窗）仍由本 store 统一管理。

import { create } from "zustand";

import {
  metadataCache,
  type MetadataCacheKey,
  type MetadataResource,
} from "@/lib/metadata-cache";
import { invalidatesMetadataCache } from "@/lib/sql-guard";
import {
  connectionApi,
  dbApi,
  translateError,
  type CreateDatabaseInput,
  type ColumnMeta,
  type DatabaseMeta,
  type HopStatusPayload,
  type HopRttPayload,
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
  rttState: "idle" | HopRttPayload["state"];
  rttMs: number | null;
}

/** 单个查询 tab 的完整独立状态（FR-109）。 */
export interface QueryTab {
  id: string;
  title: string;
  sqlText: string;
  /** 创建/执行表预览时的初始 SQL；与 sqlText 不等即为 dirty */
  initialSql: string;
  rowSet: RowSet | null;
  loadingData: boolean;
  queryRunning: boolean;
  /** 本 tab 正在执行的 query_id；取消只作用于该 token */
  currentQueryId: string | null;
  queryErrorMsg: string | null;
  /** 表预览来源（底部状态栏展示用），自由 SQL 为 null */
  selectedTable: string | null;
}

/** tab 是否有未执行的修改（关闭前需要确认）。 */
export function isTabDirty(tab: QueryTab): boolean {
  return tab.sqlText !== tab.initialSql;
}

function createQueryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `q_${Date.now()}_${Math.random()}`;
}

let tabSerial = 0;
let tabCounter = 0;

function createTab(title?: string, sql = "SELECT 1"): QueryTab {
  tabCounter += 1;
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `tab_${Date.now()}_${tabSerial++}`,
    title: title ?? `查询 ${tabCounter}`,
    sqlText: sql,
    initialSql: sql,
    rowSet: null,
    loadingData: false,
    queryRunning: false,
    currentQueryId: null,
    queryErrorMsg: null,
    selectedTable: null,
  };
}

/** 打开连接后的初始 tab 组。 */
function initialTabs(): { tabs: QueryTab[]; activeTabId: string } {
  const tab = createTab();
  return { tabs: [tab], activeTabId: tab.id };
}

/** 重连 / 建库后保留各 tab 的 SQL 文本，只复位执行态与结果（v0.1 行为延续）。 */
function resetTabExecution(tabs: QueryTab[]): QueryTab[] {
  return tabs.map((t) => ({
    ...t,
    rowSet: null,
    loadingData: false,
    queryRunning: false,
    currentQueryId: null,
    queryErrorMsg: null,
  }));
}

/** 从 state 中取当前活跃 tab。 */
export function selectActiveTab(s: {
  tabs: QueryTab[];
  activeTabId: string | null;
}): QueryTab | null {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
}

function metadataKey(
  connectionId: string,
  driver: StoredConnection["driver"],
  database: string,
  schema: string | null,
  resource: MetadataResource,
  table?: string,
): MetadataCacheKey {
  return { connectionId, driver, database, schema, resource, table };
}

// 单会话 metadata 请求序号：即使选择发生 A→B→A，旧 A 也不能覆盖新 A。
let metadataRequestEpoch = 0;
let sessionRequestEpoch = 0;

function beginSessionRequest(): number {
  sessionRequestEpoch += 1;
  return sessionRequestEpoch;
}

function invalidateSessionRequests(): void {
  sessionRequestEpoch += 1;
}

function isCurrentSessionRequest(epoch: number): boolean {
  return epoch === sessionRequestEpoch;
}

function beginMetadataRequest(): number {
  metadataRequestEpoch += 1;
  return metadataRequestEpoch;
}

function invalidateMetadataRequests(): void {
  metadataRequestEpoch += 1;
}

function isCurrentMetadataRequest(epoch: number): boolean {
  return epoch === metadataRequestEpoch;
}

/** 提取后端返回的 i18n 错误 key，用于识别需要特殊引导的错误。 */
function errorKey(e: unknown): string {
  return typeof e === "string" ? e : String(e);
}

function initialHopStatuses(
  connection?: StoredConnection | null,
): Record<number, TopologyHopStatus> {
  if (!connection?.ssh.enabled) return {};
  return Object.fromEntries(
    connection.ssh.hops.map((_, index) => [
      index,
      {
        status: "pending" as HopRuntimeStatus,
        reason: null,
        rttState: "idle" as const,
        rttMs: null,
      },
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
      {
        status: "connected" as HopRuntimeStatus,
        reason: null,
        rttState: "idle" as const,
        rttMs: null,
      },
    ]),
  );
}

interface SessionState {
  /** 当前打开的连接 id（未连接为 null） */
  openId: string | null;
  /** 后端每次成功打开生成的会话代号，用于拒绝重连前的迟到事件。 */
  runtimeSessionId: string | null;
  /** 当前正在连接 / 浏览的连接配置，用于连接中与失败态也能显示拓扑 */
  activeConnection: StoredConnection | null;
  status: Status;
  errorMsg: string | null;
  /** PostgreSQL 选中了非当前 database 时的待切换目标（触发「一键切换」引导） */
  pendingDbSwitch: string | null;
  /** 本次 session 生效的 database 覆盖（PG 一键切库）；不写回持久化配置 */
  switchedDatabase: string | null;
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
  /** 当前展开列信息的表；数据来自按命名空间分区的内存 LRU cache。 */
  expandedTable: string | null;
  tableColumns: ColumnMeta[];
  /** 当前 database/schema 已加载过的各表列，供 CodeMirror schema-aware 补全。 */
  columnsByTable: Record<string, ColumnMeta[]>;
  loadingColumns: boolean;
  refreshingMetadata: boolean;
  /** schema 树加载（selectDb/selectSchema/createDatabase）指示 */
  loadingData: boolean;
  /** 查询 tab 列表与当前活跃 tab（FR-109） */
  tabs: QueryTab[];
  activeTabId: string | null;
  hopStatuses: Record<number, TopologyHopStatus>;
  /** keepalive 已断开的跳序号 */
  lostHops: number[];

  open: (
    id: string,
    passphrase?: string,
    connection?: StoredConnection,
    rememberPassphrase?: boolean,
  ) => Promise<void>;
  reconnect: (connection?: StoredConnection) => Promise<void>;
  /** 以 session 级覆盖切到 pendingDbSwitch 目标库（不改保存的连接配置） */
  switchDatabase: () => Promise<void>;
  close: () => Promise<void>;
  submitPassphrase: (passphrase: string, remember?: boolean) => Promise<void>;
  cancelPassphrase: () => void;
  selectDb: (db: string) => Promise<void>;
  toggleExpandedDb: (db: string) => void;
  selectSchema: (schema: string) => Promise<void>;
  toggleExpandedSchema: (schema: string) => void;
  toggleTableColumns: (table: string) => Promise<void>;
  refreshMetadata: () => Promise<void>;
  createDatabase: (id: string, input: CreateDatabaseInput) => Promise<void>;
  /** 双击表：新开 tab 执行前 1000 行预览 */
  selectTable: (table: string) => Promise<void>;
  /** 新建查询 tab 并激活 */
  newTab: (sql?: string) => void;
  /** 关闭 tab；正在执行的查询会先取消。dirty 确认由 UI 层完成 */
  closeTab: (id: string) => Promise<void>;
  setActiveTab: (id: string) => void;
  setSqlText: (sql: string) => void;
  executeSql: (
    sql: string,
    options?: { rowLimit?: number; allowWrite?: boolean },
  ) => Promise<void>;
  cancelQuery: () => Promise<void>;
  markHopStatus: (payload: HopStatusPayload) => void;
  markHopRtt: (payload: HopRttPayload) => void;
  markHopLost: (hopIndex: number) => void;
}

/** 用 patch 更新指定 tab。 */
function patchTab(
  tabs: QueryTab[],
  id: string,
  patch: Partial<QueryTab>,
): QueryTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

export const useSessionStore = create<SessionState>((set, get) => ({
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
  ...initialTabs(),
  hopStatuses: {},
  lostHops: [],

  open: async (id, passphrase, connection, rememberPassphrase) => {
    const requestEpoch = beginSessionRequest();
    invalidateMetadataRequests();
    const previousOpenId = get().openId;
    const previousSessionId = get().runtimeSessionId;
    set({
      activeConnection: connection ?? get().activeConnection,
      openId: null,
      runtimeSessionId: null,
      status: "connecting",
      errorMsg: null,
      pendingDbSwitch: null,
      switchedDatabase: null,
      lostHops: [],
      hopStatuses: initialHopStatuses(connection ?? get().activeConnection),
      passphraseFor: null,
      loadingData: false,
      ...initialTabs(),
    });
    let openedSessionId: string | null = null;
    try {
      if (previousOpenId && previousOpenId !== id) {
        await connectionApi.close(previousOpenId, previousSessionId ?? undefined);
        metadataCache.clearConnection(previousOpenId);
        if (!isCurrentSessionRequest(requestEpoch)) return;
      }
      openedSessionId = await connectionApi.open(id, passphrase, rememberPassphrase);
      if (!isCurrentSessionRequest(requestEpoch)) return;
      set({ openId: id, runtimeSessionId: openedSessionId });
      metadataCache.clearConnection(id);
      const databases = await dbApi.listDatabases(id);
      if (!isCurrentSessionRequest(requestEpoch)) return;
      set({
        openId: id,
        runtimeSessionId: openedSessionId,
        activeConnection: connection ?? get().activeConnection,
        status: "connected",
        databases,
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
        ...initialTabs(),
        hopStatuses: connectedHopStatuses(connection ?? get().activeConnection),
      });
    } catch (e) {
      if (!isCurrentSessionRequest(requestEpoch)) return;
      const key = typeof e === "string" ? e : String(e);
      // 私钥需要 passphrase → 弹窗收集后重试
      if (key === "error.ssh.invalid_passphrase") {
        set({ status: "idle", passphraseFor: id });
        return;
      }
      set({
        status: "error",
        errorMsg: translateError(e),
        openId: openedSessionId ? id : null,
        runtimeSessionId: openedSessionId,
        activeConnection: connection ?? get().activeConnection,
      });
    }
  },

  reconnect: async (connection) => {
    const current = connection ?? get().activeConnection;
    const id = current?.id ?? get().openId;
    if (!id || !current) return;
    const expectedSessionId = get().runtimeSessionId;
    const requestEpoch = beginSessionRequest();
    invalidateMetadataRequests();
    metadataCache.clearConnection(id);
    set({
      openId: id,
      runtimeSessionId: null,
      activeConnection: current,
      status: "connecting",
      errorMsg: null,
      pendingDbSwitch: null,
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
      tabs: resetTabExecution(get().tabs),
      hopStatuses: initialHopStatuses(current),
      lostHops: [],
    });
    let openedSessionId: string | null = null;
    try {
      openedSessionId = await connectionApi.reconnect(
        id,
        expectedSessionId ?? undefined,
        undefined,
        get().switchedDatabase ?? undefined,
      );
      if (!isCurrentSessionRequest(requestEpoch)) return;
      set({ runtimeSessionId: openedSessionId });
      const databases = await dbApi.listDatabases(id);
      if (!isCurrentSessionRequest(requestEpoch)) return;
      set({
        openId: id,
        runtimeSessionId: openedSessionId,
        status: "connected",
        databases,
        hopStatuses: connectedHopStatuses(current),
      });
    } catch (e) {
      if (!isCurrentSessionRequest(requestEpoch)) return;
      const key = typeof e === "string" ? e : String(e);
      if (key === "error.ssh.invalid_passphrase") {
        set({
          openId: null,
          runtimeSessionId: null,
          status: "idle",
          passphraseFor: id,
        });
        return;
      }
      set({
        openId: openedSessionId ? id : null,
        runtimeSessionId: openedSessionId,
        status: "error",
        errorMsg: translateError(e),
      });
    }
  },

  // PostgreSQL 不能在同一条连接上切 database：以 session 级 override 走标准重连
  // 重建连接池（不写回持久化配置，重新打开仍是原 database），成功后自动选中目标库。
  switchDatabase: async () => {
    const { openId, pendingDbSwitch } = get();
    if (!openId || !pendingDbSwitch) return;
    const target = pendingDbSwitch;
    set({ pendingDbSwitch: null, errorMsg: null, switchedDatabase: target });
    await get().reconnect();
    if (get().status !== "connected" || get().openId !== openId) return;
    await get().selectDb(target);
  },

  close: async () => {
    invalidateSessionRequests();
    invalidateMetadataRequests();
    const { openId, runtimeSessionId } = get();
    set({
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
      ...initialTabs(),
      hopStatuses: {},
      lostHops: [],
    });
    if (openId) {
      try {
        await connectionApi.close(openId, runtimeSessionId ?? undefined);
      } catch {
        // 关闭失败不阻塞 UI 复位
      }
      metadataCache.clearConnection(openId);
    }
  },

  submitPassphrase: async (passphrase, remember) => {
    const { passphraseFor } = get();
    if (passphraseFor) await get().open(passphraseFor, passphrase, undefined, remember);
  },

  cancelPassphrase: () => set({ passphraseFor: null, status: "idle" }),

  selectDb: async (db) => {
    const { openId, selectedDb, activeConnection } = get();
    if (!openId) return;
    if (selectedDb === db) {
      set({ expandedDb: db });
      return;
    }
    const requestEpoch = beginMetadataRequest();
    set({
      expandedDb: db,
      selectedDb: db,
      schemas: [],
      expandedSchema: null,
      selectedSchema: null,
      tables: [],
      expandedTable: null,
      tableColumns: [],
      columnsByTable: {},
      loadingColumns: false,
      refreshingMetadata: false,
      loadingData: true,
    });
    try {
      const driver = activeConnection?.driver ?? "mysql";
      if (activeConnection?.driver === "postgresql") {
        const key = metadataKey(openId, driver, db, null, "schemas");
        const cached = metadataCache.get<SchemaMeta[]>(key);
        if (cached) {
          if (!isCurrentMetadataRequest(requestEpoch) || get().selectedDb !== db)
            return;
          set({ schemas: cached, loadingData: false, errorMsg: null, pendingDbSwitch: null });
          return;
        }
        const schemas = await dbApi.listSchemas(openId, db);
        if (!isCurrentMetadataRequest(requestEpoch) || get().selectedDb !== db)
          return;
        metadataCache.set(key, schemas);
        set({ schemas, loadingData: false, errorMsg: null, pendingDbSwitch: null });
        return;
      }
      const key = metadataKey(openId, driver, db, null, "tables");
      const cached = metadataCache.get<TableMeta[]>(key);
      if (cached) {
        if (!isCurrentMetadataRequest(requestEpoch) || get().selectedDb !== db)
          return;
        set({ tables: cached, loadingData: false, errorMsg: null, pendingDbSwitch: null });
        return;
      }
      const tables = await dbApi.listTables(openId, db, null);
      if (!isCurrentMetadataRequest(requestEpoch) || get().selectedDb !== db)
        return;
      metadataCache.set(key, tables);
      set({ tables, loadingData: false, errorMsg: null, pendingDbSwitch: null });
    } catch (e) {
      if (!isCurrentMetadataRequest(requestEpoch) || get().selectedDb !== db)
        return;
      // PG 跨 database 访问给出「一键切换」引导，而不是只显示错误
      set({
        errorMsg: translateError(e),
        pendingDbSwitch:
          errorKey(e) === "error.driver.database_switch_required" ? db : null,
        loadingData: false,
      });
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
    const requestEpoch = beginMetadataRequest();
    set({
      expandedSchema: schema,
      selectedSchema: schema,
      tables: [],
      expandedTable: null,
      tableColumns: [],
      columnsByTable: {},
      loadingColumns: false,
      refreshingMetadata: false,
      loadingData: true,
    });
    try {
      const driver = get().activeConnection?.driver ?? "postgresql";
      const key = metadataKey(
        openId,
        driver,
        selectedDb,
        schema,
        "tables",
      );
      const cached = metadataCache.get<TableMeta[]>(key);
      if (cached) {
        if (
          !isCurrentMetadataRequest(requestEpoch) ||
          get().selectedDb !== selectedDb ||
          get().selectedSchema !== schema
        )
          return;
        set({ tables: cached, loadingData: false });
        return;
      }
      const tables = await dbApi.listTables(openId, selectedDb, schema);
      if (
        !isCurrentMetadataRequest(requestEpoch) ||
        get().selectedDb !== selectedDb ||
        get().selectedSchema !== schema
      )
        return;
      metadataCache.set(key, tables);
      set({ tables, loadingData: false });
    } catch (error) {
      if (
        !isCurrentMetadataRequest(requestEpoch) ||
        get().selectedDb !== selectedDb ||
        get().selectedSchema !== schema
      )
        return;
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

  toggleTableColumns: async (table) => {
    const {
      openId,
      selectedDb,
      selectedSchema,
      activeConnection,
      expandedTable,
    } = get();
    if (!openId || !selectedDb) return;
    if (expandedTable === table) {
      invalidateMetadataRequests();
      set({
        expandedTable: null,
        tableColumns: [],
        loadingColumns: false,
        refreshingMetadata: false,
      });
      return;
    }
    const schema =
      activeConnection?.driver === "postgresql" ? selectedSchema : null;
    if (activeConnection?.driver === "postgresql" && !schema) return;
    const requestEpoch = beginMetadataRequest();
    const driver = activeConnection?.driver ?? "mysql";
    const key = metadataKey(
      openId,
      driver,
      selectedDb,
      schema,
      "columns",
      table,
    );

    set({
      expandedTable: table,
      tableColumns: [],
      loadingColumns: true,
      refreshingMetadata: false,
      errorMsg: null,
    });
    try {
      const cached = metadataCache.get<ColumnMeta[]>(key);
      if (cached) {
        if (
          !isCurrentMetadataRequest(requestEpoch) ||
          get().expandedTable !== table
        )
          return;
        set((state) => ({
          tableColumns: cached,
          columnsByTable: { ...state.columnsByTable, [table]: cached },
          loadingColumns: false,
        }));
        return;
      }
      const tableColumns = await dbApi.listColumns(
        openId,
        selectedDb,
        schema,
        table,
      );
      const current = get();
      if (
        !isCurrentMetadataRequest(requestEpoch) ||
        current.openId !== openId ||
        current.selectedDb !== selectedDb ||
        current.selectedSchema !== selectedSchema ||
        current.expandedTable !== table
      ) {
        return;
      }
      metadataCache.set(key, tableColumns);
      set((state) => ({
        tableColumns,
        columnsByTable: { ...state.columnsByTable, [table]: tableColumns },
        loadingColumns: false,
      }));
    } catch (error) {
      const current = get();
      if (
        !isCurrentMetadataRequest(requestEpoch) ||
        current.openId !== openId ||
        current.selectedDb !== selectedDb ||
        current.selectedSchema !== selectedSchema ||
        current.expandedTable !== table
      ) {
        return;
      }
      set({ errorMsg: translateError(error), loadingColumns: false });
    }
  },

  refreshMetadata: async () => {
    const {
      openId,
      activeConnection,
      selectedDb,
      selectedSchema,
      expandedTable,
    } = get();
    if (!openId || !activeConnection) return;
    const requestEpoch = beginMetadataRequest();
    if (!selectedDb) {
      set({ refreshingMetadata: true, errorMsg: null, pendingDbSwitch: null });
      try {
        const databases = await dbApi.listDatabases(openId);
        if (
          !isCurrentMetadataRequest(requestEpoch) ||
          get().openId !== openId ||
          get().selectedDb !== null
        )
          return;
        set({ databases, refreshingMetadata: false });
      } catch (error) {
        if (
          !isCurrentMetadataRequest(requestEpoch) ||
          get().openId !== openId ||
          get().selectedDb !== null
        )
          return;
        set({
          errorMsg: translateError(error),
          refreshingMetadata: false,
        });
      }
      return;
    }
    const driver = activeConnection.driver;
    const schema = driver === "postgresql" ? selectedSchema : null;
    metadataCache.invalidateScope({
      connectionId: openId,
      driver,
      database: selectedDb,
    });
    set({
      refreshingMetadata: true,
      loadingColumns: expandedTable !== null,
      errorMsg: null,
      pendingDbSwitch: null,
    });

    try {
      const databasesPromise = dbApi.listDatabases(openId);
      const schemasPromise =
        driver === "postgresql"
          ? dbApi.listSchemas(openId, selectedDb)
          : Promise.resolve<SchemaMeta[] | null>(null);
      const tablesPromise =
        driver === "mysql" || schema
          ? dbApi.listTables(openId, selectedDb, schema)
          : Promise.resolve<TableMeta[] | null>(null);
      const columnsPromise =
        expandedTable && (driver === "mysql" || schema)
          ? dbApi.listColumns(openId, selectedDb, schema, expandedTable)
          : Promise.resolve<ColumnMeta[] | null>(null);
      const [databases, schemas, tables, tableColumns] = await Promise.all([
        databasesPromise,
        schemasPromise,
        tablesPromise,
        columnsPromise,
      ]);
      const current = get();
      if (
        !isCurrentMetadataRequest(requestEpoch) ||
        current.openId !== openId ||
        current.selectedDb !== selectedDb ||
        current.selectedSchema !== selectedSchema ||
        current.expandedTable !== expandedTable
      ) {
        return;
      }
      if (schemas) {
        metadataCache.set(
          metadataKey(openId, driver, selectedDb, null, "schemas"),
          schemas,
        );
      }
      if (tables) {
        metadataCache.set(
          metadataKey(openId, driver, selectedDb, schema, "tables"),
          tables,
        );
      }
      if (tableColumns && expandedTable) {
        metadataCache.set(
          metadataKey(
            openId,
            driver,
            selectedDb,
            schema,
            "columns",
            expandedTable,
          ),
          tableColumns,
        );
      }
      set({
        databases,
        ...(schemas ? { schemas } : {}),
        ...(tables ? { tables } : {}),
        ...(tableColumns ? { tableColumns } : {}),
        columnsByTable:
          tableColumns && expandedTable
            ? { [expandedTable]: tableColumns }
            : {},
        refreshingMetadata: false,
        loadingColumns: false,
      });
    } catch (error) {
      const current = get();
      if (
        !isCurrentMetadataRequest(requestEpoch) ||
        current.openId !== openId ||
        current.selectedDb !== selectedDb ||
        current.selectedSchema !== selectedSchema
      ) {
        return;
      }
      set({
        errorMsg: translateError(error),
        pendingDbSwitch:
          errorKey(error) === "error.driver.database_switch_required"
            ? selectedDb
            : null,
        refreshingMetadata: false,
        loadingColumns: false,
      });
    }
  },

  createDatabase: async (id, input) => {
    const { openId } = get();
    if (openId !== id) {
      const err = "error.connection.not_open";
      set({ errorMsg: translateError(err) });
      return Promise.reject(err);
    }
    const name = input.name.trim();
    const requestEpoch = beginMetadataRequest();
    set({
      loadingData: true,
      errorMsg: null,
    });
    try {
      await dbApi.createDatabase(id, {
        name,
        charset: input.charset,
        collation: input.collation,
      });
      metadataCache.clearConnection(id);
      const databases = await dbApi.listDatabases(id);
      if (!isCurrentMetadataRequest(requestEpoch)) return;
      set({
        databases,
        expandedDb: name,
        selectedDb: name,
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
        tabs: resetTabExecution(get().tabs),
      });
    } catch (e) {
      if (!isCurrentMetadataRequest(requestEpoch)) return;
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
    // 已存在同一张表的预览 tab（initialSql 与预览 SQL 一致）时直接激活，
    // 避免双击/反复点击同一表产生重复 tab；不覆盖用户在其他 tab 的 SQL
    const existing = get().tabs.find(
      (t) => t.selectedTable === table && t.initialSql === sql,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab = createTab(table, sql);
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    }));
    await runTabQuery(get, set, tab.id, sql, { rowLimit: 1000 }, table);
  },

  newTab: (sql) => {
    const tab = createTab(undefined, sql);
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    // 关闭正在执行的 tab：先取消后端查询，本 tab 的迟到结果随 tab 移除自然失效
    if (tab.currentQueryId) {
      try {
        await dbApi.cancelQuery(tab.currentQueryId);
      } catch {
        // 取消失败不阻塞关闭
      }
    }
    set((s) => {
      let tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (tabs.length === 0) {
        const fresh = createTab();
        tabs = [fresh];
        activeTabId = fresh.id;
      } else if (activeTabId === id) {
        activeTabId = tabs[tabs.length - 1].id;
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => {
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
    }
  },

  setSqlText: (sql) => {
    const { activeTabId } = get();
    if (!activeTabId) return;
    set((s) => ({ tabs: patchTab(s.tabs, activeTabId, { sqlText: sql }) }));
  },

  executeSql: async (sql, options) => {
    const { activeTabId } = get();
    if (!activeTabId) return;
    await runTabQuery(get, set, activeTabId, sql, {
      rowLimit: options?.rowLimit ?? 100000,
      allowWrite: options?.allowWrite ?? false,
    });
  },

  cancelQuery: async () => {
    const tab = selectActiveTab(get());
    if (!tab?.currentQueryId) return;
    const queryId = tab.currentQueryId;
    try {
      await dbApi.cancelQuery(queryId);
    } catch {
      // 取消失败不阻塞 UI 停止等待；后端 query promise 会返回最终错误。
    }
    const current = get().tabs.find((t) => t.id === tab.id);
    if (current?.currentQueryId !== queryId) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tab.id, {
        queryRunning: false,
        loadingData: false,
        currentQueryId: null,
        queryErrorMsg: "SQL 已取消",
      }),
    }));
  },

  markHopStatus: (payload) =>
    set((s) => {
      if (
        !s.runtimeSessionId ||
        payload.sessionId !== s.runtimeSessionId ||
        (s.activeConnection?.id && payload.connectionId !== s.activeConnection.id)
      ) {
        return s;
      }
      const next = {
        ...s.hopStatuses,
        [payload.hopIndex]: {
          ...s.hopStatuses[payload.hopIndex],
          status: payload.status,
          reason: payload.reason,
          rttState: s.hopStatuses[payload.hopIndex]?.rttState ?? "idle",
          rttMs: s.hopStatuses[payload.hopIndex]?.rttMs ?? null,
        },
      };
      const lostHops =
        payload.status === "lost" && !s.lostHops.includes(payload.hopIndex)
          ? [...s.lostHops, payload.hopIndex]
          : s.lostHops;
      return { hopStatuses: next, lostHops };
    }),

  markHopRtt: (payload) =>
    set((s) => {
      if (
        !s.runtimeSessionId ||
        payload.sessionId !== s.runtimeSessionId ||
        (s.activeConnection?.id && payload.connectionId !== s.activeConnection.id)
      ) {
        return s;
      }
      const measured =
        payload.state === "measured" &&
        payload.rttMs !== null &&
        Number.isFinite(payload.rttMs) &&
        payload.rttMs >= 0;
      const current = s.hopStatuses[payload.hopIndex] ?? {
        status: "connected" as HopRuntimeStatus,
        reason: null,
        rttState: "idle" as const,
        rttMs: null,
      };
      return {
        hopStatuses: {
          ...s.hopStatuses,
          [payload.hopIndex]: {
            ...current,
            rttState:
              payload.state === "measured" && !measured
                ? "unavailable"
                : payload.state,
            rttMs: measured ? payload.rttMs : null,
          },
        },
      };
    }),

  markHopLost: (hopIndex) =>
    set((s) =>
      s.lostHops.includes(hopIndex)
        ? s
        : { lostHops: [...s.lostHops, hopIndex] },
    ),
}));

/** set/get 签名别名，供 tab 查询辅助函数使用。 */
type Get = () => SessionState;
type Set = (fn: (s: SessionState) => Partial<SessionState>) => void;

/**
 * 在指定 tab 上执行 SQL：query_id / 取消 token / 结果全部 tab 隔离。
 * 迟到守卫：只有 tab 当前 query_id 仍匹配时才写回结果（T6.5 并发隔离）。
 */
async function runTabQuery(
  get: Get,
  set: Set,
  tabId: string,
  sql: string,
  options: { rowLimit: number; allowWrite?: boolean },
  selectedTable: string | null = null,
): Promise<void> {
  const openId = get().openId;
  if (!openId) return;
  const queryId = createQueryId();
  const schema =
    get().activeConnection?.driver === "postgresql"
      ? get().selectedSchema
      : null;
  set((s) => ({
    tabs: patchTab(s.tabs, tabId, {
      sqlText: sql,
      selectedTable,
      loadingData: true,
      queryRunning: true,
      currentQueryId: queryId,
      queryErrorMsg: null,
      rowSet: null,
    }),
  }));
  try {
    const rowSet = await dbApi.query(openId, sql, {
      queryId,
      rowLimit: options.rowLimit,
      allowWrite: options.allowWrite ?? false,
      schema,
    });
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || tab.currentQueryId !== queryId) return;
    if (invalidatesMetadataCache(sql)) {
      invalidateMetadataRequests();
      metadataCache.clearConnection(openId);
      set((s) => ({
        expandedTable: null,
        tableColumns: [],
        columnsByTable: {},
        loadingColumns: false,
      }));
    }
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        rowSet,
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
      }),
    }));
  } catch (e) {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || tab.currentQueryId !== queryId) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        queryErrorMsg: translateError(e),
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
        rowSet: null,
      }),
      errorMsg: translateError(e),
    }));
  }
}
