// ─── EOD OHLC report ────────────────────────────────────────────────────────────
// Ported from backend/src/services/eodOhlcReport.js — runs after market close,
// takes every SMC and VWAP930 entry taken that day, pulls each leg's full-
// session minute OHLC from INDstocks, and ships two kinds of file to the
// OI_SNIPER Telegram channel: the entries table, and one OHLC CSV per entered
// leg in the exact format the OHLC tab downloads (byte-identical, verified
// against the Kite app on 2026-09-25 — see lib/telegram/candleCsv.ts).
//
// Difference from the Kite version: INDstocks historical candles have no OI,
// so the OI column is filled from lib/runtime/oiSnapshot.ts (captured live
// while a leg was subscribed in "quote" mode) rather than the candle itself —
// it will be sparse outside the minutes a trade was actually open, which is a
// real, disclosed limitation, not a bug.
import { getHistorical, scripCode } from "@/lib/broker/marketdata";
import { isConnected } from "@/lib/db/connect";
import Alert from "@/lib/db/models/Alert";
import Vwap930Alert from "@/lib/db/models/Vwap930Alert";
import { getTodayAlerts } from "@/lib/runtime/alertStore";
import { smcConfig, vwap930Config } from "@/lib/runtime/engines";
import { getOiForMinute } from "@/lib/runtime/oiSnapshot";
import { LOT_SIZE, NUM_LOTS, VWAP930_NUM_LOTS } from "@/lib/strategies/constants";
import * as tg from "@/lib/telegram/telegramService";
import { optionSymbol, ohlcFilename, buildOhlcCsv, fmtIST, calcRollingRSI } from "./candleCsv";
import type { AlertRecord } from "@/lib/strategies/types";
import type { Candle } from "@/lib/broker/types";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const SMC_QTY = LOT_SIZE * NUM_LOTS;
const VWAP_QTY = LOT_SIZE * VWAP930_NUM_LOTS;

export function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function expiryLabel(expiry: string): string {
  const [, mm, dd] = String(expiry).split("-");
  if (!mm || !dd) return expiry;
  return `${dd} ${MONTHS[Number(mm) - 1] ?? mm}`;
}

function contractLabel(e: { tradingsymbol?: string | null; expiry: string; strike: number; direction: string }): string {
  const index = /^SENSEX/i.test(e.tradingsymbol ?? "") ? "SENSEX" : "NIFTY";
  return [index, expiryLabel(e.expiry), e.strike, e.direction].filter(Boolean).join(" ");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
const num = (v: number | null | undefined, d = 2) => (v == null || Number.isNaN(Number(v)) ? "" : Number(v).toFixed(d));

type Entry = {
  strategy: "SMC" | "VWAP930"; qty: number; alertId: string; token: number | null;
  tradingsymbol: string | null; label: string; direction: string; strike: number; expiry: string;
  entryTime: string | null; exitTime: string | null; status: string; rr: any;
  pointsPnL: number; totalPnL: number; pnlPct: number | null; peakMove: number | null;
  t1Hit: boolean | null; t1HitTime: string | null; spot: number | null; vwap: number | null;
  concepts: string; createdAt: string;
};

async function collectEntries(date: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const push = (docs: any[], strategy: "SMC" | "VWAP930", qty: number) => {
    for (const d of docs) {
      const tradingsymbol = d.tradingsymbol ?? d.leg?.tradingsymbol ?? null;
      const pts = Number(d.currentPnL ?? 0);
      out.push({
        strategy, qty, alertId: d.alertId ?? d.id, token: d.token ?? d.leg?.token ?? null,
        tradingsymbol, label: contractLabel({ tradingsymbol, expiry: d.expiry, strike: d.strike, direction: d.direction }),
        direction: d.direction, strike: d.strike, expiry: d.expiry,
        entryTime: d.entryTime ?? null, exitTime: d.exitTime ?? null, status: d.status, rr: d.rr ?? {},
        pointsPnL: pts, totalPnL: pts * qty, pnlPct: d.pnlPct ?? null, peakMove: d.peakMove ?? null,
        t1Hit: d.t1Hit ?? null, t1HitTime: d.t1HitTime ?? null, spot: d.spot ?? null, vwap: d.vwap ?? null,
        concepts: Array.isArray(d.concepts) ? d.concepts.join(" + ") : "", createdAt: d.createdAt,
      });
    }
  };

  if (isConnected()) {
    const [smcDocs, vwapDocs] = await Promise.all([
      Alert.find({ date }).lean(), Vwap930Alert.find({ date }).lean(),
    ]);
    push(smcDocs, "SMC", SMC_QTY);
    push(vwapDocs, "VWAP930", VWAP_QTY);
  } else {
    push(getTodayAlerts(smcConfig) as unknown as any[], "SMC", SMC_QTY);
    push(getTodayAlerts(vwap930Config) as unknown as any[], "VWAP930", VWAP_QTY);
  }
  out.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return out;
}

async function fetchDayCandles(token: number, date: string): Promise<Candle[]> {
  try {
    const code = scripCode(token, "NIFTY");
    const from = new Date(`${date}T09:15:00+05:30`);
    const to   = new Date(`${date}T15:30:00+05:30`);
    const map  = await getHistorical([code], "1minute", from, to, "NIFTY");
    return map[code] ?? [];
  } catch (err: any) {
    console.error(`[EOD OHLC] Candle fetch failed for token ${token}: ${err.message}`);
    return [];
  }
}

function dayOHLC(candles: Candle[]) {
  if (!candles.length) return null;
  return {
    open: candles[0].open, high: Math.max(...candles.map(c => c.high)), low: Math.min(...candles.map(c => c.low)),
    close: candles[candles.length - 1].close, volume: candles.reduce((s, c) => s + (c.volume ?? 0), 0),
  };
}

/** Merges the live OI snapshot into each candle by IST minute — historical
 *  candles carry no OI at all, so this is the only source available. */
function withOi(candles: Candle[], token: number): Candle[] {
  return candles.map(c => {
    const hhmm = fmtIST(c.date).slice(-5);
    return { ...c, oi: getOiForMinute(token, hhmm) };
  });
}

export async function runEodOhlcReport({ date = todayIST(), chatId = tg.CHAT_ID_OI_SNIPER() }: { date?: string; chatId?: string } = {}) {
  const entries = await collectEntries(date);

  if (!entries.length) {
    console.log(`[EOD OHLC] ${date} — no SMC/VWAP930 entries, nothing to send`);
    await tg.post(`📭 <b>EOD OHLC REPORT — ${date}</b>\n\nNo SMC or VWAP930 entries today.`, chatId);
    return { date, entries: 0, sent: false };
  }

  const candlesByToken = new Map<number, Candle[]>();
  for (const token of new Set(entries.map(e => e.token).filter((t): t is number => t != null))) {
    candlesByToken.set(token, withOi(await fetchDayCandles(token, date), token));
  }

  const entriesHeader = [
    "Strategy", "Contract", "Symbol", "Direction", "Strike", "Expiry",
    "Entry Time", "Entry", "SL", "Target 1", "Target 2", "Exit Time", "Exit Reason", "Status",
    "T1 Hit", "T1 Hit Time", "Points P&L", "Qty", "Total P&L", "P&L %", "Peak Move",
    "Spot At Entry", "VWAP At Entry", "Concepts", "Day Open", "Day High", "Day Low", "Day Close", "Day Volume",
  ];
  const entriesRows = entries.map(e => {
    const d = dayOHLC(candlesByToken.get(e.token!) ?? []);
    return [
      e.strategy, e.label, e.tradingsymbol, e.direction, e.strike, e.expiry,
      e.entryTime, num(e.rr.entry), num(e.rr.sl), num(e.rr.target1 ?? e.rr.target), num(e.rr.target2 ?? e.rr.target),
      e.exitTime ?? "", e.status === "ACTIVE" ? "Still Open" : tg.exitReason(e.status), e.status,
      e.t1Hit === null ? "" : e.t1Hit ? "Yes" : "No", e.t1HitTime ?? "",
      num(e.pointsPnL), e.qty, num(e.totalPnL, 0), num(e.pnlPct), num(e.peakMove),
      num(e.spot), num(e.vwap), e.concepts,
      d ? num(d.open) : "", d ? num(d.high) : "", d ? num(d.low) : "", d ? num(d.close) : "", d ? d.volume : "",
    ];
  });

  const ohlcFiles: { filename: string; label: string; candles: number; buffer: Buffer }[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    if (!e.token || seen.has(e.token)) continue;
    seen.add(e.token);
    const candles = candlesByToken.get(e.token) ?? [];
    if (!candles.length) continue;
    const symbol = optionSymbol(e.expiry, e.strike, e.direction);
    ohlcFiles.push({ filename: ohlcFilename(date, symbol), label: e.label, candles: candles.length, buffer: Buffer.from(buildOhlcCsv(candles), "utf8") });
  }

  const smc = entries.filter(e => e.strategy === "SMC");
  const vwap = entries.filter(e => e.strategy === "VWAP930");
  const totalPnL = entries.reduce((s, e) => s + e.totalPnL, 0);
  const sign = totalPnL >= 0 ? "+" : "-";
  const caption = [
    `📊 <b>EOD OHLC REPORT — ${date}</b>`, ``,
    `SMC      : ${smc.length} entr${smc.length === 1 ? "y" : "ies"}`,
    `VWAP930  : ${vwap.length} entr${vwap.length === 1 ? "y" : "ies"}`,
    `Total P&L: <b>${sign}${Math.abs(totalPnL).toFixed(0)} RS</b>`, ``,
    ...entries.map(e => `• [${e.strategy}] ${e.label} — ${e.entryTime}→${e.exitTime ?? "open"}  ${e.totalPnL >= 0 ? "+" : "-"}${Math.abs(e.totalPnL).toFixed(0)} RS`),
  ].join("\n");

  const entriesCsv = Buffer.from(toCsv(entriesHeader, entriesRows), "utf8");
  const okEntries = await tg.sendDocument(entriesCsv, `Entries_${date}.csv`, caption, { chatId });

  let sentOhlc = 0;
  for (const f of ohlcFiles) {
    const ok = await tg.sendDocument(f.buffer, f.filename, `🕯 <b>${f.label}</b> — ${date}\n${f.candles} minute candles`, { chatId });
    if (ok) sentOhlc++;
  }

  console.log(`[EOD OHLC] ${date} — ${entries.length} entries, ${sentOhlc}/${ohlcFiles.length} OHLC file(s) sent (entries table: ${okEntries})`);
  return { date, entries: entries.length, ohlcFiles: ohlcFiles.map(f => f.filename), sent: okEntries };
}
