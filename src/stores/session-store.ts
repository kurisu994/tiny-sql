// 活跃连接会话状态（zustand）
//
// v0.1 同一时刻浏览一条已打开连接：管理连接打开/关闭、passphrase 弹窗、
// schema/table 浏览与 keepalive 断开提示。

import { create } from "zustand";

import {
  connectionApi,
  dbApi,
  translateError,
  type DatabaseMeta,
  type RowSet,
  type TableMeta,
} from "@/lib/tauri-api";

/** 反引号包裹标识符，内部反引号双写转义 */
function quoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

type Status = "idle" | "connecting" | "connected" | "error";

interface SessionState {
  /** 当前打开的连接 id（未连接为 null） */
  openId: string | null;
  status: Status;
  errorMsg: string | null;
  /** 需要私钥 passphrase 时挂起的连接 id（触发弹窗） */
  passphraseFor: string | null;
  databases: DatabaseMeta[];
  selectedDb: string | null;
  tables: TableMeta[];
  selectedTable: string | null;
  rowSet: RowSet | null;
  loadingData: boolean;
  /** keepalive 已断开的跳序号 */
  lostHops: number[];

  open: (id: string, passphrase?: string) => Promise<void>;
  close: () => Promise<void>;
  submitPassphrase: (passphrase: string) => Promise<void>;
  cancelPassphrase: () => void;
  selectDb: (db: string) => Promise<void>;
  selectTable: (table: string) => Promise<void>;
  markHopLost: (hopIndex: number) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  openId: null,
  status: "idle",
  errorMsg: null,
  passphraseFor: null,
  databases: [],
  selectedDb: null,
  tables: [],
  selectedTable: null,
  rowSet: null,
  loadingData: false,
  lostHops: [],

  open: async (id, passphrase) => {
    set({
      status: "connecting",
      errorMsg: null,
      lostHops: [],
      passphraseFor: null,
    });
    try {
      await connectionApi.open(id, passphrase);
      const databases = await dbApi.listDatabases(id);
      set({
        openId: id,
        status: "connected",
        databases,
        selectedDb: null,
        tables: [],
        selectedTable: null,
        rowSet: null,
      });
    } catch (e) {
      const key = typeof e === "string" ? e : String(e);
      // 私钥需要 passphrase → 弹窗收集后重试
      if (key === "error.ssh.invalid_passphrase") {
        set({ status: "idle", passphraseFor: id });
        return;
      }
      set({ status: "error", errorMsg: translateError(e), openId: null });
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
      status: "idle",
      errorMsg: null,
      passphraseFor: null,
      databases: [],
      selectedDb: null,
      tables: [],
      selectedTable: null,
      rowSet: null,
      lostHops: [],
    });
  },

  submitPassphrase: async (passphrase) => {
    const { passphraseFor } = get();
    if (passphraseFor) await get().open(passphraseFor, passphrase);
  },

  cancelPassphrase: () => set({ passphraseFor: null, status: "idle" }),

  selectDb: async (db) => {
    const { openId } = get();
    if (!openId) return;
    set({
      selectedDb: db,
      selectedTable: null,
      rowSet: null,
      loadingData: true,
    });
    try {
      const tables = await dbApi.listTables(openId, db);
      set({ tables, loadingData: false });
    } catch (e) {
      set({ errorMsg: translateError(e), loadingData: false });
    }
  },

  selectTable: async (table) => {
    const { openId, selectedDb } = get();
    if (!openId || !selectedDb) return;
    set({ selectedTable: table, loadingData: true });
    try {
      // Week 3 简单加 LIMIT 1000；Week 4 改后端子查询包装防 OOM
      const sql = `SELECT * FROM ${quoteIdent(selectedDb)}.${quoteIdent(
        table,
      )} LIMIT 1000`;
      const rowSet = await dbApi.query(openId, sql);
      set({ rowSet, loadingData: false });
    } catch (e) {
      set({ errorMsg: translateError(e), loadingData: false, rowSet: null });
    }
  },

  markHopLost: (hopIndex) =>
    set((s) =>
      s.lostHops.includes(hopIndex)
        ? s
        : { lostHops: [...s.lostHops, hopIndex] },
    ),
}));
