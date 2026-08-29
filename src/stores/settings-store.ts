// 应用偏好设置（zustand）
//
// 只存「纯 UI 偏好」，落 localStorage：不含密钥、连接信息等敏感数据，
// 因此不走后端加密 store（与 column-widths 的持久化策略一致）。
// 读取容错：localStorage 不可用或内容损坏时静默回落到默认值，
// 保证隐私模式 / 首次启动也能正常用。

import { create } from "zustand";

import {
  applyAppearance,
  isThemePreference,
  type ThemePreference,
} from "@/lib/appearance";

const STORAGE_KEY = "tiny-sql:settings";

/** 数据浏览默认每页行数的可选项，与 browse-view 的分页下拉保持一致 */
export const PAGE_SIZE_CHOICES = [100, 500, 1000] as const;
/** SQL 编辑器字号可选项（px） */
export const EDITOR_FONT_SIZE_CHOICES = [11, 12, 13, 14, 16] as const;
export type { ThemePreference };
/** 代理地址最大长度，防止误粘贴超长内容塞满 localStorage */
const PROXY_MAX_LENGTH = 512;

/**
 * 更新代理支持的 scheme，与后端 reqwest 的能力一一对应。
 *
 * socks 一族需要 reqwest 的 socks feature，由 `src-tauri/Cargo.toml` 显式依赖
 * reqwest 启用（见那里的注释与 `update_proxy_supports_*` 测试）。
 */
const PROXY_SCHEMES = [
  "http:",
  "https:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
];

/** 校验更新代理地址。空串合法，表示不使用代理。 */
export function isValidProxyUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  if (value.length > PROXY_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return PROXY_SCHEMES.includes(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

/** 取实际生效的代理地址：留空或非法时返回 undefined（即直连） */
export function effectiveProxy(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || !isValidProxyUrl(value)) return undefined;
  return value;
}

/** 可持久化的偏好项 */
export interface Settings {
  /** 启动后与每 24 小时自动检查更新 */
  autoCheckUpdate: boolean;
  /** 检查与下载更新使用的代理地址（http / https / socks5 等），空串表示直连 */
  updateProxy: string;
  /** 执行写操作（INSERT/UPDATE/DELETE/DDL 等）前弹二次确认 */
  confirmWrite: boolean;
  /** 新建表数据浏览 tab 时的默认每页行数 */
  defaultPageSize: number;
  /** SQL 编辑器字号（px） */
  editorFontSize: number;
  /** 界面外观：跟随系统 / 浅色 / 深色 */
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: Settings = {
  autoCheckUpdate: true,
  updateProxy: "",
  confirmWrite: true,
  defaultPageSize: 1000,
  editorFontSize: 12,
  theme: "system",
};

/** 逐字段校验读回的 JSON：任何字段缺失或越界都退回默认值，不整体丢弃 */
function sanitize(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
  const value = raw as Record<string, unknown>;
  const pick = <T extends number>(key: string, choices: readonly T[], fallback: T): T => {
    const v = value[key];
    return typeof v === "number" && (choices as readonly number[]).includes(v)
      ? (v as T)
      : fallback;
  };
  return {
    autoCheckUpdate:
      typeof value.autoCheckUpdate === "boolean"
        ? value.autoCheckUpdate
        : DEFAULT_SETTINGS.autoCheckUpdate,
    // 兜底非法值：旧版本存进来的内容也由 effectiveProxy 在使用点回落直连
    updateProxy:
      typeof value.updateProxy === "string" &&
      value.updateProxy.length <= PROXY_MAX_LENGTH
        ? value.updateProxy
        : DEFAULT_SETTINGS.updateProxy,
    confirmWrite:
      typeof value.confirmWrite === "boolean"
        ? value.confirmWrite
        : DEFAULT_SETTINGS.confirmWrite,
    defaultPageSize: pick(
      "defaultPageSize",
      PAGE_SIZE_CHOICES,
      DEFAULT_SETTINGS.defaultPageSize as (typeof PAGE_SIZE_CHOICES)[number],
    ),
    editorFontSize: pick(
      "editorFontSize",
      EDITOR_FONT_SIZE_CHOICES,
      DEFAULT_SETTINGS.editorFontSize as (typeof EDITOR_FONT_SIZE_CHOICES)[number],
    ),
    theme: isThemePreference(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
  };
}

/** 从 localStorage 读取偏好，损坏或不可用时回落默认值 */
export function loadSettings(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function snapshot(state: Settings): Settings {
  return {
    autoCheckUpdate: state.autoCheckUpdate,
    updateProxy: state.updateProxy,
    confirmWrite: state.confirmWrite,
    defaultPageSize: state.defaultPageSize,
    editorFontSize: state.editorFontSize,
    theme: state.theme,
  };
}

function persist(settings: Settings) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage 不可用时降级为「本次会话内有效」
  }
}

/**
 * 把编辑器字号写进 CSS 变量：CodeMirror 主题读 var(--tiny-sql-editor-font-size)，
 * 改字号无需重建编辑器实例。
 */
export function applyEditorFontSize(size: number) {
  globalThis.document?.documentElement.style.setProperty(
    "--tiny-sql-editor-font-size",
    `${size}px`,
  );
}

interface SettingsState extends Settings {
  /** 从 localStorage 载入并同步副作用（CSS 变量与外观 class），应用启动时调用一次 */
  hydrate: () => void;
  /** 更新部分字段并立即持久化 */
  update: (patch: Partial<Settings>) => void;
  /** 全部恢复默认 */
  reset: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,

  hydrate: () => {
    const loaded = loadSettings();
    set(loaded);
    applyEditorFontSize(loaded.editorFontSize);
    applyAppearance(loaded.theme);
  },

  update: (patch) => {
    set(patch);
    const next = snapshot(get());
    persist(next);
    if (patch.editorFontSize !== undefined) applyEditorFontSize(next.editorFontSize);
    if (patch.theme !== undefined) applyAppearance(next.theme);
  },

  reset: () => {
    set({ ...DEFAULT_SETTINGS });
    persist({ ...DEFAULT_SETTINGS });
    applyEditorFontSize(DEFAULT_SETTINGS.editorFontSize);
    applyAppearance(DEFAULT_SETTINGS.theme);
  },
}));
