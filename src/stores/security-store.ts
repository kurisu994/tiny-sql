// 主密码安全状态（zustand）
//
// 镜像后端 SecurityManager 状态机：启动时拉取一次，Locked 时由 UI 层弹解锁框；
// 解锁 / 锁定 / 启用 / 关闭 / 重置后同步刷新。passphrase 持久化能力也由此暴露。

import { create } from "zustand";

import {
  isTauriRuntime,
  securityApi,
  type SecurityStatus,
} from "@/lib/tauri-api";

interface SecurityState {
  status: SecurityStatus;
  /** 仅主密码解锁后允许持久化 SSH 私钥 passphrase */
  canPersistPassphrase: boolean;
  /** 启动时是否已完成首次状态拉取 */
  initialized: boolean;

  refresh: () => Promise<void>;
  setup: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => Promise<void>;
  disable: (password: string) => Promise<void>;
  reset: () => Promise<void>;
}

export const useSecurityStore = create<SecurityState>((set, get) => ({
  status: "disabled",
  canPersistPassphrase: false,
  initialized: false,

  refresh: async () => {
    if (!isTauriRuntime()) {
      set({ initialized: true });
      return;
    }
    const payload = await securityApi.status();
    set({
      status: payload.status,
      canPersistPassphrase: payload.canPersistPassphrase,
      initialized: true,
    });
  },

  setup: async (password) => {
    await securityApi.setup(password);
    await get().refresh();
  },

  unlock: async (password) => {
    await securityApi.unlock(password);
    await get().refresh();
  },

  lock: async () => {
    await securityApi.lock();
    await get().refresh();
  },

  disable: async (password) => {
    await securityApi.disable(password);
    await get().refresh();
  },

  reset: async () => {
    await securityApi.reset();
    await get().refresh();
  },
}));
