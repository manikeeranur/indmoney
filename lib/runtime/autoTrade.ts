// ─── Auto-trade engine ─────────────────────────────────────────────────────────
// One parameterized engine used by both SMC and VWAP930 (the Kite app had two
// 370-line near-duplicates — autoTrade.js and vwap930AutoTrade.js — that only
// differed in constants and Telegram labels).
//
// Order flow is NOT a like-for-like port, because INDstocks' order model is
// different in two ways that matter:
//
//  1. `POST /smart/order` carries the stop-loss AND target as child legs of
//     ONE call. The Kite app placed a MARKET BUY, then a SEPARATE SL-M SELL —
//     there was a real window where a live position had no protective stop.
//     One call here removes that window entirely.
//
//  2. INDstocks has NO true MARKET order — a request is converted to a LIMIT
//     at the current live price, so a fill is not guaranteed. This engine
//     re-prices and retries on a timeout (3 attempts for entries, 5 more
//     aggressive attempts for exits — getting OUT matters more than price),
//     and gives up loudly on Telegram rather than leaving a position it
//     believes is protected when the order never actually landed.
//
// FLAG FOR LIVE VERIFICATION: fill confirmation here polls the order book for
// a terminal status, and the breakeven SL move attempts smart-order modify on
// the child leg. INDstocks' exact status vocabulary and whether a child GTT's
// trigger can be modified post-placement are both assumed from the docs and
// have not been exercised against a live fill — verify in Phase 4's paper- and
// one-lot-live sessions before trusting this at full size.

import { hasToken } from "@/lib/broker/auth";
import { placeSmartOrder, placeOrder, cancelSmartOrder, cancelOrder, modifySmartOrder, getOrderBook, getPositions, isOrderFilled, isOrderDead } from "@/lib/broker/orders";
import { getLotSize } from "@/lib/broker/instruments";
import { subscribeTokens } from "@/lib/broker/wsPrices";
import { getCached } from "./settingsService";
import type { AlertRecord } from "@/lib/strategies/types";

export type EngineKey = "smc" | "vwap930";

export type Position = {
  alertId: string;
  tradingsymbol: string;
  strike: number;
  direction: string;
  token: number;
  orderQty: number;
  entryOrderId: string | null;
  slChildOrderId: string | null;
  exitOrderId: string | null;
  status: "PENDING" | "ENTRY_PLACED" | "ACTIVE" | "EXITING" | `EXITED_${string}` | "ERROR";
  slMovedToBreakeven: boolean;
  rr: AlertRecord["rr"];
  logs: string[];
};

type EngineState = { enabled: boolean; positions: Position[] };

function state(key: EngineKey): EngineState {
  const g = globalThis as any;
  g.__INDMONEY_AUTOTRADE__ ??= {};
  g.__INDMONEY_AUTOTRADE__[key] ??= { enabled: false, positions: [] } satisfies EngineState;
  return g.__INDMONEY_AUTOTRADE__[key];
}

export type EngineConfig = {
  key: EngineKey;
  label: string; // "SMC" | "VWAP930" — used in logs and Telegram
  numLotsDefault: number;
  /** Which rr field carries the real exit target — SMC: target2, VWAP930: target. */
  targetField: "target2" | "target";
  telegram: {
    sendStarted: () => void;
    sendStopped: () => void;
    sendOrder: (pos: Position, kind: "ENTRY" | "EXIT" | "ERROR") => void;
  };
};

const ENTRY_FILL_TIMEOUT_MS = 3000;
const ENTRY_MAX_ATTEMPTS = 3;
const EXIT_FILL_TIMEOUT_MS = 3000;
const EXIT_MAX_ATTEMPTS = 5;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function log(cfg: EngineConfig, alertId: string, msg: string) {
  const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`[AutoTrade:${cfg.label}] [${alertId}] ${msg}`);
  const pos = state(cfg.key).positions.find(p => p.alertId === alertId);
  if (pos) pos.logs.push(`${ts} — ${msg}`);
}

/** Poll the order book until the order reaches a terminal state or the
 *  timeout elapses. Returns the filled quantity (0 if none). Status
 *  vocabulary (SUCCESS/CANCELLED/FAILED/EXPIRED/ABORTED) and field names
 *  (`id`, `traded_qty`) verified against /normal_orders' own sample
 *  response — see lib/broker/orders.ts. */
async function waitForFill(orderId: string, expectedQty: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const book = await getOrderBook();
      const row = book.find(o => o.id === orderId);
      if (row) {
        if (isOrderFilled(row, expectedQty)) return row.traded_qty;
        if (isOrderDead(row)) return 0;
      }
    } catch { /* transient — keep polling until the deadline */ }
    await sleep(400);
  }
  return 0;
}

// ─── Entry ────────────────────────────────────────────────────────────────────
export async function executeEntry(cfg: EngineConfig, alert: AlertRecord): Promise<void> {
  const s = state(cfg.key);
  if (!s.enabled) return;
  if (!hasToken()) { console.warn(`[AutoTrade:${cfg.label}] Not authenticated — skipping`); return; }

  const { id: alertId, leg, rr } = alert;
  if (!leg?.tradingsymbol) { console.warn(`[AutoTrade:${cfg.label}] No tradingsymbol on leg — skipping`); return; }

  const defaults = getCached().accountDefaults;
  const lotSize  = await getLotSize("NIFTY").catch(() => 65);
  const orderQty = lotSize * (defaults.quantity ?? cfg.numLotsDefault);
  const isPaper  = defaults.tradingMode === "PAPER";

  if (defaults.stopLoss != null) rr.sl = +(rr.entry - defaults.stopLoss).toFixed(2);
  if (defaults.target   != null) (rr as any)[cfg.targetField] = +(rr.entry + defaults.target).toFixed(2);

  if (s.positions.some(p => p.alertId === alertId)) {
    console.warn(`[AutoTrade:${cfg.label}] Duplicate entry blocked — ${alertId} already tracked`);
    return;
  }

  const pos: Position = {
    alertId, tradingsymbol: leg.tradingsymbol, strike: leg.strike, direction: alert.direction,
    token: leg.token, orderQty, entryOrderId: null, slChildOrderId: null, exitOrderId: null,
    status: "PENDING", slMovedToBreakeven: false, rr, logs: [],
  };
  s.positions.unshift(pos);

  if (isPaper) {
    pos.entryOrderId = `PAPER-${Date.now()}`;
    pos.slChildOrderId = `PAPER-SL-${Date.now()}`;
    pos.status = "ACTIVE";
    log(cfg, alertId, `[PAPER] Simulated entry — ${leg.tradingsymbol} BUY ${orderQty} @ ₹${rr.entry}, SL ₹${rr.sl}`);
    cfg.telegram.sendOrder(pos, "ENTRY");
    subscribeTokens([leg.token], "quote"); // quote mode: keeps OI for the EOD report
    return;
  }

  // Guard: don't double-enter if a real position for this symbol already exists.
  try {
    const positions = await getPositions();
    const already = positions.some(p => p.symbol === leg.tradingsymbol && Math.abs(p.net_qty) > 0);
    if (already) {
      console.warn(`[AutoTrade:${cfg.label}] Entry blocked — open position already exists for ${leg.tradingsymbol}`);
      pos.status = "ERROR";
      return;
    }
  } catch (e: any) {
    console.warn(`[AutoTrade:${cfg.label}] Could not check open positions — ${e.message}. Proceeding.`);
  }

  const target = (rr as any)[cfg.targetField] as number | undefined;

  for (let attempt = 1; attempt <= ENTRY_MAX_ATTEMPTS; attempt++) {
    try {
      const limitPrice = attempt === 1 ? rr.entry : leg.ltp; // re-price at the freshest known ltp on retry
      const result = await placeSmartOrder({
        txnType: "BUY", securityId: String(leg.token), qty: orderQty, limitPrice: limitPrice,
        slTriggerPrice: rr.sl, slLimitPrice: +(rr.sl * 0.995).toFixed(2),
        tgtTriggerPrice: target, tgtLimitPrice: target != null ? +(target * 0.995).toFixed(2) : undefined,
        remarks: `${cfg.key}/${alertId}`.slice(0, 100),
      });
      pos.entryOrderId = result.orderId;
      pos.slChildOrderId = result.childOrderId ?? null;
      pos.status = "ENTRY_PLACED";
      log(cfg, alertId, `Entry order placed (attempt ${attempt}) — ${leg.tradingsymbol} BUY ${orderQty} @ ₹${limitPrice}  [${result.orderId}]`);

      const filled = await waitForFill(result.orderId, orderQty, ENTRY_FILL_TIMEOUT_MS);
      if (filled >= orderQty) {
        pos.status = "ACTIVE";
        log(cfg, alertId, `Entry filled — ${filled}/${orderQty}  [SL child ${pos.slChildOrderId ?? "—"}]`);
        cfg.telegram.sendOrder(pos, "ENTRY");
        subscribeTokens([leg.token], "quote");
        return;
      }

      log(cfg, alertId, `Entry not filled within ${ENTRY_FILL_TIMEOUT_MS}ms — cancelling and re-pricing`);
      await cancelSmartOrder(result.orderId).catch(() => {});
    } catch (err: any) {
      log(cfg, alertId, `Entry attempt ${attempt} failed — ${err.message}`);
    }
  }

  pos.status = "ERROR";
  log(cfg, alertId, `Entry FAILED after ${ENTRY_MAX_ATTEMPTS} attempts — giving up, no position taken`);
  cfg.telegram.sendOrder(pos, "ERROR");
}

// ─── Breakeven ────────────────────────────────────────────────────────────────
export async function moveSLToBreakeven(cfg: EngineConfig, alert: AlertRecord): Promise<void> {
  const s = state(cfg.key);
  const pos = s.positions.find(p => p.alertId === alert.id && p.status === "ACTIVE");
  if (!pos || pos.slMovedToBreakeven) return;
  pos.slMovedToBreakeven = true; // set before the await — closes the race window

  const newSL = alert.rr.entry;
  if (pos.entryOrderId?.startsWith("PAPER-")) {
    pos.rr.sl = newSL;
    log(cfg, alert.id, `[PAPER] Simulated SL move to breakeven — ₹${newSL}`);
    return;
  }
  if (!hasToken() || !pos.slChildOrderId) return;

  try {
    // Verified against /smart_orders: the child GTT order's own id accepts
    // sl_trigger_price/sl_limit_price directly — "operate on each order
    // separately using its own order_id". No cancel-and-replace needed.
    await modifySmartOrder(pos.slChildOrderId, {
      slTriggerPrice: newSL,
      slLimitPrice: +(newSL * 0.995).toFixed(2),
    });
    pos.rr.sl = newSL;
    log(cfg, alert.id, `SL moved to breakeven — ₹${newSL}  [${pos.slChildOrderId}]`);
  } catch (err: any) {
    console.error(`[AutoTrade:${cfg.label}] Breakeven SL modify failed for ${alert.id} — ${err.message}`);
    log(cfg, alert.id, `Breakeven SL modify FAILED — ${err.message} (order still at original SL)`);
  }
}

// ─── Exit ─────────────────────────────────────────────────────────────────────
export async function executeExit(cfg: EngineConfig, alert: AlertRecord): Promise<void> {
  if (!hasToken()) return;
  const s = state(cfg.key);
  const pos = s.positions.find(p => p.alertId === alert.id && p.status === "ACTIVE");

  const tradingsymbol = pos?.tradingsymbol ?? alert.leg?.tradingsymbol ?? alert.tradingsymbol;
  const token = pos?.token ?? alert.leg?.token;
  if (!tradingsymbol || !token) {
    console.warn(`[AutoTrade:${cfg.label}] Exit skipped — no tradingsymbol/token for ${alert.id}`);
    return;
  }

  if (!pos && getCached().accountDefaults.tradingMode === "PAPER") {
    console.log(`[AutoTrade:${cfg.label}] [PAPER] Simulated exit (post-restart) — ${tradingsymbol} ${alert.status}`);
    return;
  }

  // Post-restart safety net: confirm a real open position exists before ever
  // placing a blind SELL — see autoTrade.js's original comment for the failure
  // mode this prevents (a scanner alert with no in-memory position could mean
  // "survived a restart" or "auto-trade was never on"; those look identical).
  if (!pos) {
    try {
      const positions = await getPositions();
      const held = positions.some(p => p.symbol === tradingsymbol && Math.abs(p.net_qty) > 0);
      if (!held) {
        console.log(`[AutoTrade:${cfg.label}] Exit skipped — no real open position for ${tradingsymbol}`);
        return;
      }
    } catch (e: any) {
      console.warn(`[AutoTrade:${cfg.label}] Could not verify open position — ${e.message}. Skipping to avoid a blind SELL.`);
      return;
    }
  }
  if (pos) pos.status = "EXITING";

  if (pos?.entryOrderId?.startsWith("PAPER-")) {
    pos.exitOrderId = `PAPER-EXIT-${Date.now()}`;
    pos.status = `EXITED_${alert.status}`;
    log(cfg, pos.alertId, `[PAPER] Simulated exit — ${alert.status}`);
    cfg.telegram.sendOrder(pos, "EXIT");
    return;
  }

  const defaults = getCached().accountDefaults;
  const lotSize  = await getLotSize("NIFTY").catch(() => 65);
  const orderQty = pos?.orderQty ?? lotSize * (defaults.quantity ?? cfg.numLotsDefault);

  // Cancel the resting smart order (cascades the child SL/target legs).
  if (pos?.entryOrderId) {
    await cancelSmartOrder(pos.entryOrderId).catch(e =>
      log(cfg, alert.id, `Cancel of resting order warned — ${e.message} (may already be filled/closed)`));
  }

  const currentLtp = alert.lastLtp ?? alert.rr.entry;
  for (let attempt = 1; attempt <= EXIT_MAX_ATTEMPTS; attempt++) {
    try {
      // Getting OUT matters more than price — bias the limit down each retry
      // so it is progressively more aggressive to fill.
      const bias = 1 - Math.min(attempt - 1, 4) * 0.01;
      const limitPrice = +(currentLtp * bias).toFixed(2);
      const orderId = await placeOrder({
        txnType: "SELL", securityId: String(token), qty: orderQty, limitPrice,
        remarks: `${cfg.key}-exit/${alert.id}`.slice(0, 100),
      });

      const filled = await waitForFill(orderId, orderQty, EXIT_FILL_TIMEOUT_MS);
      if (filled >= orderQty) {
        if (pos) {
          pos.exitOrderId = orderId;
          pos.status = `EXITED_${alert.status}`;
          log(cfg, pos.alertId, `Exit filled (attempt ${attempt}) — ${alert.status}  [${orderId}]`);
          cfg.telegram.sendOrder(pos, "EXIT");
        }
        return;
      }
      log(cfg, alert.id, `Exit attempt ${attempt} not filled within ${EXIT_FILL_TIMEOUT_MS}ms — cancelling and re-pricing more aggressively`);
      await cancelOrder(orderId).catch(() => {});
    } catch (err: any) {
      log(cfg, alert.id, `Exit attempt ${attempt} failed — ${err.message}`);
    }
  }

  if (pos) pos.status = "ERROR";
  log(cfg, alert.id, `Exit FAILED after ${EXIT_MAX_ATTEMPTS} attempts — position may still be open, check manually`);
  if (pos) cfg.telegram.sendOrder(pos, "ERROR");
}

// ─── Enable / disable / status ────────────────────────────────────────────────
export function isEnabled(key: EngineKey): boolean { return state(key).enabled; }
export function setEnabled(key: EngineKey, v: boolean): void { state(key).enabled = v; }
export function getPositionsList(key: EngineKey): Position[] { return state(key).positions; }
export function clearPositions(key: EngineKey): void { state(key).positions = []; }
