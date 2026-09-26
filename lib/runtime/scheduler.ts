// ─── Scheduler ────────────────────────────────────────────────────────────────
// Ported from backend/index.js's 8 node-schedule jobs + the 1s Mongo sync
// interval. Wired into instrumentation.ts's boot() so exactly one process runs
// these — never the route graph, which is why every job here reaches state
// only through alertStore/autoTrade/registry, never a direct import of
// anything that isn't itself already globalThis-anchored.
import schedule from "node-schedule";
import { getNearestExpiry } from "@/lib/broker/instruments";
import { doScan, getAllAlerts, getTodayAlerts } from "./alertStore";
import { smcConfig, vwap930Config } from "./engines";
import { getPositionsList } from "./autoTrade";
import { syncAlerts, syncVwap930Alerts } from "./dbSync";
import { runEodOhlcReport } from "@/lib/telegram/eodOhlcReport";
import { eodSnapshot } from "./accountService";
import * as tg from "@/lib/telegram/telegramService";
import { sendSessionSummary } from "@/lib/telegram/smcTelegram";
import { sendVwap930SessionSummary } from "@/lib/telegram/vwap930Telegram";
import { VWAP930_ENTRY_HOUR, VWAP930_ENTRY_START_HOUR, VWAP930_ENTRY_START_MINUTE } from "@/lib/strategies/constants";
import { cancelSmartOrder, placeOrder, getOrderBook, getPositions, isOrderDead } from "@/lib/broker/orders";

let jobsScheduled = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  if (jobsScheduled) return;
  jobsScheduled = true;

  // ─── SMC scanner — every minute, 09:21–15:00 IST, Mon–Fri ──────────────────
  schedule.scheduleJob({ rule: "* 9-15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes();
    if (h === 9 && m < 21) return;
    if (h === 15 && m > 30) return;
    try {
      const expiry = await getNearestExpiry("NIFTY").catch(() => null);
      if (expiry) await doScan(smcConfig, expiry);
    } catch (err: any) { console.error("[SMC Cron] Error:", err.message); }
  });

  // ─── VWAP930 scanner — every minute across its entry hours ─────────────────
  const vwapRange = VWAP930_ENTRY_HOUR.length > 1
    ? `${Math.min(...VWAP930_ENTRY_HOUR)}-${Math.max(...VWAP930_ENTRY_HOUR)}`
    : String(VWAP930_ENTRY_HOUR[0]);
  schedule.scheduleJob({ rule: `* ${vwapRange} * * 1-5`, tz: "Asia/Kolkata" }, async () => {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes();
    if (h < VWAP930_ENTRY_START_HOUR || (h === VWAP930_ENTRY_START_HOUR && m < VWAP930_ENTRY_START_MINUTE)) return;
    try {
      const expiry = await getNearestExpiry("NIFTY").catch(() => null);
      if (expiry) await doScan(vwap930Config, expiry);
    } catch (err: any) { console.error("[VWAP930 Cron] Error:", err.message); }
  });

  // ─── Session open/close pings ───────────────────────────────────────────────
  schedule.scheduleJob({ rule: "15 9 * * 1-5", tz: "Asia/Kolkata" }, () => tg.sendSessionOpen());
  schedule.scheduleJob({ rule: "30 15 * * 1-5", tz: "Asia/Kolkata" }, () => tg.sendSessionClose());

  // ─── 15:20–15:29 EOD square-off — cancel resting smart orders, exit any
  // remaining open positions, retried every minute until confirmed flat ──────
  let squareOffDate: string | null = null;
  let squareOffConfirmed = false;
  schedule.scheduleJob({ rule: "20-29 15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (squareOffDate !== today) { squareOffDate = today; squareOffConfirmed = false; }
    if (squareOffConfirmed) return;

    const now = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    try {
      const book = await getOrderBook();
      // "Resting" = not yet at a terminal state — anything still open, at any
      // stage of INDstocks' status vocabulary (QUEUED/O-PENDING/SL-PENDING/
      // PROCESSING/INITIATED/MODIFIED/PENDING/PARTIALLY FILLED), not just the
      // subset a name-based regex would happen to match.
      const resting = book.filter(o => !isOrderDead(o) && !/^success$/i.test(o.status));
      for (const o of resting) {
        await cancelSmartOrder(o.id).catch(() => {});
      }
      const positions = await getPositions();
      const open = positions.filter(p => Math.abs(p.net_qty) > 0);
      for (const p of open) {
        await placeOrder({ txnType: p.net_qty > 0 ? "SELL" : "BUY", securityId: p.security_id, qty: Math.abs(p.net_qty), limitPrice: p.avg_price, remarks: "EOD_EXIT" }).catch(() => {});
      }
      const after = await getPositions();
      const stillOpen = after.filter(p => Math.abs(p.net_qty) > 0);
      if (!stillOpen.length) {
        squareOffConfirmed = true;
        tg.post(`✅ <b>EOD square-off confirmed (${now})</b> — all positions flat.`);
      } else if (now >= "15:29") {
        const names = stillOpen.map(p => `${p.symbol} x${p.net_qty}`).join(", ");
        tg.post(`🚨 <b>EOD square-off FAILED (${now})</b> — still open: ${names}. Close manually now.`);
      }
    } catch (err: any) {
      if (now >= "15:29") tg.post(`🚨 <b>EOD square-off error (${now})</b>: ${err.message}`);
    }
  });

  // ─── 15:31 — EOD P&L snapshot ────────────────────────────────────────────────
  schedule.scheduleJob({ rule: "31 15 * * 1-5", tz: "Asia/Kolkata" }, () => { eodSnapshot(); });

  // ─── 15:32 — EOD OHLC report to Telegram (OI_SNIPER channel) ────────────────
  schedule.scheduleJob({ rule: "32 15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
    try { await runEodOhlcReport(); }
    catch (err: any) {
      console.error("[EOD OHLC] Report failed:", err.message);
      tg.post(`🚨 <b>EOD OHLC report failed</b>: ${err.message}`, tg.CHAT_ID_OI_SNIPER());
    }
  });

  // ─── 15:21 — session summaries ───────────────────────────────────────────────
  schedule.scheduleJob({ rule: "21 15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
    try {
      const smcAlerts = getTodayAlerts(smcConfig);
      if (smcAlerts.length) await sendSessionSummary(smcAlerts);
    } catch (err: any) { console.error("[SMC Session Summary] Error:", err.message); }
    try {
      const vwapAlerts = getTodayAlerts(vwap930Config);
      if (vwapAlerts.length) await sendVwap930SessionSummary(vwapAlerts);
    } catch (err: any) { console.error("[VWAP930 Session Summary] Error:", err.message); }
  });

  // ─── Mongo sync — every second ───────────────────────────────────────────────
  syncInterval = setInterval(() => {
    const smc = getAllAlerts(smcConfig);
    if (smc.length) syncAlerts(smc).catch(() => {});
    const vwap = getAllAlerts(vwap930Config);
    if (vwap.length) syncVwap930Alerts(vwap).catch(() => {});
  }, 1000);

  console.log("[Scheduler] All cron jobs registered");
}

export function stopScheduler() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  schedule.gracefulShutdown().catch(() => {});
}
