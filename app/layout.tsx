import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "seed0 — realistic seed data, on demand",
  description:
    "Turn a Postgres schema into a validated seed dataset for your preview deployments.",
};

// Runs before React hydrates. Reads the persisted theme and toggles the
// dark class on <html> so the first paint matches the user's choice.
const themeBootstrap = `(() => {
  try {
    const k = "seed0-theme";
    const stored = localStorage.getItem(k);
    const theme = stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "dark";
    const dark = theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
