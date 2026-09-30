import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme";
import FontLoader from "@/components/FontLoader";

// ~30 places across the app set fontFamily: "'Inter', sans-serif" directly (inline styles, SVG text, <canvas> ctx.font
// strings for the chart/payoff-diagram drawing) — those need the literal
// Google font name registered globally, which next/font/google can't do (it
// always scopes to a generated local name), so the stylesheet link stays,
// just loaded non-blocking via FontLoader instead of globals.css's old
// @import (which forced the browser to download+parse the whole CSS file,
// discover the @import, THEN fetch fonts.googleapis.com, sequentially,
// before anything could paint — ~1s wasted per Lighthouse).

export const metadata: Metadata = {
  title: "INDMONEY",
  description: "NIFTY options algo — SMC and VWAP strategies on INDstocks",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f0f4f8", // matches the light theme's --bg — the app's real default
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <FontLoader />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
