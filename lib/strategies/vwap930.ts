// ─── VWAP 9:30 strategy ─────────────────────────────────────────────────────────
// Ported from backend/src/services/vwap930Service.js. Same finding as SMC: the
// VWAP/candle math is pure and unchanged; only candle fetch, option chain and
// auth calls move to the INDstocks adapter.
import { hasToken } from "@/lib/broker/auth";
import { getOptionChain, getATM, scripCode, indexScripCode, getHistorical, getHistoricalExpired, expiredOptionSymbol } from "@/lib/broker/marketdata";
import { getFnoInstruments, getLotSize } from "@/lib/broker/instruments";
import { calcVWAP, aggregateCandles } from "./vwap";
import {
  VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM, VWAP930_SL_PCT, VWAP930_TARGET_PCT,
  VWAP930_CANDLE_MINUTES, VWAP930_ENTRY_START_HOUR, VWAP930_ENTRY_START_MINUTE,
  VWAP930_MAX_TRADES_PER_DAY, VWAP930_STAGNANT_HOURS, VWAP930_STAGNANT_MAX_POINTS,
  VWAP930_REENTRY_COOLDOWN_MIN, VWAP930_BREAKEVEN_TRIGGER_PCT,
} from "./constants";
import { checkPriceTouch } from "./priceTouch";
import type { Candle, Leg } from "@/lib/broker/types";
import type { AlertRecord, BacktestSummary, EntryReason, EntryReasonSide } from "./types";

const NIFTY_INDEX_ID = 40000001; // verified live 2026-09-25 — see smc.ts

export function entryStartStr(): string {
  return `${String(VWAP930_ENTRY_START_HOUR).padStart(2, "0")}:${String(VWAP930_ENTRY_START_MINUTE).padStart(2, "0")}`;
}

export function isAfterEntryStart(h: number, m: number): boolean {
  return h > VWAP930_ENTRY_START_HOUR || (h === VWAP930_ENTRY_START_HOUR && m >= VWAP930_ENTRY_START_MINUTE);
}

export function buildRR(entry: number) {
  const risk = +(entry * (VWAP930_SL_PCT / 100)).toFixed(2);
  const reward = +(entry * (VWAP930_TARGET_PCT / 100)).toFixed(2);
  return {
    entry, sl: +(entry - risk).toFixed(2), target: +(entry + reward).toFixed(2),
    risk, reward, riskPct: VWAP930_SL_PCT, rewardPct: VWAP930_TARGET_PCT,
  };
}

async function findCandidateLegs(expiry: string) {
  const lotSize = await getLotSize("NIFTY").catch(() => 0);
  const chain = await getOptionChain(expiry, 15, "NIFTY", lotSize);
  const atm = getATM(chain.spot);

  function inBandSorted(side: "CE" | "PE") {
    const all = chain.rows.map(r => side === "CE" ? r.ce : r.pe);
    const inBand = all.filter(l => l.ltp >= VWAP930_MIN_PREMIUM && l.ltp <= VWAP930_MAX_PREMIUM);
    inBand.sort((a, b) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm));
    return { inBand, outOfBand: all.length - inBand.length };
  }
  const ceBand = inBandSorted("CE"), peBand = inBandSorted("PE");
  return { ce: ceBand.inBand[0] ?? null, pe: peBand.inBand[0] ?? null, ceBand, peBand, spot: chain.spot, atm };
}

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/** "09:20–09:25" for an N-min candle whose `date` is its LAST 1-min candle's start. */
function candleWindow(c: Candle): string {
  const lastStart = new Date(c.date).getTime();
  return `${hhmm(lastStart - (VWAP930_CANDLE_MINUTES - 1) * 60_000)}–${hhmm(lastStart + 60_000)}`;
}

function reasonSide(checked: { strike: number; premium: number }[], outOfBand: number,
                    picked: { strike: number; premium: number; close: number; vwap: number } | null): EntryReasonSide {
  return { checked, outOfBand, picked: picked ? { ...picked, aboveVwap: picked.close > picked.vwap } : null };
}

function buildSummary(dir: "CE" | "PE", ce: EntryReasonSide, pe: EntryReasonSide): string {
  const win = dir === "CE" ? ce.picked! : pe.picked!;
  const other = dir === "CE" ? pe.picked : ce.picked;
  const otherSide = dir === "CE" ? "PE" : "CE";
  const gap = +(win.close - win.vwap).toFixed(2);
  let why = `${dir} ${win.strike} closed ₹${win.close.toFixed(2)} above VWAP ₹${win.vwap.toFixed(2)} (+${gap})`;
  if (!other) why += ` · no ${otherSide} in band`;
  else if (!other.aboveVwap) why += ` · ${otherSide} ${other.strike} closed ₹${other.close.toFixed(2)} below VWAP ₹${other.vwap.toFixed(2)}`;
  else why += ` · ${otherSide} ${other.strike} also above VWAP but by less (+${(other.close - other.vwap).toFixed(2)})`;
  return why;
}

function toIST(date: string | Date): { h: number; m: number } {
  const ms = (date instanceof Date ? date : new Date(date)).getTime();
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return { h: ist.getUTCHours(), m: ist.getUTCMinutes() };
}

type LegState = { vwap: number; close: number; candle: Candle };

async function getLegNMinState(token: number, from: Date, now: Date): Promise<LegState | null> {
  const code = scripCode(token, "NIFTY");
  const map  = await getHistorical([code], "1minute", from, now, "NIFTY");
  const raw  = map[code] ?? [];
  if (raw.length < 2) return null;
  const completed = raw.slice(0, -1);
  const candlesNm = aggregateCandles(completed, VWAP930_CANDLE_MINUTES);
  if (!candlesNm.length) return null;
  const vwapSeries = calcVWAP(candlesNm);
  const candle = candlesNm[candlesNm.length - 1];
  return { vwap: vwapSeries[vwapSeries.length - 1], close: candle.close, candle };
}

function decideDirection(
  ce: Leg | null, pe: Leg | null, stateCE: LegState | null, statePE: LegState | null,
): { direction: "CE" | "PE"; leg: Leg; vwap: number } | null {
  const ceQualifies = !!ce && !!stateCE && stateCE.close > stateCE.vwap;
  const peQualifies = !!pe && !!statePE && statePE.close > statePE.vwap;
  if (!ceQualifies && !peQualifies) return null;

  if (ceQualifies && peQualifies) {
    const ceDist = stateCE!.close - stateCE!.vwap;
    const peDist = statePE!.close - statePE!.vwap;
    return ceDist >= peDist
      ? { direction: "CE", leg: ce!, vwap: stateCE!.vwap }
      : { direction: "PE", leg: pe!, vwap: statePE!.vwap };
  }
  return ceQualifies
    ? { direction: "CE", leg: ce!, vwap: stateCE!.vwap }
    : { direction: "PE", leg: pe!, vwap: statePE!.vwap };
}

// ─── Main live scan ───────────────────────────────────────────────────────────
export async function runVWAP930Scan(expiry: string): Promise<any> {
  if (!hasToken()) throw new Error("Not authenticated");

  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
  const entryTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  if (!isAfterEntryStart(h, m)) {
    return { signal: false, reason: `No entries before ${entryStartStr()} IST (now ${entryTime})` };
  }
  // Decide only in the minute a 5-min candle has just closed (09:20, 09:25, …),
  // exactly like the backtest's checkpoints. The scanner runs every minute, so
  // without this a re-entry right after the cooldown (e.g. 09:49) was judged on
  // a candle that closed minutes earlier (09:40–09:45) and filled at a live
  // price that had already fallen back below VWAP.
  if (m % VWAP930_CANDLE_MINUTES !== 0) {
    return { signal: false, reason: `Waiting for the next ${VWAP930_CANDLE_MINUTES}-min candle close (now ${entryTime})` };
  }

  const { ce, pe, ceBand, peBand, spot, atm } = await findCandidateLegs(expiry);
  if (!ce && !pe) {
    return { signal: false, reason: `No CE/PE in ₹${VWAP930_MIN_PREMIUM}–₹${VWAP930_MAX_PREMIUM} band`, spot };
  }

  const from = new Date(now); from.setHours(9, 15, 0, 0);
  const [stateCE, statePE] = await Promise.all([
    ce ? getLegNMinState(ce.token, from, now) : Promise.resolve(null),
    pe ? getLegNMinState(pe.token, from, now) : Promise.resolve(null),
  ]);

  // A side whose latest completed candle is not the one that just closed
  // (historical feed lagging) is treated as not ready rather than judged on
  // stale data.
  const justClosedStart = Math.floor(now.getTime() / 60_000) * 60_000 - 60_000;
  const fresh = (st: LegState | null) => st && new Date(st.candle.date).getTime() >= justClosedStart ? st : null;
  const decision = decideDirection(ce, pe, fresh(stateCE), fresh(statePE));
  if (!decision) {
    return {
      signal: false,
      reason: `Neither CE nor PE has a ${VWAP930_CANDLE_MINUTES}-min candle closed above its VWAP at ${entryTime}`,
      spot,
    };
  }

  const { direction: dir, leg, vwap } = decision;
  const rr = buildRR(leg.ltp);

  const toChecked = (legs: Leg[]) => legs.map(l => ({ strike: l.strike, premium: l.ltp }));
  const sideCE = reasonSide(toChecked(ceBand.inBand), ceBand.outOfBand,
    ce && stateCE ? { strike: ce.strike, premium: ce.ltp, close: stateCE.close, vwap: stateCE.vwap } : null);
  const sidePE = reasonSide(toChecked(peBand.inBand), peBand.outOfBand,
    pe && statePE ? { strike: pe.strike, premium: pe.ltp, close: statePE.close, vwap: statePE.vwap } : null);
  const decidedOn = (dir === "CE" ? stateCE : statePE)!.candle;
  const entryReason: EntryReason = {
    candleTime: candleWindow(decidedOn), band: [VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM], atm,
    ce: sideCE, pe: sidePE, chosen: dir, summary: buildSummary(dir, sideCE, sidePE),
  };

  return {
    signal: true,
    id: `VWAP930_${dir}_${leg.strike}_${Date.now()}`,
    entryTime, direction: dir, strike: leg.strike,
    leg: { token: leg.token, tradingsymbol: leg.tradingsymbol, strike: leg.strike, type: leg.type, ltp: leg.ltp },
    rr, vwap, vwapCE: stateCE?.vwap ?? null, vwapPE: statePE?.vwap ?? null, entryReason,
    status: "ACTIVE", currentPnL: 0, pnlPct: 0, peakMove: 0,
    spot, expiry, createdAt: now.toISOString(),
  };
}

// ─── Rebuild the entry reason for an alert saved without one ───────────────────
/** Replays the live scan's decision at the alert's own entry moment from 1-min
 *  candles: same ±15-strike chain window around ATM, same premium band, same
 *  closest-to-ATM pick per side, same completed 5-min candle vs VWAP. Premiums
 *  for non-entered strikes are the last completed 1-min close (live used the
 *  chain LTP a few seconds later), so they can differ by a few paise. */
export async function rebuildEntryReason(alert: AlertRecord): Promise<EntryReason | null> {
  if (!alert.createdAt || !alert.spot || !alert.expiry) return null;
  const entryAt = new Date(alert.createdAt);
  const minuteStart = Math.floor(entryAt.getTime() / 60_000) * 60_000;
  const date = entryAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const from = new Date(`${date}T09:15:00+05:30`);
  const atm = getATM(alert.spot);

  const legs: { strike: number; type: "CE" | "PE"; token: number }[] = [];
  for (const inst of await getFnoInstruments()) {
    if (inst.name !== "NIFTY" || inst.kind !== "OPTIDX" || inst.expiry !== alert.expiry || inst.strike == null) continue;
    if (inst.type !== "CE" && inst.type !== "PE") continue;
    if (Math.abs(inst.strike - atm) > 15 * 50) continue;
    legs.push({ strike: inst.strike, type: inst.type, token: inst.token });
  }
  if (!legs.length) return null;

  const codes = legs.map(l => scripCode(l.token, "NIFTY"));
  const map = await getHistorical(codes, "1minute", from, new Date(minuteStart), "NIFTY");

  function side(type: "CE" | "PE"): EntryReasonSide {
    const rows = legs.filter(l => l.type === type).map(l => {
      const completed = (map[scripCode(l.token, "NIFTY")] ?? []).filter(c => new Date(c.date).getTime() < minuteStart);
      const isEntered = type === alert.direction && l.strike === alert.strike;
      const premium = isEntered ? alert.rr.entry : completed[completed.length - 1]?.close;
      return { ...l, completed, premium };
    }).filter(r => r.premium != null);
    const inBand = rows.filter(r => r.premium! >= VWAP930_MIN_PREMIUM && r.premium! <= VWAP930_MAX_PREMIUM)
      .sort((a, b) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm));
    const first = inBand[0];
    let picked: { strike: number; premium: number; close: number; vwap: number } | null = null;
    if (first) {
      const nm = aggregateCandles(first.completed, VWAP930_CANDLE_MINUTES);
      if (nm.length) {
        const vw = calcVWAP(nm);
        picked = { strike: first.strike, premium: first.premium!, close: nm[nm.length - 1].close, vwap: vw[vw.length - 1] };
      }
    }
    return reasonSide(inBand.map(r => ({ strike: r.strike, premium: r.premium! })), rows.length - inBand.length, picked);
  }

  const ce = side("CE"), pe = side("PE");
  const dir = alert.direction as "CE" | "PE";
  const chosenSide = dir === "CE" ? ce : pe;
  if (!chosenSide.picked) return null;
  const decided = legs.find(l => l.type === dir && l.strike === chosenSide.picked!.strike)!;
  const nm = aggregateCandles((map[scripCode(decided.token, "NIFTY")] ?? []).filter(c => new Date(c.date).getTime() < minuteStart), VWAP930_CANDLE_MINUTES);
  return {
    candleTime: candleWindow(nm[nm.length - 1]), band: [VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM], atm,
    ce, pe, chosen: dir, summary: buildSummary(dir, ce, pe), rebuilt: true,
  };
}

// ─── Update P&L for an existing alert ─────────────────────────────────────────
export function updateAlertPnL(alert: AlertRecord, currentLtp: number): AlertRecord {
  const pnl = +(currentLtp - alert.rr.entry).toFixed(2);
  const pct = +(pnl / alert.rr.entry * 100).toFixed(2);
  const peakMove = +(Math.max(alert.peakMove ?? 0, currentLtp - alert.rr.entry)).toFixed(2);
  let status = alert.status;

  const breakevenTriggerPct = alert.breakevenTriggerPct ?? VWAP930_BREAKEVEN_TRIGGER_PCT;
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
    const touch = checkPriceTouch(rr as any, currentLtp, "target");
    const hoursOpen = alert.createdAt ? (now.getTime() - new Date(alert.createdAt).getTime()) / 3_600_000 : 0;

    if (h === 15 && m >= 20) status = "TIME_EXIT";
    else if (touch === "SL") status = "SL";
    else if (touch === "TARGET") status = "TARGET";
    else if (hoursOpen >= VWAP930_STAGNANT_HOURS && peakMove < VWAP930_STAGNANT_MAX_POINTS) status = "STAGNANT_EXIT";
  }

  const justExited = status !== "ACTIVE" && alert.status === "ACTIVE";
  const exitNow = justExited ? new Date() : null;
  const exitTime = justExited
    ? exitNow!.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
    : alert.exitTime;
  const exitedAt = justExited ? exitNow!.toISOString() : alert.exitedAt;

  return { ...alert, rr, currentPnL: pnl, pnlPct: pct, status, exitTime, exitedAt, lastLtp: currentLtp, peakMove, slMovedToBreakeven, breakevenJustTriggered };
}

// ─── Historical / Backtest scan ───────────────────────────────────────────────
export async function runHistoricalVWAP930Scan(date: string, expiry: string): Promise<BacktestSummary> {
  if (!hasToken()) throw new Error("Not authenticated");

  const from = new Date(`${date}T09:15:00+05:30`);
  const to   = new Date(`${date}T15:30:00+05:30`);

  // Options stop appearing on the regular historical-candle endpoint the
  // moment they stop trading (15:30 IST on the CONTRACT's own expiry day) —
  // same rule as ChartPanel's fix, just checked here against the real
  // current clock instead of the backtest's own `date` (a backtest date is
  // always in the past by definition, but its `expiry` might still be a
  // live, not-yet-expired contract — e.g. backtesting last Tuesday against
  // this week's still-open expiry). Every candle fetch below needs to know
  // this up front, since every single strike would otherwise silently
  // return empty and look exactly like "no signal found" rather than "wrong
  // endpoint for an expired contract."
  // .toISOString() always renders in UTC no matter how the Date was built —
  // using it to read off "today's date" is wrong by a full day for any IST
  // time before 05:30 (UTC+5:30 means that window falls on the PREVIOUS UTC
  // calendar date). toLocaleDateString with an explicit timeZone is the
  // correct way to get the real IST calendar date (same pattern used
  // elsewhere in this codebase, e.g. accountService.ts's todayIST()).
  const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const contractExpired = expiry < todayIST || (expiry === todayIST && (nowIST.getHours() > 15 || (nowIST.getHours() === 15 && nowIST.getMinutes() >= 30)));

  const niftyCode = indexScripCode(NIFTY_INDEX_ID, "NIFTY");
  const niftyMap  = await getHistorical([niftyCode], "1minute", from, to, "NIFTY");
  const rawNifty  = niftyMap[niftyCode] ?? [];
  if (rawNifty.length < 6) throw new Error(`No NIFTY candle data for ${date}. Market may have been closed.`);

  const instruments = await getFnoInstruments();
  const tokenMap = new Map<string, number>();
  const strikesByType: { CE: number[]; PE: number[] } = { CE: [], PE: [] };
  for (const inst of instruments) {
    if (inst.name !== "NIFTY" || inst.kind !== "OPTIDX" || inst.expiry !== expiry || inst.strike == null) continue;
    tokenMap.set(`${inst.strike}_${inst.type}`, inst.token);
    if (inst.type === "CE" || inst.type === "PE") strikesByType[inst.type].push(inst.strike);
  }
  strikesByType.CE.sort((a, b) => a - b);
  strikesByType.PE.sort((a, b) => a - b);

  const checkpoints: Date[] = [];
  {
    const start = new Date(`${date}T${String(VWAP930_ENTRY_START_HOUR).padStart(2,"0")}:${String(VWAP930_ENTRY_START_MINUTE).padStart(2,"0")}:00+05:30`);
    const end   = new Date(`${date}T15:30:00+05:30`);
    for (let t = start.getTime(); t <= end.getTime(); t += VWAP930_CANDLE_MINUTES * 60_000) {
      checkpoints.push(new Date(t));
    }
  }

  type Series = { token: number; candles: Candle[]; candlesNm: Candle[]; vwapNm: number[] };
  const seriesCache = new Map<string, Series | null>();

  async function getSeries(strike: number, type: "CE" | "PE"): Promise<Series | null> {
    const key = `${strike}_${type}`;
    if (seriesCache.has(key)) return seriesCache.get(key)!;
    const token = tokenMap.get(key);
    let series: Series | null = null;
    if (token) {
      const raw = contractExpired
        ? await (async () => {
            const sym = expiredOptionSymbol("NIFTY", expiry, strike, type);
            const map = await getHistoricalExpired([sym], "1minute", from, to, "NIFTY").catch(() => ({} as Record<string, Candle[]>));
            return map[sym] ?? [];
          })()
        : await (async () => {
            const code = scripCode(token, "NIFTY");
            const map = await getHistorical([code], "1minute", from, to, "NIFTY").catch(() => ({} as Record<string, Candle[]>));
            return map[code] ?? [];
          })();
      if (raw.length >= VWAP930_CANDLE_MINUTES * 2) {
        const candlesNm = aggregateCandles(raw, VWAP930_CANDLE_MINUTES);
        const vwapNm = calcVWAP(candlesNm);
        series = { token, candles: raw, candlesNm, vwapNm };
      }
    }
    seriesCache.set(key, series);
    return series;
  }

  type Cand = {
    strike: number; token: number; premium: number; vwap: number; confirmIdx3: number;
    candle3: Candle; entryCandle: Candle; entryIdx: number; candles: Candle[];
    checked: { strike: number; premium: number }[]; outOfBand: number;
  };

  async function tryCheckpoint(entryMark: Date) {
    const entryNiftyCandle = rawNifty.find(c => new Date(c.date).getTime() >= entryMark.getTime());
    if (!entryNiftyCandle) return null;
    const spot = entryNiftyCandle.open;
    const atm = getATM(spot);

    async function fetchCandidate(type: "CE" | "PE"): Promise<Cand | null> {
      // Every real strike for this expiry, closest-to-ATM first — same
      // selection order as live's findCandidateLegs(), instead of the old
      // fixed ±50/100/150 offset list, which could never find (and so could
      // never enter) a real strike further from ATM than that.
      const strikes = [...strikesByType[type]].sort((a, b) => Math.abs(a - atm) - Math.abs(b - atm));
      const checked: { strike: number; premium: number }[] = [];
      let outOfBand = 0;
      for (const strike of strikes) {
        const series = await getSeries(strike, type);
        if (!series) continue;
        const { token, candles, candlesNm, vwapNm } = series;
        let idx3 = -1;
        for (let i = 0; i < candlesNm.length; i++) {
          if (new Date(candlesNm[i].date).getTime() <= entryMark.getTime()) idx3 = i; else break;
        }
        if (idx3 < 0) continue;
        const candle3 = candlesNm[idx3];
        const premium = candle3.close;
        if (premium < VWAP930_MIN_PREMIUM || premium > VWAP930_MAX_PREMIUM) { outOfBand++; continue; }
        checked.push({ strike, premium });
        const entryIdx = candles.findIndex(c => new Date(c.date).getTime() > new Date(candle3.date).getTime());
        if (entryIdx === -1) continue;
        return { strike, token, premium, vwap: vwapNm[idx3], confirmIdx3: idx3, candle3, entryCandle: candles[entryIdx], entryIdx, candles, checked, outOfBand };
      }
      return null;
    }

    const [ceCand, peCand] = await Promise.all([fetchCandidate("CE"), fetchCandidate("PE")]);
    const ceQualifies = !!ceCand && ceCand.premium > ceCand.vwap;
    const peQualifies = !!peCand && peCand.premium > peCand.vwap;
    if (!ceQualifies && !peQualifies) return null;

    let chosen: Cand, dir: "CE" | "PE";
    if (ceQualifies && peQualifies) {
      const ceDist = ceCand!.premium - ceCand!.vwap;
      const peDist = peCand!.premium - peCand!.vwap;
      if (ceDist >= peDist) { chosen = ceCand!; dir = "CE"; } else { chosen = peCand!; dir = "PE"; }
    } else if (ceQualifies) { chosen = ceCand!; dir = "CE"; }
    else { chosen = peCand!; dir = "PE"; }

    return { chosen, dir, spot, atm, ceCand, peCand, entryMark };
  }

  async function attemptEntry(afterMs: number | null) {
    for (const entryMark of checkpoints) {
      if (afterMs != null && entryMark.getTime() <= afterMs) continue;
      const picked = await tryCheckpoint(entryMark);
      if (picked) return picked;
    }
    return null;
  }

  function resolveOutcome(picked: NonNullable<Awaited<ReturnType<typeof tryCheckpoint>>>) {
    const { chosen, dir, spot, atm, ceCand, peCand, entryMark } = picked;
    const entry = chosen.premium;
    const toSide = (c: Cand | null) =>
      reasonSide(c?.checked ?? [], c?.outOfBand ?? 0, c ? { strike: c.strike, premium: c.premium, close: c.premium, vwap: c.vwap } : null);
    const sideCE = toSide(ceCand), sidePE = toSide(peCand);
    const entryReason: EntryReason = {
      candleTime: candleWindow(chosen.candle3), band: [VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM], atm,
      ce: sideCE, pe: sidePE, chosen: dir, summary: buildSummary(dir, sideCE, sidePE),
    };
    const rr = buildRR(entry);
    const stagnantCutoffMs = entryMark.getTime() + VWAP930_STAGNANT_HOURS * 3_600_000;

    const laterCandles = chosen.candles.slice(chosen.entryIdx + 1);
    let status: AlertRecord["status"] = "ACTIVE", exitPrice = entry, exitTime: string | Date | null = null, peakMove = 0;
    // Mirrors updateAlertPnL's breakeven move exactly — once peakMove crosses
    // the trigger %, the SL used for the rest of the trade becomes entry,
    // not the original risk-based level. Without this, a trade that live
    // would exit at breakeven could show as a full SL loss (or a win it
    // never would have reached) in the backtest instead.
    let sl = rr.sl;
    let slMovedToBreakeven = false;
    for (const c of laterCandles) {
      const { h: ch, m: cm } = toIST(c.date);
      const move = +(c.high - entry).toFixed(2);
      if (move > peakMove) peakMove = move;
      if (!slMovedToBreakeven && peakMove > 0 && (peakMove / entry) * 100 >= VWAP930_BREAKEVEN_TRIGGER_PCT) {
        sl = entry;
        slMovedToBreakeven = true;
      }
      if (c.low <= sl) { status = "SL"; exitPrice = sl; exitTime = c.date; break; }
      if (c.high >= rr.target) { status = "TARGET"; exitPrice = rr.target; exitTime = c.date; break; }
      if (ch === 15 && cm >= 20) { status = "TIME_EXIT"; exitPrice = c.close; exitTime = c.date; break; }
      if (new Date(c.date).getTime() >= stagnantCutoffMs && peakMove < VWAP930_STAGNANT_MAX_POINTS) {
        status = "STAGNANT_EXIT"; exitPrice = c.close; exitTime = c.date; break;
      }
    }
    if (status === "ACTIVE" && laterCandles.length) {
      exitPrice = laterCandles[laterCandles.length - 1].close;
      status = "EOD";
      exitTime = laterCandles[laterCandles.length - 1].date;
    }

    const pnl = +(exitPrice - entry).toFixed(2);
    const pct = +(pnl / entry * 100).toFixed(2);
    const entryTimeStr = `${String(entryMark.getHours()).padStart(2,"0")}:${String(entryMark.getMinutes()).padStart(2,"0")}`;
    const exitTimeStr = exitTime
      ? new Date(exitTime).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
      : null;

    const result: AlertRecord = {
      id: `hist_VWAP930_${dir}_${chosen.strike}_${date}_${entryTimeStr.replace(":", "")}`,
      entryTime: entryTimeStr, exitTime: exitTimeStr, direction: dir, strike: chosen.strike,
      leg: { token: chosen.token, tradingsymbol: "", strike: chosen.strike, type: dir, ltp: exitPrice },
      rr, vwap: chosen.vwap, vwapCE: ceCand?.vwap ?? undefined, vwapPE: peCand?.vwap ?? undefined, entryReason,
      status, currentPnL: pnl, pnlPct: pct, peakMove,
      spot, expiry, createdAt: chosen.entryCandle.date as any, isHistorical: true, date,
    };
    return { result, exitTimeMs: exitTime ? new Date(exitTime).getTime() : entryMark.getTime() };
  }

  const results: AlertRecord[] = [];
  let picked = await attemptEntry(null);
  while (picked && results.length < VWAP930_MAX_TRADES_PER_DAY) {
    const { result, exitTimeMs } = resolveOutcome(picked);
    results.push(result);
    if (!(result.currentPnL < 0) || results.length >= VWAP930_MAX_TRADES_PER_DAY) break;
    picked = await attemptEntry(exitTimeMs + VWAP930_REENTRY_COOLDOWN_MIN * 60_000);
  }

  if (!results.length) {
    return {
      results: [], date, expiry, totalSignals: 0, wins: 0, losses: 0, winRate: null,
      message: `No CE/PE in premium band with a ${VWAP930_CANDLE_MINUTES}-min candle closing above VWAP after ${entryStartStr()}`,
    };
  }

  // A profitable TIME_EXIT is a win too — matches the convention used
  // everywhere else this figure is shown (StrategyTableView, results/journal
  // pages, the live status stat).
  const wins = results.filter(r => r.status === "TARGET" || (r.status === "TIME_EXIT" && (r.currentPnL ?? 0) >= 0)).length;
  const losses = results.filter(r => r.status === "SL").length;
  const eod = results.filter(r => r.status === "EOD").length;
  const closed = results.filter(r => r.status !== "ACTIVE").length;

  return {
    results, date, expiry, totalSignals: results.length, wins, losses, eod,
    winRate: closed > 0 ? +((wins / closed) * 100).toFixed(1) : null,
  };
}
