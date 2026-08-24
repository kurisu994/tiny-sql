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
  transactionApi,
  translateError,
  type CreateDatabaseInput,
  type ColumnMeta,
  type ConstraintMeta,
  type DatabaseMeta,
  type EditCell,
  type HopStatusPayload,
  type HopRttPayload,
  type IndexMeta,
  type RowSet,
  type SchemaMeta,
  type StatementResult,
  type StoredConnection,
  type TableEdit,
  type TableFilter,
  type TableMeta,
  type TableOrder,
  sqlFileApi,
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
  /** 事务 session（FR-244）：存在时本 tab 所有语句走绑定同一物理连接的独占 session */
  transaction: TabTransaction | null;
  /** 表数据浏览（FR-242）：非空时本 tab 为浏览模式（无 SQL 编辑器，工具栏 + 分页） */
  browse: BrowseState | null;
  /** 多语句执行结果（FR-243）：非空时结果区按多结果集展示 */
  multiResults: StatementResult[] | null;
  /** 多结果集中当前查看的结果下标 */
  activeResultIndex: number;
  /** 最近一次执行的错误 key（写确认重试等 UI 流程判断用） */
  lastErrorKey: string | null;
  /** 关联的 SQL 文件路径（FR-240）；保存后 initialSql 同步为已保存内容 */
  filePath: string | null;
}

/** tab 绑定的事务 session 状态（FR-244）。 */
export interface TabTransaction {
  sessionId: string;
  /** 后端跟踪的事务开关（含 PG aborted 状态）；用户手写 COMMIT/ROLLBACK 后同步 */
  inTransaction: boolean;
}

/** 表数据浏览状态（FR-242）：服务端筛选 / 排序 / 分页。 */
export interface BrowseState {
  table: string;
  filters: TableFilter[];
  order: TableOrder | null;
  /** 0 起页码 */
  page: number;
  pageSize: number;
  /** 满足筛选的总行数；COUNT 超时/失败为 null（降级未知总数分页） */
  total: number | null;
  hasNextPage: boolean;
  /** 是否可编辑（表有显式主键；FR-250） */
  editable: boolean;
  /** 主键列（顺序与后端约束一致；FR-250） */
  pkColumns: string[];
  /** 是否处于编辑模式（FR-250） */
  editMode: boolean;
  /** 待提交的编辑操作（dirty state；FR-250） */
  pendingEdits: PendingEdit[];
  /** 编辑批正在提交 */
  submitting: boolean;
}

/** 单条待提交的表编辑（FR-250）。 */
export interface PendingEdit {
  /** 行标识：现有行主键值 JSON；新增行为临时 id（"__new_xxx"） */
  rowKey: string;
  kind: "insert" | "update" | "delete";
  /** 原始行快照（update/delete 定位主键与恢复用；insert 为 null） */
  original: Record<string, string | null> | null;
  /** insert：用户填写的列值；update：变更列值；delete：空 */
  values: Record<string, string | null>;
}

/** tab 是否有未执行的修改（关闭前需要确认）。浏览 tab 编辑模式下有 pendingEdits 即 dirty。 */
export function isTabDirty(tab: QueryTab): boolean {
  if (tab.browse) {
    return tab.browse.editMode && tab.browse.pendingEdits.length > 0;
  }
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
    transaction: null,
    browse: null,
    multiResults: null,
    activeResultIndex: 0,
    lastErrorKey: null,
    filePath: null,
  };
}

/** 打开连接后的初始 tab 组。 */
function initialTabs(): { tabs: QueryTab[]; activeTabId: string } {
  const tab = createTab();
  return { tabs: [tab], activeTabId: tab.id };
}

/** 重连 / 建库后保留各 tab 的 SQL 文本，只复位执行态与结果（v0.1 行为延续）。
 *  事务 session 随旧连接消亡（后端统一 close 回滚），前端状态一并清除。 */
function resetTabExecution(tabs: QueryTab[]): QueryTab[] {
  return tabs.map((t) => ({
    ...t,
    rowSet: null,
    loadingData: false,
    queryRunning: false,
    currentQueryId: null,
    queryErrorMsg: null,
    transaction: null,
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

/** 提取命令错误 key（QueryCommandError 对象或裸字符串）。 */
function commandErrorKey(e: unknown): string | null {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null && "key" in e) {
    const key = Reflect.get(e, "key");
    return typeof key === "string" ? key : null;
  }
  return null;
}

/** 判断错误是否为事务 session 失效（断链 / 重连导致的 session_broken）。 */
function isSessionBrokenError(e: unknown): boolean {
  return commandErrorKey(e) === "error.driver.session_broken";
}

/** 静默关闭事务 session：close 幂等，失败（连接已断）不影响本地状态清理。 */
async function safeCloseSession(
  openId: string,
  sessionId: string,
): Promise<void> {
  try {
    await transactionApi.close(openId, sessionId);
  } catch {
    // session 可能已随连接消亡，忽略
  }
}

/** 更新浏览 tab 状态并重新查询（FR-242）。 */
async function browsePatchAndRefresh(
  get: Get,
  set: Set,
  tabId: string,
  patch: Partial<BrowseState>,
): Promise<void> {
  const tab = get().tabs.find((t) => t.id === tabId);
  if (!tab?.browse) return;
  set((s) => ({
    tabs: patchTab(s.tabs, tabId, {
      browse: { ...tab.browse!, ...patch },
    }),
  }));
  await browseTabData(get, set, tabId);
}

/**
 * 浏览 tab 数据查询（FR-242）：服务端筛选 / 排序 / 分页。
 * 与 runTabQuery 相同的迟到守卫：只有 tab 当前 query_id 仍匹配时才写回。
 */async function browseTabData(get: Get, set: Set, tabId: string): Promise<void> {
  const openId = get().openId;
  const tab = get().tabs.find((t) => t.id === tabId);
  const browse = tab?.browse;
  const database = get().selectedDb;
  if (!openId || !tab || !browse || !database) return;
  const schema =
    get().activeConnection?.driver === "postgresql"
      ? get().selectedSchema
      : null;
  const queryId = createQueryId();
  set((s) => ({
    tabs: patchTab(s.tabs, tabId, {
      loadingData: true,
      queryRunning: true,
      currentQueryId: queryId,
      queryErrorMsg: null,
    }),
  }));
  try {
    const result = await dbApi.browseTable({
      id: openId,
      database,
      schema,
      table: browse.table,
      filters: browse.filters,
      order: browse.order,
      limit: browse.pageSize,
      offset: browse.page * browse.pageSize,
    });
    const current = get().tabs.find((t) => t.id === tabId);
    if (!current || current.currentQueryId !== queryId) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        rowSet: result.rowSet,
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
        browse: current.browse
          ? {
              ...current.browse,
              total: result.total,
              hasNextPage: result.hasNextPage,
            }
          : null,
      }),
    }));
  } catch (e) {
    const current = get().tabs.find((t) => t.id === tabId);
    if (!current || current.currentQueryId !== queryId) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        queryErrorMsg: translateError(e),
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
      }),
    }));
  }
}

/**
 * 异步探测浏览表主键（FR-250）：PRIMARY KEY 约束存在才标记可编辑。
 * 失败静默（浏览不受影响），不阻塞浏览数据加载。
 */
async function resolveBrowseEditable(get: Get, set: Set, tabId: string): Promise<void> {
  const openId = get().openId;
  const tab = get().tabs.find((t) => t.id === tabId);
  const browse = tab?.browse;
  const database = get().selectedDb;
  if (!openId || !tab || !browse || !database) return;
  const schema =
    get().activeConnection?.driver === "postgresql"
      ? get().selectedSchema
      : null;
  try {
    const constraints = await dbApi.listConstraints(
      openId,
      database,
      schema,
      browse.table,
    );
    const pk = constraints.find((c) => c.constraintType === "PRIMARY KEY");
    if (!pk || pk.columns.length === 0) return;
    const current = get().tabs.find((t) => t.id === tabId);
    if (!current?.browse || current.browse.table !== browse.table) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        browse: {
          ...current.browse!,
          editable: true,
          pkColumns: pk.columns,
        },
      }),
    }));
  } catch {
    // 主键探测失败不打断浏览
  }
}

/** 从浏览行值构造主键定位 JSON（FR-250）；主键列不在行数据时返回 null。 */
export function rowKeyOf(
  row: Array<string | null>,
  columns: string[],
  pkColumns: string[],
): string | null {
  if (pkColumns.length === 0) return null;
  const parts: string[] = [];
  for (const pk of pkColumns) {
    const index = columns.indexOf(pk);
    if (index === -1) return null;
    const value = row[index];
    // 主键不应为 NULL；防御性返回 null 视为不可定位
    if (value === null) return null;
    parts.push(JSON.stringify(value));
  }
  return parts.join("\u0001");
}

/** 把一行浏览数据转为列值映射（FR-250）。 */
export function rowValuesOf(
  row: Array<string | null>,
  columns: string[],
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  columns.forEach((column, index) => {
    values[column] = row[index];
  });
  return values;
}

/** 从主键 JSON 还原主键 EditCell 列表（FR-250）。 */
function pkCellsFromKey(
  rowKey: string,
  pkColumns: string[],
): EditCell[] {
  const parts = rowKey.split("\u0001");
  return pkColumns.map((column, index) => {
    const raw = parts[index];
    let value: string | null = null;
    if (raw !== undefined) {
      try {
        value = JSON.parse(raw) as string;
      } catch {
        value = raw;
      }
    }
    return { column, value };
  });
}

/** 把 pendingEdits 转为后端 TableEdit 批（FR-250）。 */
function buildTableEdits(pending: PendingEdit[], pkColumns: string[]): TableEdit[] {
  const edits: TableEdit[] = [];
  for (const edit of pending) {
    if (edit.kind === "insert") {
      const values = Object.entries(edit.values)
        .filter(([, value]) => value !== null)
        .map(([column, value]) => ({ column, value }));
      edits.push({ kind: "insert", values });
    } else if (edit.kind === "update") {
      const changes = Object.entries(edit.values).map(([column, value]) => ({
        column,
        value,
      }));
      edits.push({
        kind: "update",
        pk: pkCellsFromKey(edit.rowKey, pkColumns),
        changes,
      });
    } else {
      edits.push({
        kind: "delete",
        pk: pkCellsFromKey(edit.rowKey, pkColumns),
      });
    }
  }
  return edits;
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

/** 仍保持后端打开的连接（FR-220 对比台用；焦点仍由 openId 决定） */
export interface OpenSessionInfo {
  id: string;
  sessionId: string;
  connection: StoredConnection;
}

function upsertOpenSession(
  sessions: OpenSessionInfo[],
  next: OpenSessionInfo,
): OpenSessionInfo[] {
  return [...sessions.filter((item) => item.id !== next.id), next];
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
  /** 已加载的各表索引（FR-241），随表展开加载，与列共享 cache 失效链 */
  indexesByTable: Record<string, IndexMeta[]>;
  /** 已加载的各表约束（FR-241） */
  constraintsByTable: Record<string, ConstraintMeta[]>;
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
  /** 已打开且未关闭的连接，切换焦点时不再拆旧隧道 */
  openSessions: OpenSessionInfo[];

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
  /** 在当前 tab 开启事务（FR-244）：建立独占 session，后续语句固定同一物理连接 */
  beginTransaction: () => Promise<void>;
  /** 提交当前 tab 事务 */
  commitTransaction: () => Promise<void>;
  /** 回滚当前 tab 事务 */
  rollbackTransaction: () => Promise<void>;
  /** 结束当前 tab 事务 session（未提交自动回滚），回到普通查询模式 */
  endTransaction: () => Promise<void>;
  /** 浏览 tab：更新筛选并回到第一页（FR-242） */
  browseSetFilters: (tabId: string, filters: TableFilter[]) => Promise<void>;
  /** 浏览 tab：切换列排序 */
  browseSetOrder: (tabId: string, order: TableOrder | null) => Promise<void>;
  /** 浏览 tab：翻到指定页（0 起） */
  browseSetPage: (tabId: string, page: number) => Promise<void>;
  /** 浏览 tab：调整每页行数并回到第一页 */
  browseSetPageSize: (tabId: string, pageSize: number) => Promise<void>;
  /** 浏览 tab：按当前状态重新查询 */
  browseRefresh: (tabId: string) => Promise<void>;
  /** 浏览 tab：进入 / 退出编辑模式（FR-250；无主键表禁止进入） */
  browseSetEditMode: (tabId: string, editMode: boolean) => void;
  /** 浏览 tab：单元格编辑（FR-250）——已有行记 update dirty，新增草稿行更新其值 */
  browseApplyCellEdit: (
    tabId: string,
    rowKey: string,
    column: string,
    value: string | null,
  ) => void;
  /** 浏览 tab：追加新增行草稿（FR-250） */
  browseAddRow: (tabId: string) => void;
  /** 浏览 tab：标记行删除 / 撤销删除（FR-250） */
  browseToggleDelete: (tabId: string, rowKey: string) => void;
  /** 浏览 tab：提交全部 pendingEdits（FR-250）；成功返回 true 并刷新数据 */
  browseCommitEdits: (tabId: string) => Promise<boolean>;
  /** 浏览 tab：放弃全部 pendingEdits（FR-250） */
  browseDiscardEdits: (tabId: string) => void;
  /** 多结果集：切换当前查看的结果下标（FR-243） */
  setActiveResultIndex: (tabId: string, index: number) => void;
  /** 打开 SQL 文件为新 tab（FR-240）；已打开同路径 tab 时直接激活。
   *  读取失败返回 false 并从最近文件移除（由 UI 决定是否提示）。 */
  openSqlFileFromPath: (path: string) => Promise<boolean>;
  /** 把 tab 内容保存到指定路径（FR-240）。
   *  返回 "saved" / "conflict"（文件被外部修改且未 force）/ "failed"。 */
  saveTabToFile: (
    tabId: string,
    path: string,
    options?: { force?: boolean },
  ) => Promise<"saved" | "conflict" | "failed">;
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
  columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
  loadingColumns: false,
  refreshingMetadata: false,
  loadingData: false,
  ...initialTabs(),
  hopStatuses: {},
  lostHops: [],
  openSessions: [],

  open: async (id, passphrase, connection, rememberPassphrase) => {
    const requestEpoch = beginSessionRequest();
    invalidateMetadataRequests();
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
      // FR-220：切换焦点不关闭旧连接，对比台需要两侧同时在线
      openedSessionId = await connectionApi.open(id, passphrase, rememberPassphrase);
      if (!isCurrentSessionRequest(requestEpoch)) return;
      set({ openId: id, runtimeSessionId: openedSessionId });
      metadataCache.clearConnection(id);
      const databases = await dbApi.listDatabases(id);
      if (!isCurrentSessionRequest(requestEpoch)) return;
      const focused = connection ?? get().activeConnection;
      set({
        openId: id,
        runtimeSessionId: openedSessionId,
        activeConnection: focused,
        openSessions:
          focused && openedSessionId
            ? upsertOpenSession(get().openSessions, {
                id,
                sessionId: openedSessionId,
                connection: focused,
              })
            : get().openSessions,
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
        columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
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
      columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
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
      openSessions: get().openSessions.filter((item) => item.id !== openId),
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
      columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
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
      columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
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
      columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
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
      const indexKey = metadataKey(openId, driver, selectedDb, schema, "indexes", table);
      const constraintKey = metadataKey(openId, driver, selectedDb, schema, "constraints", table);
      const cachedColumns = metadataCache.get<ColumnMeta[]>(key);
      const cachedIndexes = metadataCache.get<IndexMeta[]>(indexKey);
      const cachedConstraints = metadataCache.get<ConstraintMeta[]>(constraintKey);
      if (cachedColumns && cachedIndexes && cachedConstraints) {
        if (
          !isCurrentMetadataRequest(requestEpoch) ||
          get().expandedTable !== table
        )
          return;
        set((state) => ({
          tableColumns: cachedColumns,
          columnsByTable: { ...state.columnsByTable, [table]: cachedColumns },
          indexesByTable: { ...state.indexesByTable, [table]: cachedIndexes },
          constraintsByTable: {
            ...state.constraintsByTable,
            [table]: cachedConstraints,
          },
          loadingColumns: false,
        }));
        return;
      }
      // 列 / 索引 / 约束并行加载（FR-241），任一失败整体报错重试
      const [tableColumns, tableIndexes, tableConstraints] = await Promise.all([
        dbApi.listColumns(openId, selectedDb, schema, table),
        dbApi.listIndexes(openId, selectedDb, schema, table),
        dbApi.listConstraints(openId, selectedDb, schema, table),
      ]);
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
      metadataCache.set(indexKey, tableIndexes);
      metadataCache.set(constraintKey, tableConstraints);
      set((state) => ({
        tableColumns,
        columnsByTable: { ...state.columnsByTable, [table]: tableColumns },
        indexesByTable: { ...state.indexesByTable, [table]: tableIndexes },
        constraintsByTable: {
          ...state.constraintsByTable,
          [table]: tableConstraints,
        },
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
        columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
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
    // 已存在同一张表的浏览 tab 时直接激活，避免双击/反复点击产生重复 tab
    const existing = get().tabs.find((t) => t.browse?.table === table);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    // 表预览是浏览模式 tab（FR-242）：服务端筛选 / 排序 / 分页，无 SQL 编辑器
    const tab = createTab(table, "");
    tab.selectedTable = table;
    tab.browse = {
      table,
      filters: [],
      order: null,
      page: 0,
      pageSize: 1000,
      total: null,
      hasNextPage: false,
      editable: false,
      pkColumns: [],
      editMode: false,
      pendingEdits: [],
      submitting: false,
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    }));
    await browseTabData(get, set, tab.id);
    // 异步探测主键（FR-250）：有显式主键才允许进入编辑模式
    void resolveBrowseEditable(get, set, tab.id);
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
    // 关闭事务 tab：结束 session，未提交事务由后端自动回滚（FR-244）
    const openId = get().openId;
    if (tab.transaction && openId) {
      try {
        await transactionApi.close(openId, tab.transaction.sessionId);
      } catch {
        // session 可能已随连接消亡，忽略
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

  beginTransaction: async () => {
    const openId = get().openId;
    const tab = selectActiveTab(get());
    if (!openId || !tab || tab.transaction) return;
    try {
      const sessionId = await transactionApi.begin(openId);
      set((s) => ({
        tabs: patchTab(s.tabs, tab.id, {
          transaction: { sessionId, inTransaction: true },
          queryErrorMsg: null,
        }),
      }));
    } catch (e) {
      set((s) => ({
        tabs: patchTab(s.tabs, tab.id, {
          queryErrorMsg: translateError(e),
        }),
      }));
    }
  },

  commitTransaction: async () => {
    const openId = get().openId;
    const tab = selectActiveTab(get());
    const tx = tab?.transaction;
    if (!openId || !tab || !tx || !tx.inTransaction) return;
    try {
      await transactionApi.commit(openId, tx.sessionId);
      // 一次性事务模型：提交成功后结束 session，回到普通查询模式
      await safeCloseSession(openId, tx.sessionId);
      set((s) => ({
        tabs: patchTab(s.tabs, tab.id, {
          transaction: null,
          queryErrorMsg: null,
        }),
      }));
    } catch (e) {
      // commit 失败后端已保守销毁连接（事务由服务端回滚），本地同步清理
      await safeCloseSession(openId, tx.sessionId);
      set((s) => ({
        tabs: patchTab(s.tabs, tab.id, {
          queryErrorMsg: translateError(e),
          transaction: null,
        }),
      }));
    }
  },

  rollbackTransaction: async () => {
    const openId = get().openId;
    const tab = selectActiveTab(get());
    const tx = tab?.transaction;
    if (!openId || !tab || !tx || !tx.inTransaction) return;
    try {
      await transactionApi.rollback(openId, tx.sessionId);
      await safeCloseSession(openId, tx.sessionId);
      set((s) => ({
        tabs: patchTab(s.tabs, tab.id, {
          transaction: null,
          queryErrorMsg: null,
        }),
      }));
    } catch (e) {
      await safeCloseSession(openId, tx.sessionId);
      set((s) => ({
        tabs: patchTab(s.tabs, tab.id, {
          queryErrorMsg: translateError(e),
          transaction: null,
        }),
      }));
    }
  },

  endTransaction: async () => {
    const openId = get().openId;
    const tab = selectActiveTab(get());
    const tx = tab?.transaction;
    if (!openId || !tab || !tx) return;
    try {
      await transactionApi.close(openId, tx.sessionId);
    } catch {
      // close 幂等；session 已随连接消亡时忽略
    }
    set((s) => ({
      tabs: patchTab(s.tabs, tab.id, { transaction: null }),
    }));
  },

  browseSetFilters: async (tabId, filters) => {
    await browsePatchAndRefresh(get, set, tabId, { filters, page: 0 });
  },

  browseSetOrder: async (tabId, order) => {
    await browsePatchAndRefresh(get, set, tabId, { order, page: 0 });
  },

  browseSetPage: async (tabId, page) => {
    await browsePatchAndRefresh(get, set, tabId, { page });
  },

  browseSetPageSize: async (tabId, pageSize) => {
    await browsePatchAndRefresh(get, set, tabId, { pageSize, page: 0 });
  },

  browseRefresh: async (tabId) => {
    await browseTabData(get, set, tabId);
  },

  browseSetEditMode: (tabId, editMode) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.browse) return;
    if (editMode && !tab.browse.editable) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        browse: {
          ...tab.browse!,
          editMode,
          // 退出编辑模式时保留 dirty（关闭/切换筛选才提示），但离开编辑态视觉
        },
      }),
    }));
  },

  browseApplyCellEdit: (tabId, rowKey, column, value) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const browse = tab?.browse;
    if (!tab || !browse || !browse.editMode) return;
    const rowSet = tab.rowSet;
    const columns = rowSet?.columns ?? [];
    const rowIndex = rowSet?.rows.findIndex(
      (row) => rowKeyOf(row, columns, browse.pkColumns) === rowKey,
    );
    const existing = browse.pendingEdits.find((e) => e.rowKey === rowKey);
    set((s) => {
      let pending = browse.pendingEdits;
      if (rowIndex !== undefined && rowIndex !== -1 && rowSet && !existing) {
        // 已有行首次编辑：记 update dirty（原值快照用于恢复与提交定位）
        const original = rowValuesOf(rowSet.rows[rowIndex], columns);
        pending = [
          ...pending,
          { rowKey, kind: "update", original, values: { [column]: value } },
        ];
      } else if (existing) {
        // 已有 update / insert 草稿：合并变更列
        pending = pending.map((e) =>
          e.rowKey === rowKey
            ? { ...e, values: { ...e.values, [column]: value } }
            : e,
        );
      }
      return {
        tabs: patchTab(s.tabs, tabId, {
          browse: { ...browse, pendingEdits: pending },
        }),
      };
    });
  },

  browseAddRow: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.browse || !tab.browse.editMode) return;
    const browse = tab.browse;
    const rowKey = `__new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        browse: {
          ...browse,
          pendingEdits: [
            ...browse.pendingEdits,
            {
              rowKey,
              kind: "insert",
              original: null,
              values: {},
            },
          ],
        },
      }),
    }));
  },

  browseToggleDelete: (tabId, rowKey) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const browse = tab?.browse;
    if (!tab || !browse || !browse.editMode) return;
    const existing = browse.pendingEdits.find((e) => e.rowKey === rowKey);
    set((s) => {
      let pending: PendingEdit[];
      if (existing?.kind === "delete") {
        // 撤销删除：恢复为原始状态（若曾是 update 则还原原值快照）
        pending = browse.pendingEdits.filter((e) => e.rowKey !== rowKey);
      } else if (existing?.kind === "insert") {
        // 删除新增草稿行：直接移除
        pending = browse.pendingEdits.filter((e) => e.rowKey !== rowKey);
      } else if (existing) {
        // 有 update dirty 的行改删：整行删除覆盖原修改
        pending = browse.pendingEdits.map((e) =>
          e.rowKey === rowKey ? { ...e, kind: "delete", values: {} } : e,
        );
      } else {
        const rowSet = tab.rowSet;
        const columns = rowSet?.columns ?? [];
        const rowIndex = rowSet?.rows.findIndex(
          (row) => rowKeyOf(row, columns, browse.pkColumns) === rowKey,
        );
        if (rowIndex === undefined || rowIndex === -1 || !rowSet) return s;
        pending = [
          ...browse.pendingEdits,
          {
            rowKey,
            kind: "delete",
            original: rowValuesOf(rowSet.rows[rowIndex], columns),
            values: {},
          },
        ];
      }
      return {
        tabs: patchTab(s.tabs, tabId, {
          browse: { ...browse, pendingEdits: pending },
        }),
      };
    });
  },

  browseCommitEdits: async (tabId) => {
    const openId = get().openId;
    const tab = get().tabs.find((t) => t.id === tabId);
    const browse = tab?.browse;
    const database = get().selectedDb;
    if (!openId || !tab || !browse || !browse.editMode || !database) return false;
    if (browse.pendingEdits.length === 0 || browse.submitting) return false;
    const schema =
      get().activeConnection?.driver === "postgresql"
        ? get().selectedSchema
        : null;
    const edits = buildTableEdits(browse.pendingEdits, browse.pkColumns);
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        queryErrorMsg: null,
        browse: { ...browse, submitting: true },
      }),
    }));
    try {
      await dbApi.applyTableEdits(openId, {
        database,
        schema,
        table: browse.table,
        pkColumns: browse.pkColumns,
        edits,
      });
      const current = get().tabs.find((t) => t.id === tabId);
      if (!current?.browse) return false;
      const nextBrowse: BrowseState = {
        ...current.browse,
        pendingEdits: [],
        submitting: false,
      };
      set((s) => ({
        tabs: patchTab(s.tabs, tabId, {
          rowSet: null,
          browse: nextBrowse,
        }),
      }));
      // 提交成功后重新拉取数据（回到当前页）
      await browseTabData(get, set, tabId);
      return true;
    } catch (e) {
      const current = get().tabs.find((t) => t.id === tabId);
      if (!current?.browse) return false;
      const nextBrowse: BrowseState = {
        ...current.browse,
        submitting: false,
      };
      set((s) => ({
        tabs: patchTab(s.tabs, tabId, {
          queryErrorMsg: translateError(e),
          browse: nextBrowse,
        }),
      }));
      return false;
    }
  },

  browseDiscardEdits: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.browse) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        browse: { ...tab.browse!, pendingEdits: [] },
      }),
    }));
  },

  setActiveResultIndex: (tabId, index) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.multiResults || index < 0 || index >= tab.multiResults.length) return;
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, { activeResultIndex: index }),
    }));
  },

  openSqlFileFromPath: async (path) => {
    // 已打开同路径 tab 时直接激活
    const existing = get().tabs.find((t) => t.filePath === path);
    if (existing) {
      set({ activeTabId: existing.id });
      return true;
    }
    let content: string;
    try {
      content = await sqlFileApi.read(path);
    } catch {
      // 文件已失效：从最近文件移除，交给 UI 提示
      try {
        await sqlFileApi.recentRemove(path);
      } catch {
        // 忽略清理失败
      }
      return false;
    }
    const name = path.split("/").pop() ?? path;
    const tab = createTab(name, content);
    tab.filePath = path;
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    try {
      await sqlFileApi.recentTouch(path);
    } catch {
      // 最近文件记录失败不影响打开
    }
    return true;
  },

  saveTabToFile: async (tabId, path, options) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return "failed";
    // 外部修改检测（FR-240）：磁盘内容与打开/上次保存时快照不一致即冲突
    if (!options?.force && tab.filePath === path) {
      let disk: string | null = null;
      try {
        disk = await sqlFileApi.read(path);
      } catch {
        disk = null; // 读不到按无冲突继续写（写本身会暴露权限错误）
      }
      if (disk !== null && disk !== tab.initialSql) {
        return "conflict";
      }
    }
    try {
      await sqlFileApi.write(path, tab.sqlText);
    } catch {
      return "failed";
    }
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        filePath: path,
        initialSql: tab.sqlText,
        title: path.split("/").pop() ?? tab.title,
      }),
    }));
    try {
      await sqlFileApi.recentTouch(path);
    } catch {
      // 最近文件记录失败不影响保存
    }
    return "saved";
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
      multiResults: null,
      lastErrorKey: null,
    }),
  }));
  try {
    // 事务 tab 走独占 session（同一物理连接）；普通 tab 走 pool 路径
    const tx = get().tabs.find((t) => t.id === tabId)?.transaction ?? null;
    let rowSet: RowSet;
    let inTransaction: boolean | null = null;
    if (tx) {
      const result = await transactionApi.query(openId, tx.sessionId, sql, {
        queryId,
        rowLimit: options.rowLimit,
        allowWrite: options.allowWrite ?? false,
        schema,
      });
      rowSet = result.rowSet;
      inTransaction = result.inTransaction;
    } else {
      try {
        rowSet = await dbApi.query(openId, sql, {
          queryId,
          rowLimit: options.rowLimit,
          allowWrite: options.allowWrite ?? false,
          schema,
        });
      } catch (singleError) {
        // 多语句脚本分流：拆分后逐条执行（FR-243）；事务 tab 不支持执行全部
        if (commandErrorKey(singleError) !== "error.driver.multiple_statements") {
          throw singleError;
        }
        const multi = await dbApi.queryMany(openId, sql, {
          queryId,
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
            columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
            loadingColumns: false,
          }));
        }
        const firstOk = multi.statements.findIndex(
          (stmt) => stmt.outcome.status === "ok",
        );
        set((s) => ({
          tabs: patchTab(s.tabs, tabId, {
            multiResults: multi.statements,
            activeResultIndex: firstOk >= 0 ? firstOk : 0,
            loadingData: false,
            queryRunning: false,
            currentQueryId: null,
            rowSet: null,
            // 脚本中有语句失败时顶部提示（单条明细在结果区展示）
            queryErrorMsg: multi.statements.some(
              (stmt) => stmt.outcome.status === "error",
            )
              ? "脚本存在失败语句，后续语句已跳过"
              : null,
          }),
        }));
        return;
      }
    }
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || tab.currentQueryId !== queryId) return;
    if (invalidatesMetadataCache(sql)) {
      invalidateMetadataRequests();
      metadataCache.clearConnection(openId);
      set((s) => ({
        expandedTable: null,
        tableColumns: [],
        columnsByTable: {}, indexesByTable: {}, constraintsByTable: {},
        loadingColumns: false,
      }));
    }
    set((s) => ({
      tabs: patchTab(s.tabs, tabId, {
        rowSet,
        multiResults: null,
        loadingData: false,
        queryRunning: false,
        currentQueryId: null,
        // 用户手写 COMMIT/ROLLBACK 后同步后端跟踪的事务状态
        transaction:
          inTransaction !== null && tab.transaction
            ? { ...tab.transaction, inTransaction }
            : tab.transaction,
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
        multiResults: null,
        lastErrorKey: commandErrorKey(e),
        // session 失效（断链等）：清除事务状态，未提交已由服务端回滚
        transaction: isSessionBrokenError(e) ? null : tab.transaction,
      }),
      errorMsg: translateError(e),
    }));
  }
}
