// ─── SMC Telegram templates ────────────────────────────────────────────────────
// Ported from the SMC-specific message builders in backend/src/services/telegramService.js.
import { post, postChunked, exitReason, ORDER_QTY } from "./telegramService";
import { NUM_LOTS } from "@/lib/strategies/constants";
import type { AlertRecord, BacktestSummary } from "@/lib/strategies/types";
import type { Position } from "@/lib/runtime/autoTrade";

export function sendSMCAlert(alert: AlertRecord) {
  post([
    `<b>${alert.strike} ${alert.direction}</b>`, ``,
    `Entry Time : ${alert.entryTime}`,
    `Entry      : ${alert.rr.entry} RS`,
    `SL         : ${alert.rr.sl} RS`,
    `Target 1   : ${alert.rr.target1} RS`,
    `Target 2   : ${alert.rr.target2} RS`,
  ].join("\n"));
}

export function sendResultAlert(alert: AlertRecord) {
  const t1Hit = alert.t1Hit || alert.status === "TARGET";
  const t2Hit = alert.status === "TARGET";
  const t1Str = t1Hit ? `Hit ✅${alert.t1HitTime ? `  (${alert.t1HitTime})` : ""}` : "Not Hit ❌";
  const t2Str = t2Hit ? `Hit ✅${alert.exitTime ? `  (${alert.exitTime})` : ""}` : "Not Hit ❌";
  const lotPnl = alert.currentPnL * ORDER_QTY;
  const sign = lotPnl >= 0 ? "+" : "-";
  post([
    `<b>${alert.strike} ${alert.direction}</b>`, ``,
    `Entry Time : ${alert.entryTime}`,
    `Exit Time  : ${alert.exitTime ?? "—"}  (${exitReason(alert.status)})`, ``,
    `Target 1   : ${t1Str}`,
    `Target 2   : ${t2Str}`,
    `P&L        : <b>${sign}${Math.abs(lotPnl).toFixed(0)} RS</b>`,
  ].join("\n"));
}

export async function sendBacktestResults(data: BacktestSummary) {
  const { results = [], date, expiry, wins = 0, losses = 0, eod = 0, winRate } = data;
  if (!results.length) {
    await post(`📊 <b>SMC BACKTEST — ${date}</b>\n\nNo signals found for this date.\nExpiry: ${expiry}`);
    return;
  }
  const wrStr = winRate !== null ? `${winRate}%` : "—";
  const totalLot = results.reduce((s, r) => s + (r.currentPnL ?? 0) * ORDER_QTY, 0);
  const totalLotStr = `${totalLot >= 0 ? "+" : "−"}₹${Math.abs(totalLot).toFixed(0)}`;

  await post([
    `📊 <b>SMC BACKTEST RESULTS — ${date}</b>`,
    `📅 Expiry : ${expiry}`, ``,
    `📈 Signals     : ${results.length}`,
    `🎯 TARGET      : ${wins}`,
    `🛑 SL HIT      : ${losses}`,
    `🕐 EOD/Open    : ${eod}`,
    `🏆 Win Rate    : <b>${wrStr}</b>`,
    `📦 LOT P&L     : <b>${totalLotStr}</b>`,
  ].join("\n"));

  const tradeLines: string[] = [`📋 <b>TRADE LOG — ${date}</b>`, ``];
  results.forEach((r, i) => {
    const lotPnl = (r.currentPnL ?? 0) * ORDER_QTY;
    tradeLines.push(
      `${i + 1}. <b>${r.strike} ${r.direction}</b>`,
      `Entry ${r.entryTime} → Exit ${r.exitTime ?? "—"} (${exitReason(r.status)})`,
      `P&L: <b>${lotPnl >= 0 ? "+" : "-"}${Math.abs(lotPnl).toFixed(0)} RS</b>`, ``,
    );
  });
  await postChunked(tradeLines);
}

export async function sendSessionSummary(todayAlerts: AlertRecord[]) {
  const closed = todayAlerts.filter(a => a.status !== "ACTIVE");
  if (!closed.length) return;
  // A profitable TIME_EXIT is a win too — matches the convention used
  // everywhere else this figure is shown (StrategyTableView, results/journal
  // pages, the live status stat).
  const wins = closed.filter(a => a.status === "TARGET" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) >= 0)).length;
  const totalLot = closed.reduce((s, a) => s + (a.currentPnL ?? 0) * ORDER_QTY, 0);
  const lines = [
    `📊 <b>SMC SESSION ENDED</b>`, ``,
    `Trades: ${closed.length} | Win ${wins} Loss ${closed.length - wins}`,
    `Total P&L: <b>${totalLot >= 0 ? "+" : "-"}${Math.abs(totalLot).toFixed(0)} RS</b>`, ``,
  ];
  closed.forEach((a, i) => lines.push(`${i + 1}. <b>${a.strike} ${a.direction}</b> ${a.entryTime}→${a.exitTime ?? "—"} (${exitReason(a.status)})`));
  await postChunked(lines);
}

export function sendAutoTradeStarted() {
  post(`🟢 <b>SMC AUTO TRADE — STARTED</b>\n\n<i>Live SMC alerts will now place real orders.</i>`);
}
export function sendAutoTradeStopped() {
  post(`🔴 <b>SMC AUTO TRADE — STOPPED</b>\n\n<i>No new orders will be placed.</i>`);
}
export function sendAutoTradeOrder(pos: Position, type: "ENTRY" | "EXIT" | "ERROR") {
  const emoji = type === "ENTRY" ? "📥" : type === "EXIT" ? "📤" : "⚠️";
  const lines = [
    `${emoji} <b>SMC AUTO TRADE ${type} — ${pos.tradingsymbol}</b>`, ``,
    `📊 Direction : ${pos.direction}`,
    `💰 Entry     : ₹${pos.rr.entry?.toFixed(2) ?? "—"}`,
    `🛑 SL        : ₹${pos.rr.sl?.toFixed(2) ?? "—"}`,
  ];
  if (type === "ENTRY") lines.push(``, `📋 Order : ${pos.entryOrderId ?? "—"}`, `📋 SL    : ${pos.slChildOrderId ?? "—"}`);
  else if (type === "EXIT") lines.push(``, `📋 Exit  : ${pos.exitOrderId ?? "—"}`, `📊 Status: ${pos.status}`);
  else lines.push(``, `❌ ${pos.logs?.[pos.logs.length - 1] ?? "Unknown error"}`);
  post(lines.join("\n"));
}
