import { NextResponse } from "next/server";
import { getHistorical, getHistoricalExpired, scripCode } from "@/lib/broker/marketdata";
import { calcRollingRSI, fmtIST } from "@/lib/telegram/candleCsv";
import { calcEMA, calcBB, calcMACD } from "@/lib/telegram/indicators";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// GET /api/candles?token=&date=&interval=minute    (single day)
// GET /api/candles?token=&from=&to=&interval=       (range — chart timeframes)
// GET /api/candles?token=&date=&expired=true         (past-expiry contract)
// GET /api/candles?...&skipIndicators=true            (chart re-fetch, indicators unchanged)
// Mirrors backend/src/routes/optionChain.js's /candles endpoint response shape
// (rows[].{date,open,high,low,close,volume,oi,rsi14,ema9,ema21,bbMid,bbUp,bbDn,
// macd,macdSig,macdHist}), so both the OHLC tab's download and the chart panel
// need no changes on top of this route.
//
// Old app's `interval` values map straight onto INDstocks' except "minute"
// and "day", which INDstocks calls "1minute" and "1day" — confirmed against
// https://api-docs.indstocks.com/historicalData/ (valid values: 1minute,
// 2minute, 3minute, 4minute, 5minute, 10minute, 15minute, 30minute, 60minute,
// 120minute, 180minute, 240minute, 1day, 1week, 1month). Sending "day" isn't
// rejected with an error — it silently returns `rows: []`, which is exactly
// the "wrong segment silently returns nothing" failure class this file's own
// header comment already warns about, just for interval instead of segment.
// This bit every 1D/1W chart timeframe (ChartPanel's TF_LIST) until found.
function normaliseInterval(iv: string): string {
  if (iv === "minute") return "1minute";
  if (iv === "day") return "1day";
  return iv;
}

export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const token = Number(searchParams.get("token"));
  const date = searchParams.get("date");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const rawInterval = searchParams.get("interval") ?? "1minute";
  const interval = normaliseInterval(rawInterval);
  const expired = searchParams.get("expired") === "true";
  const tradingsymbol = searchParams.get("tradingsymbol"); // required for expired contracts
  const skipIndicators = searchParams.get("skipIndicators") === "true";
  const index = searchParams.get("index") === "SENSEX" ? "SENSEX" : "NIFTY";

  // An expired-contract request identifies the option by tradingsymbol, not
  // token — ChartPanel's expired-branch fetch never sends a token param, so
  // requiring it unconditionally here rejected every expired-chart request
  // outright, before ever reaching the expired/tradingsymbol branch below.
  if ((!expired && !token) || (expired && !tradingsymbol) || (!date && !fromParam)) {
    return NextResponse.json({ error: expired ? "tradingsymbol and date (or from/to) are required" : "token and date (or from/to) are required" }, { status: 400 });
  }

  try {
    // Computed from the RAW param, not the normalised one — normaliseInterval
    // turns "day" into "1day", which would make this always false otherwise.
    const dayInterval = rawInterval === "day" || rawInterval === "1day";
    const from = dayInterval
      ? new Date(`${fromParam || date}T00:00:00+05:30`)
      : new Date(`${fromParam || date}T09:15:00+05:30`);
    const to = dayInterval
      ? new Date(`${toParam || date}T23:59:59+05:30`)
      : new Date(`${toParam || date}T15:30:00+05:30`);

    let candles;
    if (expired) {
      if (!tradingsymbol) return NextResponse.json({ error: "tradingsymbol is required for expired contracts" }, { status: 400 });
      const map = await getHistoricalExpired([tradingsymbol], interval, from, to, index);
      candles = map[tradingsymbol] ?? [];
    } else {
      const code = scripCode(token, index);
      const map = await getHistorical([code], interval, from, to, index);
      candles = map[code] ?? [];
    }

    const closes = candles.map(c => c.close);
    const rsiArr   = skipIndicators ? [] : calcRollingRSI(closes, 14);
    const ema9arr  = skipIndicators ? [] : calcEMA(closes, 9);
    const ema21arr = skipIndicators ? [] : calcEMA(closes, 21);
    const bbArr    = skipIndicators ? [] : calcBB(closes, 20, 2);
    const macdArr  = skipIndicators ? [] : calcMACD(closes);

    const rows = candles.map((c, i) => ({
      date: fmtIST(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume, oi: c.oi ?? null,
      ...(skipIndicators ? {} : {
        rsi14: rsiArr[i], ema9: ema9arr[i], ema21: ema21arr[i],
        bbMid: bbArr[i]?.mid, bbUp: bbArr[i]?.up, bbDn: bbArr[i]?.dn,
        macd: macdArr[i]?.macd, macdSig: macdArr[i]?.sig, macdHist: macdArr[i]?.hist,
      }),
    }));
    return NextResponse.json({ rows });
  } catch (err: any) {
    console.error("[Candles] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
