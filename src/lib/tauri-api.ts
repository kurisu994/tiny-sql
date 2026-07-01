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
  connectTimeoutEnabled: boolean;
  connectTimeoutSeconds: number;
  readTimeoutEnabled: boolean;
  readTimeoutSeconds: number;
  writeTimeoutEnabled: boolean;
  writeTimeoutSeconds: number;
  compressionEnabled: boolean;
  autoConnect: boolean;
}

/** 持久化的连接配置（与后端 StoredConnection 对齐，camelCase） */
export interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssh: SshConfig;
  ssl: SslConfig;
  advanced: AdvancedConfig;
  lastUsedAt?: string | null;
}

/** 新建 / 测试连接的入参（不含 id） */
export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssh: SshConfig;
  ssl: SslConfig;
  advanced: AdvancedConfig;
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
  "error.driver.connect_failed": "MySQL 连接失败",
  "error.driver.query_failed": "SQL 执行失败",
  "error.driver.invalid_sql": "SQL 不能为空或格式不合法",
  "error.driver.multiple_statements": "一次只能执行一条 SQL",
  "error.driver.write_requires_confirmation": "检测到写操作，需要二次确认",
  "error.driver.query_cancelled": "SQL 已取消",
  "error.connection.not_found": "连接配置不存在",
  "error.connection.not_open": "连接尚未打开",
};

/** 把后端返回的错误（可能是 i18n key）翻译成中文 */
export function translateError(e: unknown): string {
  const key = typeof e === "string" ? e : String(e);
  return ERROR_ZH[key] ?? key;
}

// === 应用更新 ===

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
  test: (input: ConnectionInput) => invoke<void>("connection_test", { input }),
  /** 打开连接（建隧道 + 连接池）；passphrase 仅本次会话生效 */
  open: (id: string, passphrase?: string) =>
    invoke<void>("connection_open", { id, passphrase: passphrase ?? null }),
  /** 关闭连接 */
  close: (id: string) => invoke<void>("connection_close", { id }),
};

// === 数据浏览（schema / 结果集）===

/** database（= MySQL schema）元信息 */
export interface DatabaseMeta {
  name: string;
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
}

/** 基于已打开连接的数据浏览 command */
export const dbApi = {
  listDatabases: (id: string) =>
    invoke<DatabaseMeta[]>("db_list_databases", { id }),
  listTables: (id: string, database: string) =>
    invoke<TableMeta[]>("db_list_tables", { id, database }),
  listColumns: (id: string, database: string, table: string) =>
    invoke<ColumnMeta[]>("db_list_columns", { id, database, table }),
  query: (id: string, sql: string, options: QueryOptions = {}) =>
    invoke<RowSet>("db_query", {
      id,
      sql,
      queryId: options.queryId ?? null,
      rowLimit: options.rowLimit ?? null,
      allowWrite: options.allowWrite ?? false,
    }),
  cancelQuery: (queryId: string) =>
    invoke<void>("db_query_cancel", { queryId }),
};

// === SSH TOFU / 隧道事件 ===

/** 后端事件名常量 */
export const SSH_EVENTS = {
  tofuRequest: "ssh:tofu-request",
  hopStatus: "ssh:hop-status",
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
  hopIndex: number;
  status: "pending" | "connected" | "failed" | "lost";
  reason: string | null;
}

/** TOFU 决策回传 command */
export const tofuApi = {
  decide: (connectionId: string, hopIndex: number, accept: boolean) =>
    invoke<void>("ssh_tofu_decision", { connectionId, hopIndex, accept }),
};
