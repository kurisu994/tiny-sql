import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "tiny-sql",
  description: "多级跳板机友好的 MySQL 桌面客户端",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
