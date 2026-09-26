import { NextResponse } from "next/server";
import { getIndexToken } from "@/lib/broker/instruments";
import { getLtp, getHistorical } from "@/lib/broker/marketdata";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// ─── Live index ticker (Watchlist tab) — ported from frontend's IndexSwiper,
// which read these off Kite's instrument tokens (256265 for NIFTY 50, etc).
// Those numbers are Zerodha-specific and mean nothing to INDstocks, so every
// index here is resolved through INDstocks' own index instrument master
// (lib/broker/instruments.ts's getIndexToken) instead of being hardcoded.
const INDICES: Array<{ key: string; label: string; exchange: "NSE" | "BSE"; candidates: string[] }> = [
  { key: "NSE:NIFTY 50",           label: "NIFTY 50",       exchange: "NSE", candidates: ["NIFTY 50", "NIFTY50", "NIFTY"] },
  { key: "BSE:SENSEX",             label: "SENSEX",          exchange: "BSE", candidates: ["SENSEX", "BSE SENSEX"] },
  { key: "NSE:NIFTY BANK",         label: "BANK NIFTY",      exchange: "NSE", candidates: ["NIFTY BANK", "BANKNIFTY"] },
  { key: "NSE:NIFTY FIN SERVICE",  label: "FIN NIFTY",       exchange: "NSE", candidates: ["NIFTY FIN SERVICE", "NIFTY FINANCIAL", "FINNIFTY"] },
  { key: "NSE:NIFTY MID SELECT",   label: "MIDCAP NIFTY",    exchange: "NSE", candidates: ["NIFTY MID SELECT", "NIFTY MIDCAP SEL", "MIDCPNIFTY"] },
  { key: "NSE:NIFTY NEXT 50",      label: "NIFTY NXT 50",    exchange: "NSE", candidates: ["NIFTY NEXT 50", "NIFTYNEXT50"] },
  { key: "BSE:BANKEX",             label: "BANKEX",          exchange: "BSE", candidates: ["BANKEX", "BSE BANKEX"] },
  { key: "NSE:INDIA VIX",          label: "INDIA VIX",       exchange: "NSE", candidates: ["INDIA VIX", "INDIAVIX"] },
];

type Closes = { lastClose: number; priorClose: number };
type Cache = { at: number; tokens: Record<string, number | null>; prevClose: Record<string, { date: string; value: Closes }> };
function cache(): Cache {
  const g = globalThis as any;
  g.__INDMONEY_INDEX_QUOTES__ ??= { at: 0, tokens: {}, prevClose: {} };
  return g.__INDMONEY_INDEX_QUOTES__;
}

async function resolveToken(idx: (typeof INDICES)[number], c: Cache): Promise<number | null> {
  if (c.tokens[idx.key] !== undefined) return c.tokens[idx.key];
  const token = await getIndexToken(idx.candidates).catch(() => null);
  c.tokens[idx.key] = token;
  return token;
}

// Fetches the last TWO complete trading days' closes, not just one. When
// there's no live price (market closed — INDstocks' live_price reads 0
// outside session hours), the card falls back to showing lastClose as the
// headline figure; the % it shows alongside needs a REAL prior-day change
// (lastClose vs priorClose), not "0 vs lastClose", which would read as a
// fake -100% move. This is what the old Kite app shows on a closed market
// too (it carries the last real change forward, never a flat 0%).
async function resolveCloses(idx: (typeof INDICES)[number], token: number, c: Cache): Promise<Closes> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const cached = c.prevClose[idx.key];
  if (cached?.date === today) return cached.value;

  const scripCode = `${idx.exchange}_${token}`;
  const to = new Date();
  const from = new Date(to); from.setDate(from.getDate() - 10);
  const map = await getHistorical([scripCode], "1day", from, to, "NIFTY", "EQUITY").catch(() => ({} as Record<string, Awaited<ReturnType<typeof getHistorical>>[string]>));
  const candles = map[scripCode] ?? [];
  // Complete trading days strictly before today (candles are sorted ascending).
  const prior = candles.filter(c2 => c2.date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) < today);
  const lastClose  = prior.length ? prior[prior.length - 1].close : (candles[candles.length - 1]?.close ?? 0);
  const priorClose = prior.length > 1 ? prior[prior.length - 2].close : lastClose;
  const value = { lastClose, priorClose };
  c.prevClose[idx.key] = { date: today, value };
  return value;
}

export async function GET() {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const c = cache();
    const resolved = await Promise.all(INDICES.map(async idx => ({ idx, token: await resolveToken(idx, c) })));
    const live = resolved.filter((r): r is { idx: (typeof INDICES)[number]; token: number } => r.token != null);

    const scripCodes = live.map(r => `${r.idx.exchange}_${r.token}`);
    const ltpMap = await getLtp(scripCodes).catch(() => ({} as Record<string, number>));

    const indices = await Promise.all(live.map(async r => {
      const scripCode = `${r.idx.exchange}_${r.token}`;
      const ltp = ltpMap[scripCode] ?? 0;
      const { lastClose, priorClose } = await resolveCloses(r.idx, r.token, c).catch(() => ({ lastClose: 0, priorClose: 0 }));
      // Live: change is today's move (ltp vs the last close), % against
      // lastClose. No live price (market closed): fall back to the last real
      // move (lastClose vs the day before it), % against priorClose — each
      // case divides by its own "old" reference, not a flat/fake 0%.
      const base = ltp > 0 ? lastClose : priorClose;
      const ltpChange = ltp > 0 ? +(ltp - lastClose).toFixed(2) : +(lastClose - priorClose).toFixed(2);
      const pctChange = base > 0 ? +((ltpChange / base) * 100).toFixed(2) : 0;
      return { key: r.idx.key, ltp, prevClose: lastClose, ltpChange, pctChange };
    }));

    return NextResponse.json({ indices });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
