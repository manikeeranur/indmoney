"use client";

// ─── Live index ticker ──────────────────────────────────────────────────────
// Full port of frontend/components/IndexSwiper.tsx: the horizontally
// scrollable strip of NIFTY 50 / SENSEX / BANK NIFTY / FIN NIFTY / MIDCAP
// NIFTY / NIFTY NXT 50 / BANKEX / INDIA VIX pills, each showing live LTP and
// ▲/▼ change. Backed by /api/index-quotes, which resolves every index
// through INDstocks' own index instrument master (never Kite's hardcoded
// tokens — those mean nothing to a different broker).
//
// Ported without the `swiper` library dependency — a plain flex row with
// overflow-x-auto gives the same horizontally-scrollable pill strip with one
// less package to maintain.
//
// SCOPE CUT, stated plainly: the original makes every pill open a full
// TradingChartModal in "index" mode (isIndex, no strike/expiry, no
// buy/sell). ChartPanel here is deliberately option-leg-only (see its own
// header comment), so these pills are display-only for now rather than
// reopening that decision for a secondary ticker feature.
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";

const MONO = { fontFamily: "'Inter', sans-serif" } as const;

const INDEX_META: Record<string, { label: string; exchange: "NSE" | "BSE" }> = {
  "NSE:NIFTY 50": { label: "NIFTY 50", exchange: "NSE" },
  "BSE:SENSEX": { label: "SENSEX", exchange: "BSE" },
  "NSE:NIFTY BANK": { label: "BANK NIFTY", exchange: "NSE" },
  "NSE:NIFTY FIN SERVICE": { label: "FIN NIFTY", exchange: "NSE" },
  "NSE:NIFTY MID SELECT": { label: "MIDCAP NIFTY", exchange: "NSE" },
  "NSE:NIFTY NEXT 50": { label: "NIFTY NXT 50", exchange: "NSE" },
  "BSE:BANKEX": { label: "BANKEX", exchange: "BSE" },
  "NSE:INDIA VIX": { label: "INDIA VIX", exchange: "NSE" },
};

type IndexData = { key: string; ltp: number; prevClose: number; ltpChange: number; pctChange: number };

export default function IndexSwiper() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [indices, setIndices] = useState<IndexData[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch("/api/index-quotes");
        const d = await r.json();
        if (d.indices) setIndices(d.indices);
      } catch {}
    }
    load();
    timerRef.current = setInterval(load, 5000);
    return () => clearInterval(timerRef.current);
  }, []);

  const bg = isDark ? "#0d1420" : "#fff";
  const border = isDark ? "#1e2a3a" : "#e2e8f0";
  const txtPri = isDark ? "#e2e8f0" : "#1e293b";
  const txtMut = isDark ? "#64748b" : "#94a3b8";

  if (!indices.length) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-3 pb-1 pt-3" style={{ scrollbarWidth: "none" }}>
      {indices.map(idx => {
        const meta = INDEX_META[idx.key];
        if (!meta) return null;
        const up = idx.ltpChange >= 0;
        const clr = up ? "#16a34a" : "#e11d48";
        const pct = idx.pctChange;
        return (
          <div key={idx.key} className="flex flex-shrink-0 flex-col gap-0.5 rounded-xl px-3 py-2" style={{ background: bg, border: `1px solid ${border}`, minWidth: 110 }}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-black" style={{ ...MONO, color: txtPri }}>{meta.label}</span>
              <span className="flex-shrink-0 rounded px-1 py-0.5 text-xs font-bold" style={{ background: isDark ? "#1e2a3a" : "#f1f5f9", color: txtMut }}>{meta.exchange}</span>
            </div>
            <span className="tabular-nums text-start text-base font-black leading-tight" style={{ ...MONO, color: txtPri }}>
              {idx.ltp > 0 ? idx.ltp.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : (idx.prevClose > 0 ? idx.prevClose.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—")}
            </span>
            <div className="flex items-center gap-1">
              <span className="tabular-nums text-xs font-bold" style={{ ...MONO, color: clr }}>{up ? "▲" : "▼"} {Math.abs(idx.ltpChange).toFixed(2)}</span>
              <span className="tabular-nums text-xs font-bold" style={{ ...MONO, color: clr }}>({Math.abs(pct).toFixed(2)}%)</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
