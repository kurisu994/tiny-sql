// 前端 ↔ 后端 IPC 封装：类型、command 调用、错误 i18n key → 中文
//
// Week 2 暂用静态 map 翻译错误；Week 3 接 i18next 后替换 translateError。

import { invoke } from "@tauri-apps/api/core";
import type { DownloadEvent as TauriDownloadEvent } from "@tauri-apps/plugin-updater";

export function isTauriRuntime(): boolean {
  if (typeof process !== "undefined" && process.env.VITEST) return true;
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** SSH 单跳配置（持久化模型，不含 passphrase） */
export interface SshHopConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string | null;
  privateKeyPath?: string | null;
}

/** SSH 隧道配置 */
export interface SshConfig {
  enabled: boolean;
  hops: SshHopConfig[];
}

export type SslMode =
  | "disabled"
  | "preferred"
  | "required"
  | "verify_ca"
  | "verify_identity";

/** MySQL SSL 配置 */
export interface SslConfig {
  mode: SslMode;
  caPath: string;
  clientCertPath: string;
  clientKeyPath: string;
}

/** 连接高级配置 */
export interface AdvancedConfig {
  keepAliveEnabled: boolean;
  keepAliveIntervalSeconds: number;
  keepAliveFailureThreshold: number;
  connectTimeoutEnabled: boolean;
  connectTimeoutSeconds: number;
  readTimeoutEnabled: boolean;
  readTimeoutSeconds: number;
  writeTimeoutEnabled: boolean;
  writeTimeoutSeconds: number;
  compressionEnabled: boolean;
  autoConnect: boolean;
}

/** 数据库 Driver 类型；序列化值与 Rust DriverKind 保持一致。 */
export type DriverKind = "mysql" | "postgresql";

/** 连接环境标签（FR-271），缺省 none */
export type ConnectionEnv = "none" | "prod" | "staging" | "dev";

/** 持久化的连接配置（与后端 StoredConnection 对齐，camelCase） */
export interface StoredConnection {
  id: string;
  name: string;
  driver: DriverKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssh: SshConfig;
  ssl: SslConfig;
  advanced: AdvancedConfig;
  lastUsedAt?: string | null;
  /** 应用层只读（FR-270），旧记录缺省 false */
  readOnly?: boolean;
  /** 环境标签（FR-271），旧记录缺省 none */
  env?: ConnectionEnv;
}

/** 新建 / 测试连接的入参（不含 id） */
export interface ConnectionInput {
  name: string;
  driver: DriverKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssh: SshConfig;
  ssl: SslConfig;
  advanced: AdvancedConfig;
  readOnly?: boolean;
  env?: ConnectionEnv;
}

/** 错误 i18n key → 中文文案 */
export const ERROR_ZH: Record<string, string> = {
  "error.ssh.no_hops": "未配置 SSH 跳板",
  "error.ssh.connect_failed": "SSH 连接失败",
  "error.ssh.auth_failed": "SSH 认证失败",
  "error.ssh.invalid_passphrase": "私钥 passphrase 错误",
  "error.ssh.key_not_found": "私钥文件不存在",
  "error.ssh.channel_open_failed": "SSH 通道开启失败",
  "error.ssh.local_listen_failed": "本地端口监听失败",
  "error.ssh.invalid_auth_type": "SSH 认证方式非法",
  "error.ssh.host_key_mismatch": "SSH 主机指纹与已信任记录不一致，已拒绝连接",
  "error.ssh.host_key_rejected": "未信任该 SSH 主机指纹",
  "error.ssh.tunnel_lost": "SSH 隧道已断开（keepalive 超时）",
  "error.ssh.channel_dropped": "SSH 通道被对端关闭，请重连",
  "error.ssh.accept_loop_died": "SSH 隧道内部错误，请上报",
  "error.driver.connect_failed": "数据库连接失败",
  "error.driver.query_failed": "SQL 执行失败",
  "error.driver.invalid_sql": "SQL 不能为空或格式不合法",
  "error.driver.multiple_statements": "一次只能执行一条 SQL",
  "error.driver.write_requires_confirmation": "检测到写操作，需要二次确认",
  "error.driver.query_cancelled": "SQL 已取消",
  "error.driver.invalid_identifier": "数据库名称或字符集配置不合法",
  "error.driver.database_switch_required": "需要先切换到目标 PostgreSQL 数据库",
  "error.driver.schema_required": "请选择 PostgreSQL Schema",
  "error.driver.operation_not_supported": "当前数据库类型不支持该操作",
  "error.driver.not_implemented": "该数据库类型尚未接入",
  "error.driver.tls_handshake_failed":
    "TLS 握手失败：服务端可能未启用 SSL 或不支持当前 TLS 版本，可将 SSL 模式改为 Preferred 重试",
  "error.driver.tls_verify_failed":
    "证书校验失败：请检查 CA 证书路径、证书有效期，以及主机名是否与证书匹配",
  "error.driver.tx_requires_session":
    "事务语句（BEGIN/COMMIT/ROLLBACK）请在事务 tab 中执行",
  "error.driver.session_not_in_transaction": "当前没有进行中的事务",
  "error.driver.session_broken": "事务会话已失效（连接已断开），未提交修改已回滚",
  "error.driver.no_primary_key": "该表没有主键，无法进行表格编辑",
  "error.driver.edit_apply_failed": "编辑提交失败，已整体回滚，未应用任何修改",
  "error.driver.edit_conflict": "该行已被其他会话修改或删除，提交已取消，请刷新后重试",
  "error.connection.not_found": "连接配置不存在",
  "error.connection.not_open": "连接尚未打开",
  "error.connection.read_only": "该连接已设为应用只读，已拒绝写操作（不是数据库账号权限）",
  "error.security.locked": "已锁定，请先输入主密码解锁",
  "error.security.wrong_password": "主密码错误",
  "error.security.empty_password": "主密码不能为空",
  "error.security.already_enabled": "已启用主密码",
  "error.security.not_enabled": "尚未启用主密码",
  "error.security.unsupported_kdf": "主密码参数不被支持，请升级应用后重试",
  "error.security.meta_corrupted": "主密码元信息已损坏，可通过重置重新开始",
  "error.security.migration_failed": "加密迁移失败，原数据未被修改",
  "error.security.master_required": "需先启用并解锁主密码才能保存 passphrase",
  "error.export.io": "导出文件写入失败，请检查路径与磁盘权限",
  "error.dump.no_tables": "当前范围没有可导出的表",
  "error.backup.tool_not_found": "未找到官方备份工具，请安装 mysqldump/mysql 或 pg_dump/pg_restore，或在对话框指定路径",
  "error.backup.failed": "官方备份 / 恢复失败，请查看日志（不会回退成 SQL dump）",
  "error.backup.cancelled": "官方备份 / 恢复已取消",
  "error.backup.target_mismatch": "手输的目标库名与当前库不一致，已拒绝恢复",
  "error.backup.io": "备份文件读写失败，请检查路径与权限",
  "error.share.empty_password": "分享口令不能为空",
  "error.share.empty": "请至少选择一条连接",
  "error.share.failed": "连接分享失败",
  "error.share.invalid": "分享文件无效或已被篡改",
  "error.share.wrong_password": "分享口令错误",
  "error.share.io": "分享文件读写失败，请检查路径与权限",
  "error.copy.cross_driver": "不能跨 MySQL / PostgreSQL 拷贝数据",
  "error.copy.no_mapped_columns": "没有同名列可以拷贝",
  "error.copy.target_mismatch": "手输的目标表名与实际目标不一致，已拒绝",
  "error.copy.cancelled": "数据拷贝已取消",
  "error.copy.failed": "数据拷贝失败",
  "error.privilege.unsupported": "当前数据库类型不支持该权限操作",
  "error.privilege.forbidden": "当前账号无权查看或修改用户权限",
  "error.sqlfile.read_failed": "SQL 文件读取失败，请检查路径与权限",
  "error.sqlfile.write_failed": "SQL 文件写入失败，请检查路径与磁盘权限",
  "error.sqlfile.too_large": "SQL 文件过大（超过 8MB），请拆分后打开",
};

/** 把后端返回的错误（可能是 i18n key）翻译成中文 */
export function translateError(e: unknown): string {
  const payload = parseCommandError(e);
  const key = payload?.key ?? (typeof e === "string" ? e : String(e));
  const message = ERROR_ZH[key] ?? key;
  const parts: string[] = [];
  if (payload?.line) parts.push(`第 ${payload.line} 行`);
  if (typeof payload?.editIndex === "number") parts.push(`第 ${payload.editIndex + 1} 条变更`);
  return parts.length ? `${message}（${parts.join("，")}）` : message;
}

interface CommandErrorPayload {
  key: string;
  line: number | null;
  editIndex: number | null;
}

function parseCommandError(value: unknown): CommandErrorPayload | null {
  if (typeof value !== "object" || value === null || !("key" in value)) {
    return null;
  }
  const key = Reflect.get(value, "key");
  if (typeof key !== "string") return null;
  const rawLine = Reflect.get(value, "line");
  const line =
    typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine > 0
      ? rawLine
      : null;
  const rawEditIndex = Reflect.get(value, "editIndex");
  const editIndex =
    typeof rawEditIndex === "number" && Number.isInteger(rawEditIndex) &&
    rawEditIndex >= 0
      ? rawEditIndex
      : null;
  return { key, line, editIndex };
}

// === 应用更新 ===

/** 应用级原生菜单事件 */
export const APP_EVENTS = {
  checkUpdate: "app:check-update",
} as const;

/** Tauri updater 检测到的新版本信息 */
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

/** 更新包下载事件 */
export type UpdateDownloadEvent = TauriDownloadEvent;

export const updateApi = {
  async getAppVersion(): Promise<string> {
    if (!isTauriRuntime()) {
      return process.env.NEXT_PUBLIC_APP_VERSION ?? "";
    }
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },

  async check(): Promise<UpdateInfo | null> {
    if (!isTauriRuntime()) return null;

    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;

    try {
      return {
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        body: update.body,
      };
    } finally {
      await update.close();
    }
  },

  async downloadAndInstall(
    onEvent?: (event: UpdateDownloadEvent) => void,
  ): Promise<void> {
    if (!isTauriRuntime()) {
      throw new Error("仅桌面应用支持自动更新");
    }

    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      throw new Error("当前已是最新版本");
    }

    try {
      await update.downloadAndInstall(onEvent);
    } finally {
      await update.close();
    }
  },

  async relaunch(): Promise<void> {
    if (!isTauriRuntime()) return;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

/** 连接管理相关 command */
export const connectionApi = {
  list: () => invoke<StoredConnection[]>("connection_list"),
  create: (input: ConnectionInput) =>
    invoke<StoredConnection>("connection_create", { input }),
  update: (connection: StoredConnection) =>
    invoke<void>("connection_update", { connection }),
  remove: (id: string) => invoke<void>("connection_delete", { id }),
  /** 测试连接；passphrase 仅用于本次 SSH 握手，不保存也不进入会话缓存。 */
  test: (input: ConnectionInput, passphrase?: string) =>
    invoke<void>("connection_test", {
      input,
      passphrase: passphrase ?? null,
    }),
  /** 打开连接（建隧道 + 连接池）；passphrase 仅本次会话生效，rememberPassphrase 需主密码已解锁 */
  open: (id: string, passphrase?: string, rememberPassphrase?: boolean) =>
    invoke<string>("connection_open", {
      id,
      passphrase: passphrase ?? null,
      rememberPassphrase: rememberPassphrase ?? null,
    }),
  /** 清理旧查询、连接池和隧道后重建连接；返回新 session 代号。databaseOverride 仅本次 session 生效，不落盘。 */
  reconnect: (
    id: string,
    expectedSessionId?: string,
    passphrase?: string,
    databaseOverride?: string,
  ) =>
    invoke<string>("connection_reconnect", {
      id,
      expectedSessionId: expectedSessionId ?? null,
      passphrase: passphrase ?? null,
      databaseOverride: databaseOverride ?? null,
    }),
  /** 关闭指定 session；代号不匹配时后端幂等忽略迟到操作。 */
  close: (id: string, expectedSessionId?: string) =>
    invoke<void>("connection_close", {
      id,
      expectedSessionId: expectedSessionId ?? null,
    }),
  shareExport: (
    ids: string[],
    password: string,
    path: string,
    includePrivateKeys: boolean,
  ) =>
    invoke<void>("connection_share_export", {
      input: { ids, password, path, includePrivateKeys },
    }),
  sharePreview: (path: string, password: string) =>
    invoke<SharePreviewResult>("connection_share_preview", {
      input: { path, password },
    }),
  shareImport: (path: string, password: string) =>
    invoke<number>("connection_share_import", {
      input: { path, password },
    }),
};

export interface SharePreviewItem {
  name: string;
  driver: string;
  hopCount: number;
}

export interface SharePreviewResult {
  connections: SharePreviewItem[];
}

// === 数据浏览（schema / 结果集）===

/** database 元信息；PostgreSQL 仅当前连接所在 database 可直接浏览 */
export interface DatabaseMeta {
  name: string;
  isCurrent: boolean;
}

/** schema 元信息；MySQL 返回与 database 同名项，PostgreSQL 为独立层级 */
export interface SchemaMeta {
  name: string;
  isDefault: boolean;
}

/** 表元信息 */
export interface TableMeta {
  name: string;
  tableType: string;
  rows: number | null;
  comment: string | null;
}

/** 列元信息 */
export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
  columnKey: string;
  defaultValue: string | null;
  comment: string | null;
}

/** 索引元信息（FR-241） */
export interface IndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
  /** "PRIMARY" / "UNIQUE" / "INDEX" */
  indexType: string;
}

/** 约束元信息（FR-241） */
export interface ConstraintMeta {
  name: string;
  /** "PRIMARY KEY" / "FOREIGN KEY" / "UNIQUE" / "CHECK" */
  constraintType: string;
  columns: string[];
  /** 外键引用目标（MySQL）或约束定义文本（PostgreSQL） */
  reference: string | null;
}

/** 查询结果集（所有单元格统一为字符串，null = SQL NULL） */
export interface RowSet {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
}

export interface QueryOptions {
  queryId?: string;
  rowLimit?: number;
  allowWrite?: boolean;
  /** 仅用于 SQL 历史元信息；PostgreSQL 传当前选中 schema */
  schema?: string | null;
}

/** 新建 database 入参 */
export interface CreateDatabaseInput {
  name: string;
  charset?: string | null;
  collation?: string | null;
}

/** 基于已打开连接的数据浏览 command */
export const dbApi = {
  listDatabases: (id: string) =>
    invoke<DatabaseMeta[]>("db_list_databases", { id }),
  listSchemas: (id: string, database: string) =>
    invoke<SchemaMeta[]>("db_list_schemas", { id, database }),
  createDatabase: (id: string, input: CreateDatabaseInput) =>
    invoke<void>("db_create_database", {
      id,
      name: input.name,
      charset: input.charset?.trim() ? input.charset.trim() : null,
      collation: input.collation?.trim() ? input.collation.trim() : null,
    }),
  listTables: (id: string, database: string, schema?: string | null) =>
    invoke<TableMeta[]>("db_list_tables", {
      id,
      database,
      schema: schema ?? null,
    }),
  listColumns: (
    id: string,
    database: string,
    schema: string | null,
    table: string,
  ) => invoke<ColumnMeta[]>("db_list_columns", { id, database, schema, table }),
  listIndexes: (
    id: string,
    database: string,
    schema: string | null,
    table: string,
  ) => invoke<IndexMeta[]>("db_list_indexes", { id, database, schema, table }),
  listConstraints: (
    id: string,
    database: string,
    schema: string | null,
    table: string,
  ) =>
    invoke<ConstraintMeta[]>("db_list_constraints", {
      id,
      database,
      schema,
      table,
    }),
  query: (id: string, sql: string, options: QueryOptions = {}) =>
    invoke<RowSet>("db_query", {
      id,
      sql,
      queryId: options.queryId ?? null,
      rowLimit: options.rowLimit ?? null,
      allowWrite: options.allowWrite ?? false,
      schema: options.schema ?? null,
    }),
  cancelQuery: (queryId: string) =>
    invoke<void>("db_query_cancel", { queryId }),
  browseTable: (input: BrowseTableInput) =>
    invoke<TableBrowseResult>("db_browse_table", {
      id: input.id,
      input: {
        database: input.database,
        schema: input.schema ?? null,
        table: input.table,
        filters: input.filters,
        order: input.order ?? null,
        limit: input.limit ?? null,
        offset: input.offset ?? null,
      },
    }),
  applyTableEdits: (id: string, input: ApplyTableEditsInput) =>
    invoke<ApplyEditsResult>("db_apply_table_edits", {
      id,
      input: {
        database: input.database,
        schema: input.schema ?? null,
        table: input.table,
        pkColumns: input.pkColumns,
        edits: input.edits,
      },
    }),
  csvImportPreview: (path: string, hasHeader: boolean, maxRows?: number) =>
    invoke<CsvPreview>("csv_import_preview", {
      path,
      hasHeader,
      maxRows: maxRows ?? null,
    }),
  importCsv: (id: string, input: CsvImportInput) =>
    invoke<CsvImportResult>("db_import_csv", {
      id,
      input: {
        database: input.database,
        schema: input.schema ?? null,
        table: input.table,
        path: input.path,
        mapping: input.mapping,
        hasHeader: input.hasHeader,
        skipErrors: input.skipErrors,
      },
    }),
  exportDump: (id: string, input: ExportDumpInput) =>
    invoke<ExportDumpResult>("db_export_dump", {
      id,
      input: {
        database: input.database,
        schema: input.schema ?? null,
        table: input.table ?? null,
        path: input.path,
      },
    }),
  importDump: (id: string, database: string, schema: string | null, path: string) =>
    invoke<ImportDumpResult>("db_import_dump", {
      id,
      input: { database, schema, path },
    }),
  probeBackupTools: (id: string, dumpPath?: string, clientPath?: string) =>
    invoke<BackupProbeResult>("backup_probe_tools", {
      id,
      input: {
        dumpPath: dumpPath?.trim() ? dumpPath.trim() : null,
        clientPath: clientPath?.trim() ? clientPath.trim() : null,
      },
    }),
  backupExport: (id: string, input: BackupExportInput) =>
    invoke<BackupJobResult>("db_backup_export", {
      id,
      input: {
        database: input.database,
        schema: input.schema ?? null,
        table: input.table ?? null,
        path: input.path,
        dumpPath: input.dumpPath ?? null,
        queryId: input.queryId ?? null,
      },
    }),
  copyPreview: (input: CopyPreviewInput) =>
    invoke<CopyPreviewResult>("db_copy_preview", { input }),
  copyTableRows: (input: CopyTableInput) =>
    invoke<CopyTableResult>("db_copy_table_rows", { input }),
  listAccounts: (id: string) => invoke<PrivilegeListResult>("db_list_accounts", { id }),
  showGrants: (id: string, name: string, host?: string | null) =>
    invoke<string[]>("db_show_grants", {
      id,
      input: { name, host: host ?? null },
    }),
  backupRestore: (id: string, input: BackupRestoreInput) =>
    invoke<BackupJobResult>("db_backup_restore", {
      id,
      input: {
        database: input.database,
        confirmDatabase: input.confirmDatabase,
        schema: input.schema ?? null,
        path: input.path,
        clientPath: input.clientPath ?? null,
        queryId: input.queryId ?? null,
      },
    }),
  queryMany: (id: string, sql: string, options: QueryOptions = {}) =>
    invoke<MultiQueryResult>("db_query_many", {
      id,
      sql,
      queryId: options.queryId ?? null,
      allowWrite: options.allowWrite ?? false,
      schema: options.schema ?? null,
    }),
};

/** 浏览表数据的筛选操作符（FR-242；与后端 FilterOp 一致） */
export type FilterOp =
  | "eq"
  | "notEq"
  | "gt"
  | "gtEq"
  | "lt"
  | "ltEq"
  | "like"
  | "notLike"
  | "isNull"
  | "isNotNull";

export interface TableFilter {
  column: string;
  op: FilterOp;
  value: string;
}

export interface TableOrder {
  column: string;
  descending: boolean;
}

export interface BrowseTableInput {
  id: string;
  database: string;
  schema?: string | null;
  table: string;
  filters: TableFilter[];
  order?: TableOrder | null;
  limit?: number | null;
  offset?: number | null;
}

/** 浏览查询结果（FR-242） */
export interface TableBrowseResult {
  rowSet: RowSet;
  /** 满足筛选的总行数；COUNT 超时/失败为 null（降级未知总数分页） */
  total: number | null;
  hasNextPage: boolean;
}

/** 编辑单元格值（FR-250）：None = SQL NULL */
export interface EditCell {
  column: string;
  value: string | null;
}

/** 单条表编辑操作（FR-250；与后端 TableEdit serde tag 一致） */
export type TableEdit =
  | { kind: "insert"; values: EditCell[] }
  | { kind: "update"; pk: EditCell[]; changes: EditCell[] }
  | { kind: "delete"; pk: EditCell[] };

/** 编辑批输入（FR-250） */
export interface ApplyTableEditsInput {
  database: string;
  schema?: string | null;
  table: string;
  pkColumns: string[];
  edits: TableEdit[];
}

/** 编辑批应用结果（FR-250） */
export interface ApplyEditsResult {
  applied: number;
}

/** CSV 预览（FR-252） */
export interface CsvPreview {
  headers: string[];
  rows: (string | null)[][];
  totalRows: number;
}

/** CSV 导入输入（FR-252） */
export interface CsvImportInput {
  database: string;
  schema?: string | null;
  table: string;
  path: string;
  /** CSV 列 → 表列名映射（下标即 CSV 列序；null = 跳过该列） */
  mapping: (string | null)[];
  hasHeader: boolean;
  skipErrors: boolean;
}

/** CSV 导入结果（FR-252） */
export interface CsvImportResult {
  inserted: number;
  /** 失败数据行号（1 起，不含表头） */
  failedRows: number[];
}

/** dump 导出输入（FR-252） */
export interface ExportDumpInput {
  database: string;
  schema?: string | null;
  /** 指定表名；缺省导出当前 scope 全部 BASE TABLE */
  table?: string | null;
  path: string;
}

/** dump 导出结果（FR-252） */
export interface ExportDumpResult {
  tables: number;
  rows: number;
}

/** dump 导入结果（FR-252） */
export interface ImportDumpResult {
  executed: number;
  /** 失败语句序号（1 起；null = 全部成功） */
  failedAt: number | null;
  failedPreview: string | null;
}

/** 官方备份工具探测（FR-260） */
export interface BackupToolInfo {
  path: string;
  version: string;
}

export interface BackupProbeResult {
  dump: BackupToolInfo | null;
  client: BackupToolInfo | null;
  exportPreview: string;
  restorePreview: string;
}

export interface BackupExportInput {
  database: string;
  schema?: string | null;
  table?: string | null;
  path: string;
  dumpPath?: string | null;
  queryId?: string | null;
}

export interface BackupRestoreInput {
  database: string;
  confirmDatabase: string;
  schema?: string | null;
  path: string;
  clientPath?: string | null;
  queryId?: string | null;
}

export interface BackupJobResult {
  bytes: number;
  toolVersion: string;
  log: string;
}

export interface CopyEndpoint {
  id: string;
  database: string;
  schema?: string | null;
  table: string;
}

export interface CopyPreviewInput {
  source: CopyEndpoint;
  dest: CopyEndpoint;
}

export interface CopyColumnMapping {
  source: string;
  dest: string;
}

export interface CopyPreviewResult {
  mappings: CopyColumnMapping[];
  sourceTotal: number | null;
  destTotal: number | null;
  replaceSql: string;
  crossDriver: boolean;
}

export interface CopyTableInput {
  source: CopyEndpoint;
  dest: CopyEndpoint;
  mode: "append" | "replace";
  confirmTarget: string;
  queryId?: string | null;
}

export interface CopyTableResult {
  copied: number;
  truncated: boolean;
}

export interface PrivilegeAccount {
  name: string;
  host: string | null;
  canLogin: boolean;
}

export interface PrivilegeListResult {
  driver: string;
  accounts: PrivilegeAccount[];
  readOnly: boolean;
}

/** 多语句脚本的单条执行结果（FR-243） */
export interface StatementResult {
  /** 语句原文（超长截断，仅展示用） */
  sql: string;
  outcome: StatementOutcome;
}

/** 单条语句的执行结局（FR-243；与后端 serde tag 一致） */
export type StatementOutcome =
  | { status: "ok"; rowSet: RowSet }
  | { status: "error"; key: string; line: number | null }
  | { status: "skipped" };

/** 多语句执行结果（FR-243） */
export interface MultiQueryResult {
  statements: StatementResult[];
}

/** 事务内查询的返回：结果集 + 最新事务状态（FR-244） */
export interface TxQueryResult {
  rowSet: RowSet;
  inTransaction: boolean;
}

/** 最近文件记录（FR-240） */
export interface RecentFileEntry {
  path: string;
  openedAt: string;
}

/** SQL 文件命令（FR-240）：后端读写，路径经系统对话框选择 */
export const sqlFileApi = {
  read: (path: string) => invoke<string>("sql_file_read", { path }),
  write: (path: string, content: string) =>
    invoke<void>("sql_file_write", { path, content }),
  recentList: () => invoke<RecentFileEntry[]>("sql_file_recent_list"),
  recentTouch: (path: string) =>
    invoke<void>("sql_file_recent_touch", { path }),
  recentRemove: (path: string) =>
    invoke<void>("sql_file_recent_remove", { path }),
};
/** 事务命令（FR-244）：每个事务 tab 对应一个独占 session */
export const transactionApi = {
  begin: (id: string) => invoke<string>("transaction_begin", { id }),
  query: (
    id: string,
    sessionId: string,
    sql: string,
    options: QueryOptions = {},
  ) =>
    invoke<TxQueryResult>("transaction_query", {
      id,
      input: {
        sessionId,
        sql,
        queryId: options.queryId ?? null,
        rowLimit: options.rowLimit ?? null,
        allowWrite: options.allowWrite ?? false,
        schema: options.schema ?? null,
      },
    }),
  commit: (id: string, sessionId: string) =>
    invoke<void>("transaction_commit", { id, sessionId }),
  rollback: (id: string, sessionId: string) =>
    invoke<void>("transaction_rollback", { id, sessionId }),
  close: (id: string, sessionId: string) =>
    invoke<void>("transaction_close", { id, sessionId }),
};

// === SSH TOFU / 隧道事件 ===

/** 后端事件名常量 */
export const SSH_EVENTS = {
  tofuRequest: "ssh:tofu-request",
  hopStatus: "ssh:hop-status",
  hopRtt: "ssh:hop-rtt",
} as const;

/** `ssh:tofu-request` 事件载荷 */
export interface TofuRequestPayload {
  connectionId: string;
  hopIndex: number;
  host: string;
  port: number;
  fingerprint: string;
}

/** `ssh:hop-status` 事件载荷 */
export interface HopStatusPayload {
  connectionId: string;
  sessionId: string;
  hopIndex: number;
  status: "pending" | "connected" | "failed" | "lost";
  reason: string | null;
}

/** `ssh:hop-rtt` 事件载荷；为累计到该 SSH session 的协议 RTT，不是 ICMP。 */
export interface HopRttPayload {
  connectionId: string;
  sessionId: string;
  hopIndex: number;
  state: "measured" | "timeout" | "unavailable";
  rttMs: number | null;
}

/** TOFU 决策回传 command */
export const tofuApi = {
  decide: (connectionId: string, hopIndex: number, accept: boolean) =>
    invoke<void>("ssh_tofu_decision", { connectionId, hopIndex, accept }),
};

// === 主密码安全（FR-102）===

/** 主密码状态：disabled（未启用）/ locked（已启用待解锁）/ unlocked（已解锁） */
export type SecurityStatus = "disabled" | "locked" | "unlocked";

export interface SecurityStatusPayload {
  status: SecurityStatus;
  /** 仅主密码解锁后允许持久化 SSH 私钥 passphrase */
  canPersistPassphrase: boolean;
}

export const securityApi = {
  status: () => invoke<SecurityStatusPayload>("security_status"),
  setup: (password: string) => invoke<void>("security_setup", { password }),
  unlock: (password: string) => invoke<void>("security_unlock", { password }),
  lock: () => invoke<void>("security_lock"),
  disable: (password: string) => invoke<void>("security_disable", { password }),
  /** 忘记主密码：删除全部加密数据（连接 / passphrase / SQL 历史），不可恢复 */
  reset: () => invoke<void>("security_reset"),
};

// === SQL 历史（FR-106）===

/** 单条 SQL 历史记录（后端加密落盘，最多保留 100 条） */
export interface HistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  driver: string;
  database: string;
  schema: string | null;
  sql: string;
  executedAt: string;
  success: boolean;
}

export const historyApi = {
  list: () => invoke<HistoryEntry[]>("history_list"),
  clear: () => invoke<void>("history_clear"),
};

// === 结果集导出（FR-107）===

export type ExportFormat = "csv" | "xlsx";

export interface ExportResult {
  /** 实际写出的数据行数（不含表头） */
  rows: number;
  /** 结果集是否被 10 万行硬上限截断 */
  truncated: boolean;
}

export const exportApi = {
  /** 重新执行 SQL 并在后端流式写出文件；结果不经过前端序列化 */
  query: (id: string, sql: string, format: ExportFormat, path: string) =>
    invoke<ExportResult>("db_export_query", { id, sql, format, path }),
};
