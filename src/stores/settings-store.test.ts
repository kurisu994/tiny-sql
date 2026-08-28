import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  effectiveProxy,
  isValidProxyUrl,
  loadSettings,
  useSettingsStore,
} from "@/stores/settings-store";

const STORAGE_KEY = "tiny-sql:settings";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS });
  document.documentElement.style.removeProperty("--tiny-sql-editor-font-size");
});

describe("settings-store", () => {
  it("默认值：首次启动无存储时全部回落默认", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("update 立即持久化并可读回", () => {
    useSettingsStore.getState().update({ autoCheckUpdate: false });
    useSettingsStore.getState().update({ defaultPageSize: 100 });

    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      autoCheckUpdate: false,
      defaultPageSize: 100,
    });
  });

  it("非法值逐字段回落默认，不整体丢弃合法字段", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        autoCheckUpdate: false,
        confirmWrite: "no",
        defaultPageSize: 999,
        editorFontSize: 12,
      }),
    );

    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      autoCheckUpdate: false,
      editorFontSize: 12,
    });
  });

  it("存储内容损坏时回落默认值", () => {
    localStorage.setItem(STORAGE_KEY, "{ 不是 JSON");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("hydrate 载入偏好并同步编辑器字号 CSS 变量", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, editorFontSize: 16 }),
    );

    useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().editorFontSize).toBe(16);
    expect(
      document.documentElement.style.getPropertyValue(
        "--tiny-sql-editor-font-size",
      ),
    ).toBe("16px");
  });

  it("代理地址校验：留空合法，http / https / socks 均受支持", () => {
    expect(isValidProxyUrl("")).toBe(true);
    expect(isValidProxyUrl("   ")).toBe(true);
    expect(isValidProxyUrl("http://127.0.0.1:7890")).toBe(true);
    expect(isValidProxyUrl("https://proxy.internal:3128")).toBe(true);
    expect(isValidProxyUrl("http://user:pass@127.0.0.1:7890")).toBe(true);
    // socks 由 src-tauri 显式依赖 reqwest 启用 socks feature 支撑
    expect(isValidProxyUrl("socks5://127.0.0.1:7890")).toBe(true);
    expect(isValidProxyUrl("socks5h://proxy.internal:1080")).toBe(true);
    expect(isValidProxyUrl("socks4://1.2.3.4:1080")).toBe(true);

    expect(isValidProxyUrl("ftp://127.0.0.1:2121")).toBe(false);
    expect(isValidProxyUrl("127.0.0.1:7890")).toBe(false);
    expect(isValidProxyUrl("socks5://")).toBe(false);
    expect(isValidProxyUrl(`http://h/${"x".repeat(512)}`)).toBe(false);
  });

  it("effectiveProxy：留空或非法回落直连，合法地址去空白后生效", () => {
    expect(effectiveProxy("")).toBeUndefined();
    expect(effectiveProxy("   ")).toBeUndefined();
    expect(effectiveProxy("ftp://127.0.0.1:2121")).toBeUndefined();
    expect(effectiveProxy("  socks5://127.0.0.1:7890  ")).toBe(
      "socks5://127.0.0.1:7890",
    );
  });

  it("代理地址持久化：旧版本存下的非法值由 effectiveProxy 兜底", () => {
    useSettingsStore.getState().update({ updateProxy: "socks5://127.0.0.1:7890" });
    expect(loadSettings().updateProxy).toBe("socks5://127.0.0.1:7890");

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, updateProxy: "socks5://" }),
    );
    expect(loadSettings().updateProxy).toBe("socks5://");
    expect(effectiveProxy("socks5://")).toBeUndefined();
  });

  it("reset 恢复默认并落盘", () => {
    useSettingsStore.getState().update({ confirmWrite: false, editorFontSize: 14 });
    useSettingsStore.getState().reset();

    expect(useSettingsStore.getState().confirmWrite).toBe(true);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(
      document.documentElement.style.getPropertyValue(
        "--tiny-sql-editor-font-size",
      ),
    ).toBe("12px");
  });
});
