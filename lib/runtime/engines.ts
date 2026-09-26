// ─── Strategy engine instances ────────────────────────────────────────────────
// Binds the generic alertStore/autoTrade machinery to each strategy's specific
// scan/backtest/pnl functions, Mongo models and Telegram templates — the thin
// per-strategy layer that replaces the Kite app's duplicated route files.
import { runSMCScan, runHistoricalSMCScan, updateAlertPnL as updateSMCAlertPnL } from "@/lib/strategies/smc";
import { runVWAP930Scan, runHistoricalVWAP930Scan, updateAlertPnL as updateVwap930AlertPnL, isAfterEntryStart } from "@/lib/strategies/vwap930";
import { SMC_MAX_TRADES_PER_DAY, SMC_REENTRY_COOLDOWN_MIN, SMC_BREAKEVEN_TRIGGER_PCT,
         VWAP930_MAX_TRADES_PER_DAY, VWAP930_REENTRY_COOLDOWN_MIN, VWAP930_BREAKEVEN_TRIGGER_PCT } from "@/lib/strategies/constants";
import Alert from "@/lib/db/models/Alert";
import Vwap930Alert from "@/lib/db/models/Vwap930Alert";
import BacktestResult from "@/lib/db/models/BacktestResult";
import Vwap930BacktestResult from "@/lib/db/models/Vwap930BacktestResult";
import { saveAlert, saveBacktest, saveVwap930Alert, saveVwap930Backtest } from "./dbSync";
import * as smcTg from "@/lib/telegram/smcTelegram";
import * as vwapTg from "@/lib/telegram/vwap930Telegram";
import type { StoreConfig } from "./alertStore";

export const smcConfig: StoreConfig = {
  key: "smc", label: "SMC",
  maxAlerts: 100, maxTradesPerDay: SMC_MAX_TRADES_PER_DAY, reentryCooldownMin: SMC_REENTRY_COOLDOWN_MIN,
  breakevenDefaultPct: SMC_BREAKEVEN_TRIGGER_PCT, dedupCooldownMs: 3 * 60 * 1000,
  // Matches backend/src/routes/smc.js's /status route exactly: scanning runs
  // 09:21–15:00 (the upper bound of "market open" already caps it at 15:30).
  isScanActive: (h, m) => h > 9 || (h === 9 && m >= 21),
  scanFn: runSMCScan, backtestFn: runHistoricalSMCScan, updateAlertPnLFn: updateSMCAlertPnL,
  targetField: "target2", Model: Alert, BacktestModel: BacktestResult,
  saveAlert, saveBacktest,
  telegram: {
    sendAlert: smcTg.sendSMCAlert, sendResult: smcTg.sendResultAlert, sendBacktestResults: smcTg.sendBacktestResults,
    sendAutoTradeStarted: smcTg.sendAutoTradeStarted, sendAutoTradeStopped: smcTg.sendAutoTradeStopped,
    sendAutoTradeOrder: smcTg.sendAutoTradeOrder,
  },
};

export const vwap930Config: StoreConfig = {
  key: "vwap930", label: "VWAP930",
  maxAlerts: 50, maxTradesPerDay: VWAP930_MAX_TRADES_PER_DAY, reentryCooldownMin: VWAP930_REENTRY_COOLDOWN_MIN,
  breakevenDefaultPct: VWAP930_BREAKEVEN_TRIGGER_PCT, dedupCooldownMs: null,
  isValidEntryTime: (entryTime) => {
    const m = /^(\d{2}):(\d{2})$/.exec(entryTime);
    return !!m && isAfterEntryStart(Number(m[1]), Number(m[2]));
  },
  isScanActive: isAfterEntryStart,
  scanFn: runVWAP930Scan, backtestFn: runHistoricalVWAP930Scan, updateAlertPnLFn: updateVwap930AlertPnL,
  targetField: "target", Model: Vwap930Alert, BacktestModel: Vwap930BacktestResult,
  saveAlert: saveVwap930Alert, saveBacktest: saveVwap930Backtest,
  telegram: {
    sendAlert: vwapTg.sendVwap930Alert, sendResult: vwapTg.sendVwap930Result, sendBacktestResults: vwapTg.sendVwap930BacktestResults,
    sendAutoTradeStarted: vwapTg.sendVwap930AutoTradeStarted, sendAutoTradeStopped: vwapTg.sendVwap930AutoTradeStopped,
    sendAutoTradeOrder: vwapTg.sendVwap930AutoTradeOrder,
  },
};
