// ─── Alert store ──────────────────────────────────────────────────────────────
// One generic, parameterized store used by both SMC and VWAP930 — the Kite app
// had two 350-line near-duplicates (routes/smc.js, routes/vwap930.js) that
// differed only in constants, dedup rules and which Mongo model/Telegram
// templates they called.
//
// State (alerts array, activeTokenIndex, scanRunning, lastScanAt) is anchored
// on globalThis, not module scope — the now-familiar reason: the scanner
// (instrumentation graph) and the API routes (route graph) are separate copies
// of any plain module-level variable, and a scan result created in one graph
// would be invisible to a GET request served by the other.
import { hasToken } from "@/lib/broker/auth";
import { getOptionChain } from "@/lib/broker/marketdata";
import { getLotSize } from "@/lib/broker/instruments";
import { isConnected } from "@/lib/db/connect";
import { getCached } from "./settingsService";
import * as autoTradeEngine from "./autoTrade";
import type { EngineConfig } from "./autoTrade";
import type { AlertRecord, BacktestSummary, ScanResult } from "@/lib/strategies/types";
import type { Model } from "mongoose";

export type StrategyKey = "smc" | "vwap930";

export type StoreConfig = {
  key: StrategyKey;
  label: string;
  maxAlerts: number;
  maxTradesPerDay: number;
  reentryCooldownMin: number;
  breakevenDefaultPct: number;
  /** SMC dedups by strike+direction within a cooldown; VWAP930 has no such
   *  rule (its own candle-close gate already prevents duplicate signals). */
  dedupCooldownMs: number | null;
  /** VWAP930-only: reject a Mongo-restored alert whose entryTime predates the
   *  current entry-start rule (guards against stale/bad test data). */
  isValidEntryTime?: (entryTime: string) => boolean;
  /** Whether the scanner is inside its entry window right now (IST hour/min) —
   *  SMC: 09:21–15:30; VWAP930: after its own entry-start gate. Drives the
   *  "SCANNING" pill in StrategyTableView, matching the old app's
   *  status route exactly (smc.js / vwap930.js). */
  isScanActive: (h: number, m: number) => boolean;
  scanFn: (expiry: string) => Promise<ScanResult>;
  backtestFn: (date: string, expiry: string) => Promise<BacktestSummary>;
  updateAlertPnLFn: (alert: AlertRecord, ltp: number) => AlertRecord;
  /** VWAP930-only: rebuild `entryReason` for an alert saved before it existed. */
  rebuildReasonFn?: (alert: AlertRecord) => Promise<AlertRecord["entryReason"] | null>;
  targetField: "target2" | "target";
  Model: Model<any>;
  BacktestModel: Model<any>;
  saveAlert: (alert: AlertRecord) => Promise<void>;
  saveBacktest: (result: BacktestSummary) => Promise<void>;
  telegram: {
    sendAlert: (a: AlertRecord) => void;
    sendResult: (a: AlertRecord) => void;
    sendBacktestResults: (r: BacktestSummary) => Promise<void>;
    sendAutoTradeStarted: () => void;
    sendAutoTradeStopped: () => void;
    sendAutoTradeOrder: (pos: any, kind: "ENTRY" | "EXIT" | "ERROR") => void;
  };
};

type Store = {
  alerts: AlertRecord[];
  lastScanAt: string | null;
  scanRunning: boolean;
  lastMongoSync: number;
  activeTokenIndex: Map<number, string>;
};

function state(key: StrategyKey): Store {
  const g = globalThis as any;
  g.__INDMONEY_ALERTS__ ??= {};
  g.__INDMONEY_ALERTS__[key] ??= {
    alerts: [], lastScanAt: null, scanRunning: false, lastMongoSync: 0, activeTokenIndex: new Map(),
  } satisfies Store;
  return g.__INDMONEY_ALERTS__[key];
}

function todayIST(): string {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

// "TIME_PROFIT" only exists on OLD records from before the strategies were
// refactored to a single "TIME_EXIT" status (win/loss then read off the sign
// of currentPnL) — matches the same convention already used client-side in
// StrategyTableView.tsx/journal/page.tsx/results/page.tsx. Without the
// TIME_EXIT branch here, every current profitable 15:20 time-exit silently
// counted as a loss in the live WIN RATE stat.
function isWinAlert(a: AlertRecord): boolean {
  return a.status === "TARGET" || (a.status as string) === "TIME_PROFIT"
    || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) >= 0);
}

function engineConfig(cfg: StoreConfig): EngineConfig {
  return {
    key: cfg.key, label: cfg.label,
    numLotsDefault: cfg.key === "smc" ? 10 : 10,
    targetField: cfg.targetField,
    telegram: {
      sendStarted: cfg.telegram.sendAutoTradeStarted,
      sendStopped: cfg.telegram.sendAutoTradeStopped,
      sendOrder: cfg.telegram.sendAutoTradeOrder,
    },
  };
}

function isDuplicate(cfg: StoreConfig, alert: AlertRecord): boolean {
  if (cfg.dedupCooldownMs == null) return false;
  const s = state(cfg.key);
  const key = `${alert.direction}_${alert.strike}`;
  const now = Date.now();
  return s.alerts.some(a => `${a.direction}_${a.strike}` === key && (now - new Date(a.createdAt).getTime()) < cfg.dedupCooldownMs!);
}

/** The single place that decides ACTIVE → exit, called from both the cron/poll
 *  path and (once wired) a tick monitor. Synchronous status flip means
 *  whichever caller gets here first wins — no double-exit race. */
function applyLtpToAlert(cfg: StoreConfig, idx: number, ltp: number, source: string) {
  const s = state(cfg.key);
  const a = s.alerts[idx];
  if (!a || a.status !== "ACTIVE") return;

  const updated = cfg.updateAlertPnLFn(a, ltp);
  s.alerts[idx] = { ...updated, leg: a.leg ? { ...a.leg, ltp } : a.leg };

  if (updated.breakevenJustTriggered) {
    console.log(`[${cfg.label}][${source}] Breakeven — ${a.id} SL → entry ₹${updated.rr.entry} @ ₹${ltp}`);
    autoTradeEngine.moveSLToBreakeven(engineConfig(cfg), updated).catch(() => {});
  }
  if (updated.status !== "ACTIVE") {
    if (a.leg?.token) s.activeTokenIndex.delete(a.leg.token);
    console.log(`[${cfg.label}][${source}] Exit — ${a.id} ${updated.status} @ ₹${ltp}`);
    cfg.telegram.sendResult(updated);
    autoTradeEngine.executeExit(engineConfig(cfg), updated).catch(() => {});
  }
}

export function handleTick(cfg: StoreConfig, token: number, ltp: number) {
  const s = state(cfg.key);
  const alertId = s.activeTokenIndex.get(token);
  if (!alertId) return;
  const idx = s.alerts.findIndex(a => a.id === alertId);
  if (idx === -1) { s.activeTokenIndex.delete(token); return; }
  applyLtpToAlert(cfg, idx, ltp, "tick");
}

async function refreshActivePnL(cfg: StoreConfig, expiry: string) {
  const s = state(cfg.key);
  const active = s.alerts.filter(a => a.status === "ACTIVE");
  if (!active.length || !hasToken()) return;
  try {
    const lotSize = await getLotSize("NIFTY").catch(() => 0);
    const chain = await getOptionChain(expiry, 15, "NIFTY", lotSize);
    for (let idx = 0; idx < s.alerts.length; idx++) {
      const a = s.alerts[idx];
      if (a.status !== "ACTIVE") continue;
      const row = chain.rows.find(r => r.strike === a.strike);
      const leg = a.direction === "CE" ? row?.ce : row?.pe;
      if (!leg) continue;
      applyLtpToAlert(cfg, idx, leg.ltp, "poll");
    }
  } catch { /* keep stale data rather than crash the scan */ }
}

export async function doScan(cfg: StoreConfig, expiry: string): Promise<void> {
  const s = state(cfg.key);
  if (s.scanRunning) return;
  if (!hasToken()) return;
  s.scanRunning = true;
  s.lastScanAt = new Date().toISOString();

  try {
    await refreshActivePnL(cfg, expiry);

    const hasOpenAlert = s.alerts.some(a => a.status === "ACTIVE");
    const hasOpenTrade = autoTradeEngine.getPositionsList(cfg.key).some(p => p.status === "ACTIVE" || p.status === "ENTRY_PLACED" || p.status === "EXITING");
    if (hasOpenAlert || hasOpenTrade) return;

    const today = todayIST();
    const todaysAlerts = s.alerts.filter(a => new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) === today);
    if (todaysAlerts.length >= cfg.maxTradesPerDay) return;
    if (todaysAlerts.length >= 1 && !(todaysAlerts[0].currentPnL < 0)) return; // last trade wasn't a loss — no re-entry
    if (todaysAlerts.length >= 1 && todaysAlerts[0].exitedAt) {
      const minsSinceExit = (Date.now() - new Date(todaysAlerts[0].exitedAt).getTime()) / 60_000;
      if (minsSinceExit < cfg.reentryCooldownMin) return;
    }

    const result = await cfg.scanFn(expiry);
    if (!("signal" in result) || !result.signal) return;

    const alert = result as unknown as AlertRecord;
    if (isDuplicate(cfg, alert)) { console.log(`[${cfg.label}] Duplicate suppressed`); return; }

    alert.breakevenTriggerPct = getCached().accountDefaults.breakevenTriggerPct ?? cfg.breakevenDefaultPct;
    s.alerts.unshift(alert);
    if (s.alerts.length > cfg.maxAlerts) s.alerts.length = cfg.maxAlerts;
    if (alert.leg?.token) s.activeTokenIndex.set(alert.leg.token, alert.id);
    cfg.saveAlert(alert).catch(() => {});

    console.log(`[${cfg.label}] ✅ Alert: ${alert.direction} ${alert.strike} @ ₹${alert.rr.entry}`);
    cfg.telegram.sendAlert(alert);
    autoTradeEngine.executeEntry(engineConfig(cfg), alert).catch(() => {});
  } catch (err: any) {
    console.error(`[${cfg.label}] Scan error:`, err.message);
  } finally {
    s.scanRunning = false;
  }
}

export function getStatus(cfg: StoreConfig) {
  const s = state(cfg.key);
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  const marketOpen = day >= 1 && day <= 5 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
  const scanActive = marketOpen && cfg.isScanActive(h, m);
  const wins = s.alerts.filter(isWinAlert).length;
  const total = s.alerts.filter(a => a.status !== "ACTIVE").length;
  return {
    marketOpen, scanActive, lastScanAt: s.lastScanAt, scanRunning: s.scanRunning,
    totalAlerts: s.alerts.length,
    winRate: total > 0 ? +((wins / total) * 100).toFixed(1) : null,
    wins, losses: total - wins,
  };
}

/** One attempt per alert per process — a failed rebuild (no candles, broker
 *  error) is not retried on every page poll. */
async function backfillEntryReasons(cfg: StoreConfig) {
  if (!cfg.rebuildReasonFn || !hasToken()) return;
  const g = globalThis as any;
  const tried: Set<string> = (g.__INDMONEY_REASON_TRIED__ ??= new Set<string>());
  for (const a of state(cfg.key).alerts) {
    const id = a.id ?? a.alertId;
    if (a.entryReason || !id || tried.has(id)) continue;
    tried.add(id);
    try {
      const reason = await cfg.rebuildReasonFn(a);
      if (reason) { a.entryReason = reason; await cfg.saveAlert(a); console.log(`[${cfg.label}] Rebuilt entry reason for ${id}`); }
    } catch (e: any) {
      console.error(`[${cfg.label}] Entry-reason rebuild failed for ${id}:`, e.message);
    }
  }
}

export async function getAlerts(cfg: StoreConfig, expiry: string) {
  const s = state(cfg.key);
  const now = Date.now();
  if (isConnected() && now - s.lastMongoSync > 60_000) {
    s.lastMongoSync = now;
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const docs = await cfg.Model.find({ date: today }).sort({ createdAt: 1 }).lean();
      if (docs.length) {
        const inMemory = new Set(s.alerts.map(a => a.id ?? a.alertId));
        const missing = docs.filter((d: any) => !inMemory.has(d.alertId) && (!cfg.isValidEntryTime || cfg.isValidEntryTime(d.entryTime)));
        if (missing.length) {
          const restored: AlertRecord[] = missing.map((d: any) => ({
            id: d.alertId, alertId: d.alertId, date: d.date, direction: d.direction, strike: d.strike, expiry: d.expiry,
            entryTime: d.entryTime, exitTime: d.exitTime, exitedAt: d.exitedAt, spot: d.spot,
            concepts: d.concepts ?? [], patternZones: d.patternZones ?? [], score: d.score, effScore: d.effScore, strength: d.strength, trendOk: d.trendOk, rr: d.rr,
            status: d.status, currentPnL: d.currentPnL ?? 0, pnlPct: d.pnlPct ?? 0, peakMove: d.peakMove ?? 0,
            t1Hit: d.t1Hit, t1HitTime: d.t1HitTime, vwap: d.vwap, vwapCE: d.vwapCE, vwapPE: d.vwapPE, entryReason: d.entryReason ?? undefined,
            lastLtp: d.lastLtp, createdAt: d.createdAt, tradingsymbol: d.tradingsymbol ?? null,
            leg: d.tradingsymbol ? { tradingsymbol: d.tradingsymbol, token: d.token ?? 0, strike: d.strike, type: d.direction, ltp: d.lastLtp ?? 0 } : undefined,
          }));
          s.alerts = [...s.alerts, ...restored];
          if (s.alerts.length > cfg.maxAlerts) s.alerts.length = cfg.maxAlerts;
          for (const r of restored) if (r.status === "ACTIVE" && r.leg?.token) s.activeTokenIndex.set(r.leg.token, r.id);
          console.log(`[${cfg.label}] Synced ${missing.length} missing alerts from MongoDB`);
        }
      }
    } catch (e: any) {
      console.error(`[${cfg.label}] MongoDB sync failed:`, e.message);
    }
  }

  await refreshActivePnL(cfg, expiry).catch(() => {});
  await backfillEntryReasons(cfg);
  const wins = s.alerts.filter(isWinAlert).length;
  const total = s.alerts.filter(a => a.status !== "ACTIVE").length;
  return { alerts: s.alerts, lastScanAt: s.lastScanAt, scanRunning: s.scanRunning, winRate: total > 0 ? +((wins / total) * 100).toFixed(1) : null, wins, losses: total - wins };
}

export function clearAlerts(cfg: StoreConfig) {
  const s = state(cfg.key);
  s.alerts = [];
  s.activeTokenIndex.clear();
}

export async function runBacktest(cfg: StoreConfig, date: string, expiry: string): Promise<BacktestSummary> {
  const result = await cfg.backtestFn(date, expiry);
  cfg.telegram.sendBacktestResults(result).catch(() => {});
  cfg.saveBacktest(result).catch(() => {});
  return result;
}

export async function getBacktestFromDb(cfg: StoreConfig, date: string) {
  if (!isConnected()) throw Object.assign(new Error("MongoDB not connected"), { status: 503 });
  const doc: any = await cfg.BacktestModel.findOne({ date }).lean();
  if (!doc) return { results: [], winRate: null };
  return { results: doc.results ?? [], winRate: doc.winRate ?? null, wins: doc.wins ?? 0, losses: doc.losses ?? 0, totalSignals: doc.totalSignals ?? 0 };
}

export function getTodayAlerts(cfg: StoreConfig): AlertRecord[] {
  const s = state(cfg.key);
  const today = todayIST();
  return s.alerts.filter(a => new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) === today);
}

export function getAllAlerts(cfg: StoreConfig): AlertRecord[] {
  return state(cfg.key).alerts;
}
