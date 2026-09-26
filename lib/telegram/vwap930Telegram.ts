// ─── VWAP 9:30 Telegram templates ──────────────────────────────────────────────
// Ported from backend/src/services/vwap930Telegram.js.
import { post, postChunked, exitReason } from "./telegramService";
import { LOT_SIZE, VWAP930_NUM_LOTS, VWAP930_SL_PCT, VWAP930_TARGET_PCT } from "@/lib/strategies/constants";
import type { AlertRecord, BacktestSummary } from "@/lib/strategies/types";
import type { Position } from "@/lib/runtime/autoTrade";

const ORDER_QTY = LOT_SIZE * VWAP930_NUM_LOTS;

export function sendVwap930Alert(alert: AlertRecord) {
  post([
    `🎯 <b>VWAP 9:30 — ${alert.strike} ${alert.direction}</b>`, ``,
    `Entry Time : ${alert.entryTime}`,
    `Entry      : ${alert.rr.entry} RS`,
    `VWAP       : ${alert.vwap} RS`,
    `SL (−${VWAP930_SL_PCT}%)   : ${alert.rr.sl} RS`,
    `Target(+${VWAP930_TARGET_PCT}%): ${alert.rr.target} RS`,
  ].join("\n"));
}

export function sendVwap930Result(alert: AlertRecord) {
  const lotPnl = alert.currentPnL * ORDER_QTY;
  post([
    `<b>VWAP 9:30 — ${alert.strike} ${alert.direction}</b>`, ``,
    `Entry Time : ${alert.entryTime}`,
    `Exit Time  : ${alert.exitTime ?? "—"}  (${exitReason(alert.status)})`,
    `P&L        : <b>${lotPnl >= 0 ? "+" : "-"}${Math.abs(lotPnl).toFixed(0)} RS</b>`,
  ].join("\n"));
}

export async function sendVwap930BacktestResults(data: BacktestSummary) {
  const { results = [], date, expiry } = data;
  if (!results.length) {
    await post(`📊 <b>VWAP 9:30 BACKTEST — ${date}</b>\n\nNo qualifying signal for this date.\nExpiry: ${expiry}`);
    return;
  }
  const lines = [`📊 <b>VWAP 9:30 BACKTEST — ${date}</b>`, `📅 Expiry : ${expiry}`];
  results.forEach((r, i) => {
    const lotPnl = (r.currentPnL ?? 0) * ORDER_QTY;
    lines.push(``,
      `<b>${i > 0 ? `Re-entry ${i + 1}: ` : ""}${r.strike} ${r.direction}</b>`,
      `Entry ${r.entryTime} → Exit ${r.exitTime ?? "—"} (${exitReason(r.status)})`,
      `P&L: <b>${lotPnl >= 0 ? "+" : "-"}${Math.abs(lotPnl).toFixed(0)} RS</b>`);
  });
  await postChunked(lines);
}

export async function sendVwap930SessionSummary(todayAlerts: AlertRecord[]) {
  const closed = todayAlerts.filter(a => a.status !== "ACTIVE");
  if (!closed.length) return;
  const lines = [`📊 <b>VWAP 9:30 — SESSION ENDED</b>`, ``];
  let totalLotPnl = 0;
  closed.forEach((a, i) => {
    const lotPnl = (a.currentPnL ?? 0) * ORDER_QTY;
    totalLotPnl += lotPnl;
    lines.push(`${i > 0 ? "Re-entry: " : ""}<b>${a.strike} ${a.direction}</b> ${a.entryTime}→${a.exitTime ?? "—"} (${exitReason(a.status)})`,
      `P&L: <b>${lotPnl >= 0 ? "+" : "-"}${Math.abs(lotPnl).toFixed(0)} RS</b>`);
  });
  if (closed.length > 1) lines.push(``, `Day total: <b>${totalLotPnl >= 0 ? "+" : "-"}${Math.abs(totalLotPnl).toFixed(0)} RS</b>`);
  await postChunked(lines);
}

export function sendVwap930AutoTradeStarted() {
  post(`🟢 <b>VWAP 9:30 AUTO TRADE — STARTED</b>\n\n<i>Live VWAP 9:30 signals will place real orders.</i>`);
}
export function sendVwap930AutoTradeStopped() {
  post(`🔴 <b>VWAP 9:30 AUTO TRADE — STOPPED</b>\n\n<i>No new orders will be placed.</i>`);
}
export function sendVwap930AutoTradeOrder(pos: Position, type: "ENTRY" | "EXIT" | "ERROR") {
  const emoji = type === "ENTRY" ? "📥" : type === "EXIT" ? "📤" : "⚠️";
  const lines = [
    `${emoji} <b>VWAP 9:30 AUTO TRADE ${type} — ${pos.tradingsymbol}</b>`, ``,
    `📊 Direction : ${pos.direction}`,
    `💰 Entry     : ₹${pos.rr.entry?.toFixed(2) ?? "—"}`,
    `🛑 SL        : ₹${pos.rr.sl?.toFixed(2) ?? "—"}`,
    `🎯 Target    : ₹${(pos.rr as any).target?.toFixed(2) ?? "—"}`,
  ];
  if (type === "ENTRY") lines.push(``, `📋 Order : ${pos.entryOrderId ?? "—"}`, `📋 SL    : ${pos.slChildOrderId ?? "—"}`);
  else if (type === "EXIT") lines.push(``, `📋 Exit  : ${pos.exitOrderId ?? "—"}`, `📊 Status: ${pos.status}`);
  else lines.push(``, `❌ ${pos.logs?.[pos.logs.length - 1] ?? "Unknown error"}`);
  post(lines.join("\n"));
}
