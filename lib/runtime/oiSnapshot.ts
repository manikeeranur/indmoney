// ─── OI snapshot recorder ───────────────────────────────────────────────────────
// INDstocks historical candles carry NO open interest (confirmed against the
// docs) — only the live option chain and the price WS's "quote" mode do. The
// Kite app's EOD OHLC CSV had an OI column sourced from historical candles,
// which is simply not available here.
//
// The auto-trade engine subscribes every entered leg in "quote" mode (see
// lib/runtime/autoTrade.ts) specifically so this file can capture OI for the
// minutes a trade was actually open, and the EOD report merges it back in by
// IST minute bucket — the best substitute available without a paid tick-store.
import { onTicks } from "@/lib/broker/wsPrices";
import type { Tick } from "@/lib/broker/types";

type Store = Map<number, Map<string, number>>; // token -> "HH:MM" -> oi

function store(): Store {
  const g = globalThis as any;
  g.__INDMONEY_OI_SNAPSHOT__ ??= new Map();
  return g.__INDMONEY_OI_SNAPSHOT__;
}

function minuteKey(): string {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${String(ist.getHours()).padStart(2, "0")}:${String(ist.getMinutes()).padStart(2, "0")}`;
}

let listening = false;

export function startOiSnapshotRecorder() {
  if (listening) return;
  listening = true;
  onTicks((ticks: Tick[]) => {
    for (const t of ticks) {
      if (t.oi === undefined) continue;
      const s = store();
      let byMinute = s.get(t.instrument_token);
      if (!byMinute) { byMinute = new Map(); s.set(t.instrument_token, byMinute); }
      byMinute.set(minuteKey(), t.oi);
    }
  });
}

export function getOiForMinute(token: number, hhmm: string): number | null {
  return store().get(token)?.get(hhmm) ?? null;
}
