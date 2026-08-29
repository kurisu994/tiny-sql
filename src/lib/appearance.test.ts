import { describe, expect, it } from "vitest";

import { isThemePreference, resolveDark } from "@/lib/appearance";

describe("appearance", () => {
  it("只接受 system / light / dark", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  it("跟随系统时用系统暗色，浅/深色强制覆盖", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });
});
