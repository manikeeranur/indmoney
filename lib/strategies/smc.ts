// ─── SMC (Smart Money Concepts) strategy ──────────────────────────────────────
// Ported from backend/src/services/smcService.js. The pattern-detection math
// (detectLiqGrab, detectFVG, detectOB, detectBreaker, detectSMT, emaTrend) is
// pure candle arithmetic and is UNCHANGED — verified during the migration
// research that neither strategy reads Open Interest or anything Kite-specific,
// so only the I/O edges (candle fetch, option chain, auth check) needed to
// change for INDstocks.
import { hasToken } from "@/lib/broker/auth";
import { getOptionChain, getATM, scripCode, indexScripCode, getHistorical } from "@/lib/broker/marketdata";
import { getFnoInstruments, getLotSize, getUnderlyingScrip } from "@/lib/broker/instruments";
import {
  MIN_PREMIUM, MAX_PREMIUM, FALLBACK1_MIN, FALLBACK1_MAX, FALLBACK2_MIN, FALLBACK2_MAX,
  SWEET_SPOT, SMC_SL_PCT, SMC_TARGET1_PCT, SMC_TARGET_PCT, SMC_MAX_TRADES_PER_DAY,
  SMC_BREAKEVEN_TRIGGER_PCT,
} from "./constants";
import { checkPriceTouch } from "./priceTouch";
import type { Candle, Leg } from "@/lib/broker/types";
import type { AlertRecord, BacktestSummary, ScanResult } from "./types";

// NIFTY 50 index security id (see lib/broker/instruments.ts getUnderlyingScrip;
// 40000001 verified live against the INDstocks index master on 2026-09-25).
const NIFTY_INDEX_ID = 40000001;

// ─── Candle micro-helpers ─────────────────────────────────────────────────────
const cBody  = (c: Candle) => Math.abs(c.close - c.open);
const cRange = (c: Candle) => Math.max(c.high - c.low, 0.01);
const isBull = (c: Candle) => c.close > c.open;
const isBear = (c: Candle) => c.close < c.open;
const isStrong = (c: Candle, minPts = 8) =>
  cBody(c) >= minPts && (cBody(c) / cRange(c)) >= 0.35;

function ema(vals: number[], p: number): number[] {
  const k = 2 / (p + 1);
  const out: number[] = [];
  vals.forEach((v, i) => out.push(i === 0 ? v : +(out[i - 1] * (1 - k) + v * k)));
  return out;
}

type Sig = { bull: boolean; bear: boolean };

// 1. Liquidity Grab (Sweep + Rejection)
function detectLiqGrab(cs: Candle[]): Sig {
  if (cs.length < 12) return { bull: false, bear: false };
  const n  = cs.length;
  const c0 = cs[n - 1];
  const c1 = cs[n - 2];
  const lookback   = cs.slice(Math.max(0, n - 26), n - 3);
  const recentLow  = Math.min(...lookback.map(c => c.low));
  const recentHigh = Math.max(...lookback.map(c => c.high));
  return {
    bull: c1.low < recentLow - 1 && c0.close > recentLow && isBull(c0) && isStrong(c0, 5),
    bear: c1.high > recentHigh + 1 && c0.close < recentHigh && isBear(c0) && isStrong(c0, 5),
  };
}

// 2. Fair Value Gap
function detectFVG(cs: Candle[]): Sig {
  if (cs.length < 3) return { bull: false, bear: false };
  const n = cs.length;
  const a = cs[n - 3], b = cs[n - 2], c = cs[n - 1];
  return {
    bull: a.high < c.low && isBull(b) && isStrong(b, 15),
    bear: a.low  > c.high && isBear(b) && isStrong(b, 15),
  };
}

// 3. Order Block
function detectOB(cs: Candle[], spot: number): Sig {
  if (cs.length < 8) return { bull: false, bear: false };
  const look = cs.slice(Math.max(0, cs.length - 40));
  let bull = false, bear = false;
  for (let i = 0; i < look.length - 2; i++) {
    const a = look[i], b = look[i + 1], c2 = look[i + 2];
    if (isBear(a) && isStrong(a, 5) && isBull(b) && isStrong(b, 10) && isBull(c2)) {
      if (spot >= a.low - 30 && spot <= a.high + 40) bull = true;
    }
    if (isBull(a) && isStrong(a, 5) && isBear(b) && isStrong(b, 10) && isBear(c2)) {
      if (spot >= a.low - 40 && spot <= a.high + 30) bear = true;
    }
  }
  return { bull, bear };
}

// 4. Breaker Block
function detectBreaker(cs: Candle[], spot: number): Sig {
  if (cs.length < 18) return { bull: false, bear: false };
  const look = cs.slice(Math.max(0, cs.length - 60));
  let bull = false, bear = false;
  for (let i = 0; i < look.length - 4; i++) {
    const a = look[i], b = look[i + 1], c2 = look[i + 2];
    const later = look.slice(i + 3);
    if (isBear(a) && isStrong(a, 5) && isBull(b) && isStrong(b, 10) && isBull(c2)) {
      if (later.some(c => c.close > a.high + 5)) {
        if (spot >= a.low - 20 && spot <= a.high + 25) bull = true;
      }
    }
    if (isBull(a) && isStrong(a, 5) && isBear(b) && isStrong(b, 10) && isBear(c2)) {
      if (later.some(c => c.close < a.low - 5)) {
        if (spot >= a.low - 25 && spot <= a.high + 20) bear = true;
      }
    }
  }
  return { bull, bear };
}

// 5. Smart Money Trap / Market Structure Shift
function detectSMT(cs: Candle[]): Sig {
  if (cs.length < 10) return { bull: false, bear: false };
  const n  = cs.length;
  const c0 = cs[n - 1], c1 = cs[n - 2], c2 = cs[n - 3];
  const look = cs.slice(Math.max(0, n - 22), n - 3);
  const recentLow  = Math.min(...look.map(c => c.low));
  const recentHigh = Math.max(...look.map(c => c.high));
  return {
    bull: c1.low  < recentLow  - 2 && isBull(c0) && c0.close > c2.high && isStrong(c0, 12),
    bear: c1.high > recentHigh + 2 && isBear(c0) && c0.close < c2.low  && isStrong(c0, 12),
  };
}

function emaTrend(cs: Candle[]): Sig {
  if (cs.length < 5) return { bull: false, bear: false };
  const closes  = cs.map(c => c.close);
  const ema20   = ema(closes, 20);
  const last    = closes[closes.length - 1];
  const lastEMA = ema20[ema20.length - 1];
  const prevEMA = ema20[ema20.length - 3] ?? lastEMA;
  return { bull: last > lastEMA && lastEMA > prevEMA, bear: last < lastEMA && lastEMA < prevEMA };
}

type SideScore = { score: number; bonus: number; concepts: string[]; trendOk: boolean };

export function analyzeCandles(cs: Candle[], spot: number): { bull: SideScore; bear: SideScore } {
  const lg = detectLiqGrab(cs), fvg = detectFVG(cs), ob = detectOB(cs, spot);
  const bb = detectBreaker(cs, spot), smt = detectSMT(cs), trend = emaTrend(cs);

  function buildSide(key: "bull" | "bear"): SideScore {
    const list = [
      lg[key]  && "LiqGrab",
      fvg[key] && "FVG",
      ob[key]  && "OrdBlock",
      bb[key]  && "Breaker",
      smt[key] && "SMTrap",
    ].filter((x): x is string => !!x);
    return { score: list.length, bonus: trend[key] ? 1 : 0, concepts: list, trendOk: trend[key] };
  }
  return { bull: buildSide("bull"), bear: buildSide("bear") };
}

// ─── Find best option in LTP range ───────────────────────────────────────────
async function findBestLeg(direction: "CE" | "PE", expiry: string, spot: number): Promise<Leg | null> {
  const lotSize = await getLotSize("NIFTY").catch(() => 0);
  const chain = await getOptionChain(expiry, 15, "NIFTY", lotSize);
  const atm   = getATM(spot);
  const all   = chain.rows.map(r => direction === "CE" ? r.ce : r.pe);

  let candidates = all.filter(l => l.ltp >= MIN_PREMIUM && l.ltp <= MAX_PREMIUM);
  if (!candidates.length) candidates = all.filter(l => l.ltp >= FALLBACK1_MIN && l.ltp <= FALLBACK1_MAX);
  if (!candidates.length) candidates = all.filter(l => l.ltp >= FALLBACK2_MIN && l.ltp <= FALLBACK2_MAX);
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const da = Math.abs(a.strike - atm), db = Math.abs(b.strike - atm);
    if (Math.abs(da - db) > 50) return da - db;
    return Math.abs(a.ltp - SWEET_SPOT) - Math.abs(b.ltp - SWEET_SPOT);
  });
  return candidates[0];
}

// ─── Main live scan ───────────────────────────────────────────────────────────
export async function runSMCScan(expiry: string): Promise<ScanResult> {
  if (!hasToken()) throw new Error("Not authenticated");

  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
  if (h < 9 || (h === 9 && m < 21))
    return { signal: false, reason: `Too early (${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")} IST) — scan starts at 09:21` };
  if (h >= 15) return { signal: false, reason: "No new entries after 15:00 IST" };

  const from = new Date(now); from.setHours(9, 15, 0, 0);
  const code = indexScripCode(NIFTY_INDEX_ID, "NIFTY");
  const map  = await getHistorical([code], "1minute", from, now, "NIFTY");
  const rawCandles = map[code] ?? [];

  if (rawCandles.length < 10)
    return { signal: false, reason: "Insufficient candle data (<10 candles)" };

  const candles = rawCandles.slice(0, -1); // drop the still-forming candle
  const spot = candles[candles.length - 1].close;

  const { bull, bear } = analyzeCandles(candles, spot);
  const bullEff = bull.score + bull.bonus, bearEff = bear.score + bear.bonus;

  let dir: "CE" | "PE" | null = null, score = 0, effScore = 0, concepts: string[] = [], trendOk = false;
  if (bull.score >= 2 && bullEff >= bearEff) {
    dir = "CE"; score = bull.score; effScore = bullEff; concepts = bull.concepts; trendOk = bull.trendOk;
  } else if (bear.score >= 2 && bearEff > bullEff) {
    dir = "PE"; score = bear.score; effScore = bearEff; concepts = bear.concepts; trendOk = bear.trendOk;
  } else if (bull.score >= 2) {
    dir = "CE"; score = bull.score; effScore = bullEff; concepts = bull.concepts; trendOk = bull.trendOk;
  } else if (bear.score >= 2) {
    dir = "PE"; score = bear.score; effScore = bearEff; concepts = bear.concepts; trendOk = bear.trendOk;
  }

  if (!dir) return { signal: false, reason: `No confluence — bull:${bull.score} bear:${bear.score}` };

  const leg = await findBestLeg(dir, expiry, spot);
  if (!leg) return { signal: false, reason: `No options found in ₹${MIN_PREMIUM}–₹${MAX_PREMIUM} range` };

  const entry  = leg.ltp;
  const risk   = +(entry * (SMC_SL_PCT / 100)).toFixed(2);
  const reward = +(entry * (SMC_TARGET_PCT / 100)).toFixed(2);
  const rr = {
    entry,
    sl: +(entry - risk).toFixed(2),
    target1: +(entry * (1 + SMC_TARGET1_PCT / 100)).toFixed(2),
    target2: +(entry + reward).toFixed(2),
    risk, reward, riskPct: SMC_SL_PCT, rewardPct: SMC_TARGET_PCT,
  };

  const entryTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  const strength = effScore >= 5 ? "STRONG" : effScore >= 3 ? "GOOD" : "MODERATE";

  return {
    signal: true,
    id: `${dir}_${leg.strike}_${Date.now()}`,
    entryTime, direction: dir, strike: leg.strike,
    leg: { token: leg.token, tradingsymbol: leg.tradingsymbol, strike: leg.strike, type: leg.type, ltp: leg.ltp },
    rr, score, effScore, strength, trendOk, concepts,
    status: "ACTIVE", currentPnL: 0, pnlPct: 0, peakMove: 0,
    spot, expiry, createdAt: now.toISOString(),
  };
}

// ─── Update P&L for an existing alert ─────────────────────────────────────────
export function updateAlertPnL(alert: AlertRecord, currentLtp: number): AlertRecord {
  const pnl = +(currentLtp - alert.rr.entry).toFixed(2);
  const pct = +(pnl / alert.rr.entry * 100).toFixed(2);
  let status = alert.status;

  let t1Hit = alert.t1Hit || false;
  let t1HitTime = alert.t1HitTime || null;
  const peakMove = +(Math.max(alert.peakMove ?? 0, currentLtp - alert.rr.entry)).toFixed(2);

  const breakevenTriggerPct = alert.breakevenTriggerPct ?? SMC_BREAKEVEN_TRIGGER_PCT;
  let rr = alert.rr;
  let slMovedToBreakeven = alert.slMovedToBreakeven || false;
  let breakevenJustTriggered = false;
  if (alert.status === "ACTIVE" && !slMovedToBreakeven && peakMove > 0
      && (peakMove / alert.rr.entry) * 100 >= breakevenTriggerPct) {
    rr = { ...alert.rr, sl: alert.rr.entry };
    slMovedToBreakeven = true;
    breakevenJustTriggered = true;
  }

  if (alert.status === "ACTIVE") {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes();

    if (!t1Hit && rr.target1 != null && currentLtp >= rr.target1) {
      t1Hit = true;
      t1HitTime = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
    }

    const touch = checkPriceTouch(rr as any, currentLtp, "target2");
    if (h === 15 && m >= 20) status = "TIME_EXIT";
    else if (touch === "SL") status = "SL";
    else if (touch === "TARGET") status = "TARGET";
  }

  const justExited = status !== "ACTIVE" && alert.status === "ACTIVE";
  const exitNow = justExited ? new Date() : null;
  const exitTime = justExited
    ? exitNow!.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
    : alert.exitTime;
  const exitedAt = justExited ? exitNow!.toISOString() : alert.exitedAt;

  return { ...alert, rr, currentPnL: pnl, pnlPct: pct, status, t1Hit, t1HitTime, exitTime, exitedAt, lastLtp: currentLtp, peakMove, slMovedToBreakeven, breakevenJustTriggered };
}

// ─── IST helper ───────────────────────────────────────────────────────────────
function toIST(date: string | Date): { h: number; m: number } {
  const ms = (date instanceof Date ? date : new Date(date)).getTime();
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return { h: ist.getUTCHours(), m: ist.getUTCMinutes() };
}

// ─── Historical / Backtest scan ───────────────────────────────────────────────
export async function runHistoricalSMCScan(date: string, expiry: string): Promise<BacktestSummary> {
  if (!hasToken()) throw new Error("Not authenticated");

  const from = new Date(`${date}T09:15:00+05:30`);
  const to   = new Date(`${date}T15:30:00+05:30`);

  const code = indexScripCode(NIFTY_INDEX_ID, "NIFTY");
  const map  = await getHistorical([code], "1minute", from, to, "NIFTY");
  const niftyCandles = map[code] ?? [];
  if (niftyCandles.length < 10)
    throw new Error(`No NIFTY candle data for ${date}. Market may have been closed.`);

  const signals: any[] = [];
  const cooldown = new Map<string, number>();
  const COOLDOWN_MS = 3 * 60 * 1000;

  for (let i = 6; i < niftyCandles.length; i++) {
    const candle = niftyCandles[i];
    const { h, m } = toIST(candle.date);
    if (h < 9 || (h === 9 && m < 21)) continue;
    if (h >= 15) break;

    const slice = niftyCandles.slice(0, i + 1);
    const spot = candle.close;
    const { bull, bear } = analyzeCandles(slice, spot);

    let dir: "CE" | "PE" | null = null, score = 0, effScore = 0, concepts: string[] = [], trendOk = false;
    if (bull.score >= 2 && (bull.score + bull.bonus) >= (bear.score + bear.bonus)) {
      dir = "CE"; score = bull.score; effScore = bull.score + bull.bonus; concepts = bull.concepts; trendOk = bull.trendOk;
    } else if (bear.score >= 2) {
      dir = "PE"; score = bear.score; effScore = bear.score + bear.bonus; concepts = bear.concepts; trendOk = bear.trendOk;
    }
    if (!dir) continue;

    const atm = getATM(spot);
    const cdKey = `${dir}_${atm}`;
    const lastFire = cooldown.get(cdKey) ?? 0;
    const candleMs = new Date(candle.date).getTime();
    if (candleMs - lastFire < COOLDOWN_MS) continue;
    cooldown.set(cdKey, candleMs);

    signals.push({
      signalTime: candle.date,
      entryTime: `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`,
      direction: dir, atm, spot, score, effScore, concepts, trendOk,
      strength: effScore >= 5 ? "STRONG" : effScore >= 3 ? "GOOD" : "MODERATE",
    });
  }

  if (!signals.length) {
    return { results: [], date, expiry, totalSignals: 0, wins: 0, losses: 0, winRate: null, message: "No SMC signals found for this date" };
  }

  // Option instruments for the expiry — token lookup by strike+type
  const instruments = await getFnoInstruments();
  const tokenMap = new Map<string, number>();
  for (const inst of instruments) {
    if (inst.name !== "NIFTY" || inst.kind !== "OPTIDX" || inst.expiry !== expiry || inst.strike == null) continue;
    tokenMap.set(`${inst.strike}_${inst.type}`, inst.token);
  }

  const neededTokens = new Map<string, { token: number; strike: number; type: string }>();
  for (const sig of signals) {
    for (const offset of [0, -50, 50, -100, 100]) {
      const strike = sig.atm + offset;
      const key = `${strike}_${sig.direction}`;
      const token = tokenMap.get(key);
      if (token && !neededTokens.has(key)) neededTokens.set(key, { token, strike, type: sig.direction });
    }
  }

  const optCandlesMap = new Map<string, Candle[]>();
  const tokenList = [...neededTokens.entries()];
  const codes = tokenList.map(([, info]) => scripCode(info.token, "NIFTY"));
  const byCode = await getHistorical(codes, "1minute", from, to, "NIFTY");
  tokenList.forEach(([key, info]) => {
    optCandlesMap.set(key, byCode[scripCode(info.token, "NIFTY")] ?? []);
  });

  const results: AlertRecord[] = [];
  let openExitMs = 0;

  for (const sig of signals) {
    if (results.length >= SMC_MAX_TRADES_PER_DAY) break;
    const sigMs = new Date(sig.signalTime).getTime();
    if (sigMs <= openExitMs) continue;

    let chosenKey: string | null = null, entryCandle: Candle | null = null;
    for (const offset of [0, -50, 50, -100, 100]) {
      const strike = sig.atm + offset;
      const key = `${strike}_${sig.direction}`;
      const oc = optCandlesMap.get(key);
      if (!oc?.length) continue;
      const ec = oc.find(c => {
        const ct = new Date(c.date).getTime();
        return ct >= sigMs && ct <= sigMs + 2 * 60 * 1000;
      });
      if (!ec) continue;
      const entryPrice = ec.close || ec.open;
      if (entryPrice < 150 || entryPrice > 400) continue;
      chosenKey = key; entryCandle = ec; sig.strike = strike;
      break;
    }
    if (!chosenKey || !entryCandle) continue;

    const entry = entryCandle.close || entryCandle.open;
    const risk = +(entry * (SMC_SL_PCT / 100)).toFixed(2);
    const reward = +(entry * (SMC_TARGET_PCT / 100)).toFixed(2);
    const rr = {
      entry, sl: +(entry - risk).toFixed(2),
      target1: +(entry * (1 + SMC_TARGET1_PCT / 100)).toFixed(2),
      target2: +(entry + reward).toFixed(2),
      risk, reward, riskPct: SMC_SL_PCT, rewardPct: SMC_TARGET_PCT,
    };

    const oc = optCandlesMap.get(chosenKey)!;
    const entryMs = new Date(entryCandle.date).getTime();
    const laterCandles = oc.filter(c => new Date(c.date).getTime() > entryMs);

    let status: AlertRecord["status"] = "ACTIVE", exitPrice = entry, exitTime: string | Date | null = null;
    let t1Hit = false, t1HitTime: string | null = null, peakMove = 0;
    for (const c of laterCandles) {
      const { h: ch, m: cm } = toIST(c.date);
      const move = +(c.high - entry).toFixed(2);
      if (move > peakMove) peakMove = move;
      if (!t1Hit && c.high >= rr.target1) { t1Hit = true; t1HitTime = `${String(ch).padStart(2,"0")}:${String(cm).padStart(2,"0")}`; }
      if (c.low <= rr.sl)  { status = "SL";        exitPrice = rr.sl;      exitTime = c.date; break; }
      if (c.high >= rr.target2) { status = "TARGET"; exitPrice = rr.target2; exitTime = c.date; break; }
      if (ch === 15 && cm >= 20) { status = "TIME_EXIT"; exitPrice = c.close; exitTime = c.date; break; }
    }
    if (status === "ACTIVE" && laterCandles.length) {
      exitPrice = laterCandles[laterCandles.length - 1].close;
      status = "EOD";
      exitTime = laterCandles[laterCandles.length - 1].date;
    }
    openExitMs = exitTime ? new Date(exitTime).getTime() : to.getTime();

    const pnl = +(exitPrice - entry).toFixed(2);
    const pct = +(pnl / entry * 100).toFixed(2);
    const exitT = exitTime
      ? new Date(exitTime).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
      : null;

    results.push({
      id: `hist_${sig.direction}_${sig.strike}_${sig.entryTime}`,
      entryTime: sig.entryTime, exitTime: exitT, direction: sig.direction, strike: sig.strike,
      leg: { token: neededTokens.get(chosenKey)!.token, tradingsymbol: "", strike: sig.strike, type: sig.direction, ltp: exitPrice },
      rr, score: sig.score, effScore: sig.effScore, strength: sig.strength, trendOk: sig.trendOk, concepts: sig.concepts,
      status, t1Hit, t1HitTime, currentPnL: pnl, pnlPct: pct, peakMove,
      spot: sig.spot, expiry, createdAt: sig.signalTime, isHistorical: true, date,
    });
  }

  // A profitable TIME_EXIT is a win too — matches the convention used
  // everywhere else this figure is shown (StrategyTableView, results/journal
  // pages, the live status stat). Without it, backtest win rate understates
  // itself the same way the live one used to.
  const wins = results.filter(r => r.status === "TARGET" || (r.status === "TIME_EXIT" && (r.currentPnL ?? 0) >= 0)).length;
  const eodCount = results.filter(r => r.status === "EOD").length;
  const closed = results.filter(r => r.status !== "ACTIVE").length;

  return {
    results, date, expiry, totalSignals: results.length, wins,
    losses: results.filter(r => r.status === "SL").length,
    eod: eodCount,
    winRate: closed > 0 ? +((wins / closed) * 100).toFixed(1) : null,
  };
}
