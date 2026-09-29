// ─── Trading constants ─────────────────────────────────────────────────────────
// Ported from backend/src/config/constants.js — single source of truth for
// both strategies' SL/target %, premium bands, daily caps and timing, exactly
// as in the Kite app so behaviour matches signal-for-signal.
//
// LOT_SIZE here is a fallback only. The REAL lot size is read live from the
// INDstocks instrument master (lib/broker/instruments.ts getLotSize()) — see
// that file's header for why a hardcoded value is never trusted for order
// sizing. Verified against the live exchange master on 2026-09-25: NIFTY is
// 65, matching this fallback exactly.
export const LOT_SIZE        = 65;
export const SENSEX_LOT_SIZE = 20;
export const NUM_LOTS        = 10;

export const MIN_PREMIUM = Number(process.env.MIN_PREMIUM) || 300;
export const MAX_PREMIUM = Number(process.env.MAX_PREMIUM) || 500;

export const EXCHANGE = "NSE" as const; // INDstocks derivative exchange for NIFTY
export const SEGMENT  = "DERIVATIVE" as const;
export const PRODUCT  = "INTRADAY" as const; // INDstocks' MIS-equivalent

// ─── SMC strategy — SL/Target ──────────────────────────────────────────────────
export const SMC_SL_PCT      = 6;
export const SMC_TARGET1_PCT = 12; // milestone marker only — not a real exit
export const SMC_TARGET_PCT  = 24; // the real exit
export const SMC_MAX_TRADES_PER_DAY = 2;
export const SMC_REENTRY_COOLDOWN_MIN = 15;
export const SMC_BREAKEVEN_TRIGGER_PCT = 10;

export const FALLBACK1_MIN = Math.round(MIN_PREMIUM * 0.75);
export const FALLBACK1_MAX = Math.round(MAX_PREMIUM * 1.75);
export const FALLBACK2_MIN = Math.round(MIN_PREMIUM * 0.50);
export const FALLBACK2_MAX = Math.round(MAX_PREMIUM * 2.00);
export const SWEET_SPOT    = Math.round((MIN_PREMIUM + MAX_PREMIUM) / 2);

// ─── VWAP 9:30 strategy ─────────────────────────────────────────────────────────
export const VWAP930_MIN_PREMIUM = Number(process.env.VWAP930_MIN_PREMIUM) || 300;
export const VWAP930_MAX_PREMIUM = Number(process.env.VWAP930_MAX_PREMIUM) || 500;
export const VWAP930_SL_PCT      = 6;
export const VWAP930_TARGET_PCT  = 30;
export const VWAP930_NUM_LOTS    = 10;
export const VWAP930_CANDLE_MINUTES     = 5;
export const VWAP930_ENTRY_HOUR         = [9, 10, 11, 12, 13, 14, 15];
export const VWAP930_ENTRY_START_HOUR   = 9;
export const VWAP930_ENTRY_START_MINUTE = 20;
export const VWAP930_MAX_TRADES_PER_DAY = 2;
export const VWAP930_STAGNANT_HOURS      = 3;
export const VWAP930_STAGNANT_MAX_POINTS = 30;
export const VWAP930_REENTRY_COOLDOWN_MIN = 15;
export const VWAP930_BREAKEVEN_TRIGGER_PCT = 10;
