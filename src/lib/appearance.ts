/** 外观偏好：跟随系统 / 浅色 / 深色。 */
export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_CHOICES)[number];

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/** 与 settings-store 的 localStorage 键一致，启动脚本只读这一份。 */
const SETTINGS_STORAGE_KEY = "tiny-sql:settings";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** 把偏好解析成是否给 <html> 挂 .dark */
export function resolveDark(theme: ThemePreference, systemDark: boolean): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return systemDark;
}

function setRootDark(dark: boolean) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

let systemMedia: MediaQueryList | null = null;
let systemHandler: (() => void) | null = null;

function stopSystemListener() {
  if (systemMedia && systemHandler) {
    systemMedia.removeEventListener("change", systemHandler);
  }
  systemMedia = null;
  systemHandler = null;
}

/**
 * 按偏好把 .dark 写到 <html>。
 * 跟随系统时监听 prefers-color-scheme，切走其它项时卸掉监听。
 */
export function applyAppearance(theme: ThemePreference) {
  stopSystemListener();
  if (theme === "system") {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    const sync = () => setRootDark(media?.matches ?? false);
    sync();
    if (media) {
      media.addEventListener("change", sync);
      systemMedia = media;
      systemHandler = sync;
    }
    return;
  }
  setRootDark(theme === "dark");
}

/**
 * 进页面立刻跑，避免 hydrate 前闪一下浅色。
 * 只读 localStorage，不依赖 zustand。
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var theme="system";var raw=localStorage.getItem(${JSON.stringify(SETTINGS_STORAGE_KEY)});if(raw){var t=JSON.parse(raw).theme;if(t==="light"||t==="dark"||t==="system")theme=t;}var dark=theme==="dark"||(theme!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",dark);r.style.colorScheme=dark?"dark":"light";}catch(e){}})();`;

/** 测试用：卸掉系统主题监听。 */
export function resetAppearanceForTests() {
  stopSystemListener();
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.classList.remove("dark");
  root.style.colorScheme = "";
}
