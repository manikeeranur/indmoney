// ─── Shared strategy types ─────────────────────────────────────────────────────
import type { Candle, Leg as ChainLeg, OptionType } from "@/lib/broker/types";

export type RR = {
  entry: number;
  sl: number;
  target1?: number;   // SMC only — milestone marker
  target2?: number;   // SMC's real exit
  target?: number;    // VWAP930's single target
  risk: number;
  reward: number;
  riskPct: number;
  rewardPct: number;
};

export type AlertStatus =
  | "ACTIVE" | "SL" | "TARGET" | "TIME_EXIT" | "EOD" | "STAGNANT_EXIT";

/** One live or historical (backtest) trade record. Superset of both
 *  strategies' shapes — SMC-only and VWAP930-only fields are optional. */
export type AlertRecord = {
  id: string;
  alertId?: string;
  date?: string;
  entryTime: string;
  exitTime?: string | null;
  exitedAt?: string | null;
  direction: OptionType;
  strike: number;
  expiry: string;
  leg?: { token: number; tradingsymbol: string; strike: number; type: OptionType; ltp: number };
  tradingsymbol?: string | null;
  rr: RR;
  status: AlertStatus;
  currentPnL: number;
  pnlPct: number;
  peakMove: number;
  spot: number;
  createdAt: string;
  lastLtp?: number | null;
  slMovedToBreakeven?: boolean;
  breakevenJustTriggered?: boolean;
  breakevenTriggerPct?: number | null;
  // SMC-only
  score?: number;
  effScore?: number;
  strength?: string;
  trendOk?: boolean;
  concepts?: string[];
  // Drawable price-level rectangles for whichever concepts fired — one per
  // entry in `concepts`, same order. See lib/strategies/smc.ts's PatternZone.
  patternZones?: { concept: string; top: number; bottom: number; fromTime: number; toTime: number }[];
  t1Hit?: boolean;
  t1HitTime?: string | null;
  // VWAP930-only
  vwap?: number;
  vwapCE?: number;
  vwapPE?: number;
  entryReason?: EntryReason;
  // backtest-only
  isHistorical?: boolean;
};

export type ScanResult =
  | { signal: false; reason: string; debug?: unknown }
  | ({ signal: true } & AlertRecord);

export type BacktestSummary = {
  results: AlertRecord[];
  date: string;
  expiry: string;
  totalSignals: number;
  wins: number;
  losses: number;
  eod?: number;
  winRate: number | null;
  message?: string;
};

export type { Candle, ChainLeg };

/** Why a VWAP930 entry was taken — every in-band premium looked at on each
 *  side, the strike actually tested per side, its candle close vs VWAP, and
 *  which side won. Shown under the trade's row in the strategy table. */
export type EntryReasonSide = {
  /** In-band premiums on this side, closest-to-ATM first (the order they were tried). */
  checked: { strike: number; premium: number }[];
  /** How many strikes on this side fell outside the premium band. */
  outOfBand: number;
  /** The strike this side was judged on (closest to ATM inside the band). */
  picked: { strike: number; premium: number; close: number; vwap: number; aboveVwap: boolean } | null;
};
export type EntryReason = {
  candleTime: string;
  band: [number, number];
  atm: number;
  ce: EntryReasonSide;
  pe: EntryReasonSide;
  chosen: "CE" | "PE";
  summary: string;
  /** Set when rebuilt afterwards from 1-min candles (alert saved before
   *  entryReason existed) — in-band premiums are candle closes, not live LTPs. */
  rebuilt?: boolean;
};
