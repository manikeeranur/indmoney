// ─── Market data ──────────────────────────────────────────────────────────────
// Option chain, quotes and historical candles, mapped into the broker-neutral
// shapes in ./types so the ported strategies need no changes.
//
// Three INDstocks facts shape this file:
//
//  1. The option-chain endpoint returns iv AND greeks. The old app solved IV
//     with Newton-Raphson and computed Black-Scholes greeks for ~30 legs on
//     every 2-second refresh. All of that is deleted — the broker is the source.
//
//  2. Historical candles carry NO open interest, and request/response use
//     different time units (ms in, seconds out). OI for the EOD report is
//     captured live from the price WebSocket instead (see oiSnapshot).
//
//  3. Live and EXPIRED contracts use different endpoints with different
//     identifiers: live takes up to 5 `scrip-codes`, expired takes up to 50
//     `trading-symbols`. Kite hid this distinction; backtests must not.

import { request } from "./client";
import { getUnderlyingScrip } from "./instruments";
import type { Candle, ChainRow, Index, Leg, OptionChain, OptionType } from "./types";

// Max instruments per historical request, per the docs.
const LIVE_BATCH    = 5;
const EXPIRED_BATCH = 50;

/** Max span per historical request, by interval family (docs). */
function maxRangeDays(interval: string): number {
  if (/^\d+minute$/.test(interval)) {
    const mins = Number(interval.replace("minute", ""));
    return mins >= 60 ? 15 : 7;
  }
  return 365; // 1day / 1week / 1month
}

function exchangeFor(index: Index): "NSE" | "BSE" {
  return index === "SENSEX" ? "BSE" : "NSE";
}

function segmentFor(index: Index): "NFO" | "BFO" {
  return index === "SENSEX" ? "BFO" : "NFO";
}

/** Historical identifier for a live OPTION contract: "<F&O SEGMENT>_<security_id>",
 *  e.g. "NFO_73899". Verified live: requesting an option's historical candles
 *  with the "NSE_" prefix silently returns `candles: null` for every single
 *  strike, with no error — a request that looks identical to a working one
 *  and produces empty data everywhere it's used (SMC/VWAP930 backtests, the
 *  EOD OHLC report, the OHLC tab's CSV download). Options trade on NFO/BFO,
 *  not the cash segment; only the underlying INDEX itself uses NSE/BSE — see
 *  indexScripCode() for that case. */
export function scripCode(token: number, index: Index = "NIFTY"): string {
  return `${segmentFor(index)}_${token}`;
}

/** Historical identifier for the underlying INDEX (e.g. NIFTY 50 itself),
 *  which — unlike its options — trades on the cash segment: "NSE_40000001". */
export function indexScripCode(token: number, index: Index = "NIFTY"): string {
  return `${exchangeFor(index)}_${token}`;
}

// ─── Option chain ─────────────────────────────────────────────────────────────

type RawLeg = {
  security_id?: string;
  trading_symbol?: string;
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  iv?: number;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
};

type RawChain = {
  underlying_ltp: number;
  expiry: string;
  strikes: Record<string, { ce?: RawLeg; pe?: RawLeg }>;
};

function toLeg(raw: RawLeg | undefined, strike: number, type: OptionType, lotSize: number): Leg | null {
  if (!raw || raw.security_id === undefined) return null;
  const ltp     = Number(raw.last_price ?? 0) || 0.05;
  const prevLtp = Number(raw.previous_close_price ?? ltp);
  const oi      = Number(raw.oi ?? 0);
  const prevOi  = Number(raw.previous_oi ?? oi);
  return {
    token:         Number(raw.security_id),
    tradingsymbol: raw.trading_symbol ?? "",
    strike,
    type,
    ltp,
    prevLtp,
    ltpChange: +(ltp - prevLtp).toFixed(2),
    oi,
    oiChange:  oi - prevOi,
    volume:    Number(raw.volume ?? 0),
    iv:        Number(raw.iv ?? 0),
    delta:     Number(raw.greeks?.delta ?? 0),
    gamma:     Number(raw.greeks?.gamma ?? 0),
    theta:     Number(raw.greeks?.theta ?? 0),
    vega:      Number(raw.greeks?.vega ?? 0),
    // Synthesise a spread only when the book is genuinely empty, as the old app did.
    bid: Number(raw.top_bid_price ?? 0) || +(ltp * 0.996).toFixed(2),
    ask: Number(raw.top_ask_price ?? 0) || +(ltp * 1.004).toFixed(2),
    lotSize,
  };
}

export function getATM(spot: number, step = 50): number {
  return Math.round(spot / step) * step;
}

function daysToExpiry(expiry: string): number {
  const exp = new Date(`${expiry}T15:30:00+05:30`);
  return Math.max((exp.getTime() - Date.now()) / 86_400_000, 0);
}

export async function getOptionChain(
  expiry: string,
  strikeCount = 15,
  index: Index = "NIFTY",
  lotSize = 0,
): Promise<OptionChain> {
  const scrip = await getUnderlyingScrip(index);

  const raw = await request<RawChain>("/market/option-chain", {
    query: {
      exchange: exchangeFor(index),
      segment: "INDEX",
      "underlying-scrip": scrip,
      expiry,
      strike_count: strikeCount,
    },
  });

  const spot = Number(raw.underlying_ltp ?? 0);
  const step = index === "SENSEX" ? 100 : 50;
  const atm  = getATM(spot, step);

  const rows: ChainRow[] = [];
  for (const [strikeKey, pair] of Object.entries(raw.strikes ?? {})) {
    const strike = Number(strikeKey);
    const ce = toLeg(pair.ce, strike, "CE", lotSize);
    const pe = toLeg(pair.pe, strike, "PE", lotSize);
    // Keep only strikes with both sides, exactly as the old chain builder did.
    if (!ce || !pe) continue;
    rows.push({ strike, isATM: strike === atm, ce, pe, ceOIBar: 0, peOIBar: 0 });
  }
  rows.sort((a, b) => a.strike - b.strike);

  if (!rows.length) {
    throw new Error(`No complete CE+PE pairs found for ${index} expiry ${expiry}`);
  }

  // OI bars, PCR and max pain — ported from the old optionChainService.
  const maxOI = Math.max(...rows.flatMap((r) => [r.ce.oi, r.pe.oi]), 1);
  for (const r of rows) {
    r.ceOIBar = Math.round((r.ce.oi / maxOI) * 100);
    r.peOIBar = Math.round((r.pe.oi / maxOI) * 100);
  }

  const totalCEOI  = rows.reduce((s, r) => s + r.ce.oi, 0);
  const totalPEOI  = rows.reduce((s, r) => s + r.pe.oi, 0);
  const totalCEVol = rows.reduce((s, r) => s + r.ce.volume, 0);
  const totalPEVol = rows.reduce((s, r) => s + r.pe.volume, 0);

  let minLoss = Infinity;
  let maxPain = rows[0].strike;
  for (const { strike: exp } of rows) {
    let loss = 0;
    for (const { strike: s, ce, pe } of rows) {
      if (exp > s) loss += (exp - s) * ce.oi;
      if (exp < s) loss += (s - exp) * pe.oi;
    }
    if (loss < minLoss) { minLoss = loss; maxPain = exp; }
  }

  const atmRow = rows.find((r) => r.isATM) ?? rows[Math.floor(rows.length / 2)];

  return {
    spot,
    expiry,
    atm,
    daysToExpiry: +daysToExpiry(expiry).toFixed(2),
    rows,
    pcr:       totalCEVol > 0 ? +(totalPEVol / totalCEVol).toFixed(2) : 0,
    pcrOI:     totalCEOI  > 0 ? +(totalPEOI  / totalCEOI).toFixed(2)  : 0,
    maxPain,
    totalCEOI,
    totalPEOI,
    atmIV:     +(((atmRow.ce.iv + atmRow.pe.iv) / 2) || 0).toFixed(2),
    updatedAt: new Date().toISOString(),
  };
}

// ─── Quotes ───────────────────────────────────────────────────────────────────

// Verified against https://api-docs.indstocks.com/MarketQuote/: the response
// field is `live_price`, not `ltp`/`last_price` — this function returned an
// empty map for every caller until checked here (it had no caller yet, so
// nothing had exercised it live before the Watchlist tab's index ticker).
export async function getLtp(scripCodes: string[]): Promise<Record<string, number>> {
  if (!scripCodes.length) return {};
  const out: Record<string, number> = {};
  // Chunked to keep URLs sane; the WebSocket carries the realtime load.
  for (let i = 0; i < scripCodes.length; i += 50) {
    const chunk = scripCodes.slice(i, i + 50);
    const data  = await request<Record<string, { live_price?: number; ltp?: number; last_price?: number }>>(
      "/market/quotes/ltp",
      { query: { "scrip-codes": chunk.join(",") } },
    );
    for (const [k, v] of Object.entries(data ?? {})) {
      out[k] = Number(v?.live_price ?? v?.ltp ?? v?.last_price ?? 0);
    }
  }
  return out;
}

// ─── Historical candles ───────────────────────────────────────────────────────

type RawCandle = { ts: number; o: number; h: number; l: number; c: number; v: number };
type RawHistorical = Record<string, { candles?: RawCandle[] }>;

function toCandles(raw: RawCandle[] | undefined): Candle[] {
  if (!raw?.length) return [];
  return raw.map((c) => ({
    // `ts` is epoch SECONDS (requests use milliseconds — an easy bug, hence this comment).
    date:   new Date(c.ts * 1000),
    open:   c.o,
    high:   c.h,
    low:    c.l,
    close:  c.c,
    volume: c.v,
    oi:     null, // never present in INDstocks historical candles
  }));
}

/**
 * Minute (or other interval) candles for one or more LIVE contracts.
 * Returns a map keyed by the scrip code you passed in.
 *
 * Batches by 5 (API limit) and splits the window by the interval's max range,
 * so callers can ask for any span without knowing the limits.
 */
export async function getHistorical(
  scripCodes: string[],
  interval: string,
  from: Date,
  to: Date,
  index: Index = "NIFTY",
  /** Overrides segmentFor(index) — needed for the underlying INDEX itself
   *  (segment "INDEX"), which trades on neither NFO nor BFO. */
  segmentOverride?: "NFO" | "BFO" | "EQUITY",
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  if (!scripCodes.length) return out;

  const windows = splitWindow(from, to, maxRangeDays(interval));

  for (let i = 0; i < scripCodes.length; i += LIVE_BATCH) {
    const batch = scripCodes.slice(i, i + LIVE_BATCH);
    for (const w of windows) {
      const data = await request<RawHistorical>(`/market/historical/${interval}`, {
        query: {
          "scrip-codes": batch.join(","),
          start_time: w.from.getTime(),
          end_time:   w.to.getTime(),
          segment:    segmentOverride ?? segmentFor(index),
        },
      }).catch((err) => {
        console.warn(`[MarketData] historical ${interval} ${batch.join(",")} failed: ${err.message}`);
        return {} as RawHistorical;
      });

      for (const [key, val] of Object.entries(data ?? {})) {
        (out[key] ??= []).push(...toCandles(val?.candles));
      }
    }
  }

  // Windows are fetched in order, but de-duplicate defensively on the boundary.
  for (const key of Object.keys(out)) {
    const seen = new Set<number>();
    out[key] = out[key]
      .filter((c) => {
        const t = c.date.getTime();
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }
  return out;
}

/** Candles for EXPIRED F&O contracts — a different endpoint keyed by trading
 *  symbol, up to 50 at a time. Backtests over past expiries must use this. */
export async function getHistoricalExpired(
  tradingSymbols: string[],
  interval: string,
  from: Date,
  to: Date,
  index: Index = "NIFTY",
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  if (!tradingSymbols.length) return out;

  const windows = splitWindow(from, to, maxRangeDays(interval));

  for (let i = 0; i < tradingSymbols.length; i += EXPIRED_BATCH) {
    const batch = tradingSymbols.slice(i, i + EXPIRED_BATCH);
    for (const w of windows) {
      const data = await request<RawHistorical>(`/market/historical/expired/${interval}`, {
        query: {
          "trading-symbols": batch.join(","),
          start_time: w.from.getTime(),
          end_time:   w.to.getTime(),
          segment:    segmentFor(index),
        },
      }).catch((err) => {
        console.warn(`[MarketData] expired historical failed: ${err.message}`);
        return {} as RawHistorical;
      });
      for (const [key, val] of Object.entries(data ?? {})) {
        (out[key] ??= []).push(...toCandles(val?.candles));
      }
    }
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => a.date.getTime() - b.date.getTime());
  }
  return out;
}

/** Split [from, to] into chunks no longer than maxDays. */
function splitWindow(from: Date, to: Date, maxDays: number): { from: Date; to: Date }[] {
  const span = maxDays * 86_400_000;
  const out: { from: Date; to: Date }[] = [];
  let cursor = from.getTime();
  const end  = to.getTime();
  while (cursor < end) {
    const chunkEnd = Math.min(cursor + span, end);
    out.push({ from: new Date(cursor), to: new Date(chunkEnd) });
    cursor = chunkEnd;
  }
  return out.length ? out : [{ from, to }];
}

/** Convenience for the strategies: one instrument, one trading day, 1-minute. */
export async function getSessionCandles(
  token: number,
  date: Date,
  index: Index = "NIFTY",
  interval = "1minute",
): Promise<Candle[]> {
  const day  = date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const from = new Date(`${day}T09:15:00+05:30`);
  const to   = new Date(`${day}T15:30:00+05:30`);
  const code = scripCode(token, index);
  const res  = await getHistorical([code], interval, from, to, index);
  return res[code] ?? [];
}
