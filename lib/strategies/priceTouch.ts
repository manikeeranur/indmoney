// ─── SL/Target touch check ─────────────────────────────────────────────────────
// Ported unchanged from backend/src/services/priceTouchUtil.js — pure, no
// broker dependency. Shared between the poll-driven P&L refresh and the
// tick-driven exit monitor, so the two paths can never disagree about whether
// a price has touched SL/Target. `targetField` lets callers use their own rr
// shape (SMC: "target2", VWAP930: "target").
export type RR = Record<string, number> & { sl: number };

export function checkPriceTouch(rr: RR, ltp: number, targetField = "target"): "SL" | "TARGET" | null {
  if (ltp <= rr.sl) return "SL";
  if (ltp >= rr[targetField]) return "TARGET";
  return null;
}
