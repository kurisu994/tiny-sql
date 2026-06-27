import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 前端单元测试：jsdom 环境 + @ 别名（对齐 tsconfig paths）
// 注：Tauri WebDriver E2E 不支持 macOS，playwright 推迟（见 CHANGELOG）
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
