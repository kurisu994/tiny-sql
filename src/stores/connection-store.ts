// 连接列表全局状态（zustand）
//
// 所有写操作后 reload 一遍，保证列表与后端落盘一致（Week 2 列表小，全量拉取够用）。

import { create } from "zustand";

import {
  connectionApi,
  isTauriRuntime,
  translateError,
  type ConnectionInput,
  type StoredConnection,
} from "@/lib/tauri-api";

interface ConnectionState {
  connections: StoredConnection[];
  loading: boolean;
  error: string | null;
  /** 拉取连接列表 */
  load: () => Promise<void>;
  /** 新建连接 */
  create: (input: ConnectionInput) => Promise<void>;
  /** 更新连接 */
  update: (connection: StoredConnection) => Promise<void>;
  /** 删除连接 */
  remove: (id: string) => Promise<void>;
  /** 按拖拽后的完整顺序重排（本地先落位，失败回滚） */
  reorder: (ids: string[]) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true });
    if (!isTauriRuntime()) {
      set({ connections: [], error: null, loading: false });
      return;
    }
    try {
      const connections = await connectionApi.list();
      set({ connections, error: null });
    } catch (e) {
      set({ error: translateError(e) });
    } finally {
      set({ loading: false });
    }
  },

  create: async (input) => {
    await connectionApi.create(input);
    await get().load();
  },

  update: async (connection) => {
    await connectionApi.update(connection);
    await get().load();
  },

  remove: async (id) => {
    await connectionApi.remove(id);
    await get().load();
  },

  reorder: async (ids) => {
    const previous = get().connections;
    const byId = new Map(previous.map((c) => [c.id, c]));
    const next = ids
      .map((id) => byId.get(id))
      .filter((c): c is StoredConnection => c !== undefined);
    // ids 应是当前列表的全排列；对不上说明列表已变，退回后端结果为准
    if (next.length !== previous.length) {
      await get().load();
      return;
    }
    // 先本地落位，避免松手后列表回弹一帧
    set({ connections: next, error: null });
    try {
      await connectionApi.reorder(ids);
    } catch (e) {
      set({ connections: previous, error: translateError(e) });
    }
  },
}));
