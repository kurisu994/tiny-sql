import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const nextConfig: NextConfig = {
  // Tauri 用静态导出（产物落到 out/，对应 tauri.conf.json 的 frontendDist）
  output: "export",
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
};

export default nextConfig;
