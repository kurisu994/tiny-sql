import type { Metadata } from "next";

import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/appearance";

import "./globals.css";

export const metadata: Metadata = {
  title: "tiny-sql",
  description: "多级跳板机友好的 MySQL 桌面客户端",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
