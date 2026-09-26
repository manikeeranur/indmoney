// ─── Runtime boot ─────────────────────────────────────────────────────────────
// Brings up everything that must exist once per process and live for the whole
// trading day: the broker token, the instrument cache, the price feed, and
// (from P3) the strategy schedulers.
//
// Order matters. The token must exist before the instrument cache can load, and
// the instrument cache must be warm before the price feed subscribes anything,
// because subscriptions are addressed by segment + security id.
//
// All mutable state lives in ./state (anchored on globalThis) rather than in
// module scope — see the explanation there.

import { hasToken, isConfigured, canAutoRefresh, getAccessToken } from "../broker/auth";
import { getFnoInstruments, getLotSize, getNearestExpiry } from "../broker/instruments";
import { startPriceFeed, stopPriceFeed, onTicks, priceFeedStatus } from "../broker/wsPrices";
import { broadcastToBrowsers, priceFeedStatus as livePriceFeedStatus } from "./registry";
import { handleTick } from "./alertStore";
import { smcConfig, vwap930Config } from "./engines";
import { startScheduler, stopScheduler } from "./scheduler";
import { startOiSnapshotRecorder } from "./oiSnapshot";
import { loadOrCreate } from "./settingsService";
import { connectDB } from "@/lib/db/connect";
import { setEnabled } from "./autoTrade";
import { state } from "./state";

export async function boot() {
  const s = state();
  if (s.booted) return;
  s.booted = true;

  console.log("[Boot] INDMONEY runtime starting");

  // Wire the live readers up front so /api/health reports the truth even if the
  // steps below fail.
  s.authenticated   = () => hasToken();
  s.priceFeedStatus = () => livePriceFeedStatus();
  registerGlobals();

  if (!isConfigured()) {
    s.bootError =
      "INDstocks credentials not set — the UI will load but no market data will flow. " +
      "Set IND_CLIENT_ID, IND_MPIN and IND_TOTP_SECRET in .env";
    console.warn(`[Boot] ${s.bootError}`);
    return;
  }

  if (!canAutoRefresh()) {
    console.warn(
      "[Boot] Running on a manually pasted IND_ACCESS_TOKEN — this process CANNOT " +
      "refresh it. When it expires, scanning and trading stop until a new token is " +
      "pasted. Set IND_TOTP_SECRET to make this automatic.",
    );
  }

  try {
    await getAccessToken();
  } catch (err: any) {
    s.bootError = `Token generation failed: ${err.message}`;
    console.error(`[Boot] ${s.bootError}`);
    return;
  }

  await startMarketData();
  console.log("[Boot] Runtime ready");
}

/**
 * Everything that needs a valid token. Split out of boot() so the login screen
 * can bring market data up immediately after authenticating, instead of the
 * user having to restart the server — which was the whole reason for adding a
 * login screen.
 */
export async function bootAfterLogin() {
  const s = state();
  s.bootError = null;
  await startMarketData();
}

let marketDataStarted = false;

async function startMarketData() {
  const s = state();

  // Warm the instrument master once, so the first chain request isn't paying
  // for a multi-megabyte CSV download.
  try {
    await getFnoInstruments();
    s.lotSize = await getLotSize("NIFTY");
    console.log(`[Boot] NIFTY lot size from exchange master: ${s.lotSize}`);
  } catch (err: any) {
    s.bootError = `Instrument master failed: ${err.message}`;
    console.error(`[Boot] ${s.bootError}`);
  }

  if (marketDataStarted) return; // listener + feed are already live
  marketDataStarted = true;

  // Ticks fan out to every open browser tab in the old app's message shape, so
  // ported UI code needs no changes.
  onTicks((ticks) => broadcastToBrowsers({ type: "ticks", data: ticks }));
  startOiSnapshotRecorder();

  // Tick-driven fast exit path — the old app's tickExitMonitor.js. Without
  // this, an ACTIVE alert's SL/target is only re-checked once a minute by the
  // scanner's own poll (doScan → refreshActivePnL), so a sharp move could
  // blow through SL for up to ~60s before anything reacted. Each tick is an
  // O(1) lookup via activeTokenIndex — a no-op for the vast majority of ticks
  // that aren't on an open position's leg.
  onTicks((ticks) => {
    for (const t of ticks) {
      handleTick(smcConfig, t.instrument_token, t.last_price);
      handleTick(vwap930Config, t.instrument_token, t.last_price);
    }
  });

  await startPriceFeed();

  // Mongo + persisted settings (auto-trade on/off survives a restart) — best
  // effort, same "DB optional, degrade to in-memory defaults" contract as the
  // Kite app.
  try {
    await connectDB();
    const settings = await loadOrCreate();
    setEnabled("smc", settings.smcAutoTradeEnabled);
    setEnabled("vwap930", settings.vwap930AutoTradeEnabled);
    console.log(`[Boot] Restored auto-trade — SMC:${settings.smcAutoTradeEnabled} VWAP930:${settings.vwap930AutoTradeEnabled}`);
  } catch (err: any) {
    console.warn("[Boot] Settings restore failed:", err.message);
  }

  startScheduler();
}

function registerGlobals() {
  // server.js (CommonJS) and every API route (a separate Next module graph)
  // reach the runtime ONLY through this object — see lib/runtime/registry.ts
  // for why importing this module from a route is a bug.
  (globalThis as any).__INDMONEY_RUNTIME__ = {
    authenticated: () => hasToken(),
    configured:    () => isConfigured(),
    autoRefresh:   () => canAutoRefresh(),
    bootAfterLogin,
    shutdown,
  };
}

export function shutdown() {
  console.log("[Boot] Stopping price feed and scheduler");
  stopPriceFeed();
  stopScheduler();
}

export function runtimeStatus() {
  const s = state();
  return {
    booted:        s.booted,
    bootError:     s.bootError,
    configured:    isConfigured(),
    authenticated: s.authenticated?.() ?? false,
    autoRefresh:   canAutoRefresh(),
    lotSize:       s.lotSize,
    priceFeed:     livePriceFeedStatus(),
  };
}

export function getCachedLotSize() {
  return state().lotSize;
}

export { getNearestExpiry };
