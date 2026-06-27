// 前端 ↔ 后端 IPC 封装：类型、command 调用、错误 i18n key → 中文
//
// Week 2 暂用静态 map 翻译错误；Week 3 接 i18next 后替换 translateError。

import { invoke } from "@tauri-apps/api/core";

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
  "error.driver.connect_failed": "MySQL 连接失败",
  "error.driver.query_failed": "SQL 执行失败",
};

/** 把后端返回的错误（可能是 i18n key）翻译成中文 */
export function translateError(e: unknown): string {
  const key = typeof e === "string" ? e : String(e);
  return ERROR_ZH[key] ?? key;
}

/** 连接管理相关 command */
export const connectionApi = {
  list: () => invoke<StoredConnection[]>("connection_list"),
  create: (input: ConnectionInput) =>
    invoke<StoredConnection>("connection_create", { input }),
  update: (connection: StoredConnection) =>
    invoke<void>("connection_update", { connection }),
  remove: (id: string) => invoke<void>("connection_delete", { id }),
  test: (input: ConnectionInput) => invoke<void>("connection_test", { input }),
};
