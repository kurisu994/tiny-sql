// 全局确认弹窗状态（zustand）
//
// 用法接近 window.confirm 但返回 Promise，由顶层挂载的 <ConfirmDialog /> 渲染：
//   if (!(await confirm({ message: "确定？", danger: true }))) return;

import { create } from "zustand";

export interface ConfirmOptions {
  title?: string;
  message: string;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作：确认按钮显示为红色 */
  danger?: boolean;
}

interface ConfirmState {
  /** 当前挂起的确认请求（null 表示无弹窗） */
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  /** 唤起确认弹窗，返回用户是否确认 */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 由弹窗按钮回填结果并关闭 */
  respond: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({ current: { ...options, resolve } });
    }),

  respond: (ok) => {
    const { current } = get();
    current?.resolve(ok);
    set({ current: null });
  },
}));
