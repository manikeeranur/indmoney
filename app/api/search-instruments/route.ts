import { NextResponse } from "next/server";
import { searchEquities } from "@/lib/broker/instruments";
import { getLtp } from "@/lib/broker/marketdata";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// ─── Cross-segment instrument search (Watchlist tab) — full port of
// backend/src/services/kiteService.js's searchInstruments() score-matching
// (exact=100, symbol starts-with=50+, name starts-with=30, symbol
// contains=10, name contains=5), rebuilt against INDstocks' own equity
// instrument master instead of Kite's dump. ──────────────────────────────────
export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  try {
    const matches = await searchEquities(q, 15);
    const scripCodes = matches.map(m => `${m.exchange}_${m.token}`);
    const ltpMap = await getLtp(scripCodes).catch(() => ({} as Record<string, number>));

    const results = matches.map(m => ({
      token: m.token,
      tradingsymbol: m.tradingsymbol,
      name: m.name,
      exchange: m.exchange,
      type: "EQ" as const,
      ltp: ltpMap[`${m.exchange}_${m.token}`] ?? 0,
    }));
    return NextResponse.json({ results });
  } catch (err: any) {
    console.error("[Search] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
