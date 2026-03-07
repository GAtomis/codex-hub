import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Codex Hub",
  description: "Multi-project Codex runtime dashboard"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
