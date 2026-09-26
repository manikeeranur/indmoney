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
  t1Hit?: boolean;
  t1HitTime?: string | null;
  // VWAP930-only
  vwap?: number;
  vwapCE?: number;
  vwapPE?: number;
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
