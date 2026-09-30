// ─── Mongo sync ────────────────────────────────────────────────────────────────
// Ported from backend/src/services/dbSyncService.js. Upserts in-memory alerts
// into Mongo every second (see scheduler.ts) so a restart can restore today's
// state, and stores backtest results.
import { isConnected } from "@/lib/db/connect";
import Alert from "@/lib/db/models/Alert";
import Vwap930Alert from "@/lib/db/models/Vwap930Alert";
import BacktestResult from "@/lib/db/models/BacktestResult";
import Vwap930BacktestResult from "@/lib/db/models/Vwap930BacktestResult";
import type { AlertRecord } from "@/lib/strategies/types";

export async function saveAlert(alert: AlertRecord): Promise<void> {
  if (!isConnected()) return;
  try {
    const date = new Date(alert.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    await Alert.updateOne(
      { alertId: alert.id },
      { $set: {
          alertId: alert.id, date,
          tradingsymbol: alert.leg?.tradingsymbol ?? alert.tradingsymbol ?? null,
          token:      alert.leg?.token ?? null,
          direction:  alert.direction,
          strike:     alert.strike,
          expiry:     alert.expiry,
          entryTime:  alert.entryTime,
          exitTime:   alert.exitTime ?? null,
          exitedAt:   alert.exitedAt ?? null,
          spot:       alert.spot,
          concepts:   alert.concepts ?? [],
          patternZones: alert.patternZones ?? [],
          score:      alert.score,
          effScore:   alert.effScore,
          strength:   alert.strength,
          trendOk:    alert.trendOk,
          rr:         alert.rr,
          status:     alert.status,
          currentPnL: alert.currentPnL ?? 0,
          pnlPct:     alert.pnlPct ?? 0,
          peakMove:   alert.peakMove ?? 0,
          t1Hit:      alert.t1Hit ?? false,
          t1HitTime:  alert.t1HitTime ?? null,
          lastLtp:    alert.lastLtp ?? null,
          createdAt:  alert.createdAt,
          updatedAt:  new Date(),
      } },
      { upsert: true },
    );
  } catch (err: any) {
    console.error("[MongoDB] saveAlert error:", err.message);
  }
}

export async function syncAlerts(alerts: AlertRecord[]): Promise<void> {
  if (!isConnected() || !alerts.length) return;
  await Promise.all(alerts.map(saveAlert));
}

export async function saveBacktest(result: any): Promise<void> {
  if (!isConnected()) return;
  try {
    await BacktestResult.updateOne(
      { date: result.date, expiry: result.expiry },
      { $set: { ...result, runAt: new Date() } },
      { upsert: true },
    );
    console.log(`[MongoDB] Backtest saved — ${result.date} ${result.expiry}`);
  } catch (err: any) {
    console.error("[MongoDB] saveBacktest error:", err.message);
  }
}

export async function saveVwap930Alert(alert: AlertRecord): Promise<void> {
  if (!isConnected()) return;
  try {
    const date = new Date(alert.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    await Vwap930Alert.updateOne(
      { alertId: alert.id },
      { $set: {
          alertId: alert.id, date,
          tradingsymbol: alert.leg?.tradingsymbol ?? alert.tradingsymbol ?? null,
          token:      alert.leg?.token ?? null,
          direction:  alert.direction,
          strike:     alert.strike,
          expiry:     alert.expiry,
          entryTime:  alert.entryTime,
          exitTime:   alert.exitTime ?? null,
          exitedAt:   alert.exitedAt ?? null,
          spot:       alert.spot,
          vwap:       alert.vwap,
          vwapCE:     alert.vwapCE,
          vwapPE:     alert.vwapPE,
          entryReason: alert.entryReason ?? null,
          rr:         alert.rr,
          status:     alert.status,
          currentPnL: alert.currentPnL ?? 0,
          pnlPct:     alert.pnlPct ?? 0,
          peakMove:   alert.peakMove ?? 0,
          lastLtp:    alert.lastLtp ?? null,
          createdAt:  alert.createdAt,
          updatedAt:  new Date(),
      } },
      { upsert: true },
    );
  } catch (err: any) {
    console.error("[MongoDB] saveVwap930Alert error:", err.message);
  }
}

export async function syncVwap930Alerts(alerts: AlertRecord[]): Promise<void> {
  if (!isConnected() || !alerts.length) return;
  await Promise.all(alerts.map(saveVwap930Alert));
}

export async function saveVwap930Backtest(result: any): Promise<void> {
  if (!isConnected()) return;
  try {
    await Vwap930BacktestResult.updateOne(
      { date: result.date, expiry: result.expiry },
      { $set: { ...result, runAt: new Date() } },
      { upsert: true },
    );
    console.log(`[MongoDB] VWAP930 backtest saved — ${result.date} ${result.expiry}`);
  } catch (err: any) {
    console.error("[MongoDB] saveVwap930Backtest error:", err.message);
  }
}
