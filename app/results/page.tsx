"use client";

// ─── Results tab ────────────────────────────────────────────────────────────────
// Full port of frontend/components/ResultsContent.tsx: same calendar view
// (month-grid P&L heatmap, holiday-amber cells, click a day to jump into the
// table for that date) AND the same rich table view — mobile cards (direction
// badge, concept pills, T1/T2 badges, 3-col ENTRY/SL/LOT-P&L footer) and the
// dense 13-column desktop table (concepts, entry/SL/T1/T2, status, P&L,
// charges, max points/profits) with the matching 8-col footer stats strip.
import { useEffect, useMemo, useState } from "react";
import { LOT_SIZE, NUM_LOTS } from "@/lib/strategies/constants";
import { useTheme } from "@/lib/theme";
import { useAccountQty } from "@/lib/useAccountQty";

const MONO = { fontFamily: "'Inter', sans-serif" } as const;
const BEBAS = { fontFamily: "'Inter', sans-serif" } as const;
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
type Strategy = "smc" | "vwap930";
type Tab = "backtest" | "live";
type Row = Record<string, string>;
type DaySummary = { date: string; totalPnL: number; trades: number; wins: number };

function fmtLotPnl(n: number) {
  const abs = Math.abs(n);
  const s = n >= 0 ? "+" : "−";
  return abs >= 100000 ? `${s}₹${(abs / 100000).toFixed(2)}L` : abs >= 1000 ? `${s}₹${(abs / 1000).toFixed(1)}K` : `${s}₹${abs.toFixed(0)}`;
}
function indianGroup(int: string): string {
  if (int.length <= 3) return int;
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}
function fmtLotPnlFull(n: number) {
  const sign = n >= 0 ? "+" : "−";
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${sign}₹${indianGroup(int)}.${dec}`;
}
function pnlColor(p: number) { return p >= 0 ? "#22c55e" : "#ef4444"; }
function dirColor(d: string) { return d === "CE" ? "#0284c7" : "#e11d48"; }
function fmtTime(t: string) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}
function fmtFull(n: number) {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${indianGroup(int)}.${dec}`;
}
// INDstocks' real F&O charge structure (verified against GET /margin and
// https://api-docs.indstocks.com/margin_calculation/ — same rates
// lib/runtime/accountService.ts's estimateCharges() uses for the Account
// tab): ₹10 flat brokerage per order (₹20 round-trip), STT 0.1% sell-side
// only, exchange 0.03503%, SEBI ₹10/crore, stamp duty 0.003% buy-side only,
// GST 18% on brokerage+exchange only. NOT Zerodha's ₹20/order + 0.0625% STT.
function calcCharges(entryPrice: number, exitPrice: number, qty: number): number {
  const turnover = (entryPrice + exitPrice) * qty;
  const brokerage = 20; // ₹10 × 2 orders (entry + exit)
  const exchange = turnover * 0.0003503;
  const sebi = turnover * 0.0000001;
  const stt = exitPrice * qty * 0.001; // sell-side only
  const stamp = entryPrice * qty * 0.00003; // buy-side only
  const gst = (brokerage + exchange) * 0.18;
  return brokerage + stt + exchange + sebi + gst + stamp;
}
const STATUS_COLOR: Record<string, string> = { TARGET: "#22c55e", TIME_PROFIT: "#22c55e", SL: "#ef4444", TIME_EXIT: "#ef4444", EOD: "#94a3b8", ACTIVE: "#60a5fa" };
const COLS_DESKTOP = "40px 140px minmax(100px, 1fr) 100px 76px 76px 76px 76px 96px 150px 96px 70px 130px";

function buildCalendar(year: number, month: number): (number | null)[] {
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function ResultsPage() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const acctQty = useAccountQty(NUM_LOTS);
  const LOT_QTY = LOT_SIZE * acctQty;
  const [tab, setTab] = useState<Tab>("live");
  const [strategy, setStrategy] = useState<Strategy>("smc");
  const [dates, setDates] = useState<{ backtest: string[]; live: string[] }>({ backtest: [], live: [] });
  const [selDate, setSelDate] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [viewMode, setViewMode] = useState<"table" | "calendar">("calendar");
  const [summary, setSummary] = useState<DaySummary[]>([]);
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [calMonth, setCalMonth] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() + 1 }; });

  useEffect(() => {
    fetch(`/api/holidays`).then(r => r.json()).then(d => {
      const m: Record<string, string> = {};
      for (const h of d.holidays ?? []) m[h.date] = h.name;
      setHolidays(m);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/results?strategy=${strategy}`).then(r => r.json()).then(d => { setDates(d); setSelDate((d[tab] ?? [])[0] ?? ""); });
  }, [strategy]);

  useEffect(() => { setSelDate((dates[tab] ?? [])[0] ?? ""); setRows([]); }, [tab, strategy]);

  useEffect(() => {
    if (!selDate) return;
    fetch(`/api/results?type=${tab}&date=${selDate}&strategy=${strategy}`).then(r => r.json()).then(d => setRows(d.rows ?? []));
  }, [selDate, tab, strategy]);

  useEffect(() => {
    fetch(`/api/results/summary?type=${tab}&strategy=${strategy}`).then(r => r.json()).then(d => setSummary(d.summary ?? []));
  }, [tab, strategy]);

  const summaryMap = useMemo(() => Object.fromEntries(summary.map(s => [s.date, s])), [summary]);
  const monthStats = useMemo(() => {
    const prefix = `${calMonth.year}-${String(calMonth.month).padStart(2, "0")}`;
    const days = Object.values(summaryMap).filter(s => s.date.startsWith(prefix));
    return { totalPnL: days.reduce((s, d) => s + d.totalPnL, 0), trades: days.reduce((s, d) => s + d.trades, 0), wins: days.reduce((s, d) => s + d.wins, 0), days: days.length };
  }, [summaryMap, calMonth]);

  const wins = rows.filter(r => r.Status === "TARGET" || r.Status === "TIME_PROFIT" || (r.Status === "TIME_EXIT" && (parseFloat(r.PnL) || 0) >= 0)).length;
  const losses = rows.filter(r => r.Status === "SL" || (r.Status === "TIME_EXIT" && (parseFloat(r.PnL) || 0) < 0)).length;
  const eod = rows.filter(r => r.Status === "EOD").length;
  const closed = wins + losses;
  const winRate = closed > 0 ? ((wins / closed) * 100).toFixed(1) : null;
  const totalPnL = rows.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
  const lotPnL = totalPnL * LOT_QTY;
  const tabAccent = tab === "backtest" ? "#ea580c" : "#7c3aed";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 overflow-x-auto border-b px-3 py-2.5 sm:px-5" style={{ borderColor: "var(--border)" }}>
        <SegButton value={tab} onChange={setTab} options={[["backtest", "◉ BACKTEST", "#ea580c"], ["live", "▶ LIVE", "#7c3aed"]]} />
        <SegButton value={strategy} onChange={setStrategy} options={[["smc", "SMC", "#0d9488"], ["vwap930", "VWAP 9:30", "#0d9488"]]} />

        {viewMode === "table" && winRate !== null && (
          <div className="flex flex-shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1" style={{ background: Number(winRate) >= 70 ? (isDark ? "#052e16" : "#f0fdf4") : (isDark ? "#2d0505" : "#fef2f2"), borderColor: Number(winRate) >= 70 ? (isDark ? "#166534" : "#bbf7d0") : (isDark ? "#991b1b" : "#fecaca") }}>
            <span className="whitespace-nowrap text-xs font-bold" style={{ ...MONO, color: Number(winRate) >= 70 ? "#16a34a" : "#e11d48" }}>{winRate}% · {wins}W/{losses}L{eod > 0 ? ` · ${eod}E` : ""}</span>
          </div>
        )}
        {viewMode === "table" && rows.length > 0 && (
          <div className="hidden flex-shrink-0 items-center gap-1.5 sm:flex">
            <span className="text-xs tracking-[1px]" style={{ ...MONO, color: "var(--text-faint)" }}>LOT P&L</span>
            <span className="text-base font-bold" style={{ ...BEBAS, color: pnlColor(lotPnL) }}>{lotPnL >= 0 ? "+" : ""}₹{Math.abs(lotPnL).toFixed(0)}</span>
          </div>
        )}

        <div className="ml-auto flex flex-shrink-0 items-center gap-2">
          {viewMode === "table" && (
            <select value={selDate} onChange={e => setSelDate(e.target.value)} className="cursor-pointer rounded-sm border px-2 py-1 text-sm outline-none" style={{ ...MONO, borderColor: "var(--border)", background: "var(--card)", color: "var(--text)" }}>
              {(dates[tab] ?? []).map(d => <option key={d} value={d}>{d}</option>)}
              {!(dates[tab]?.length) && <option value="">— no data —</option>}
            </select>
          )}
          <button onClick={() => setViewMode(v => v === "calendar" ? "table" : "calendar")}
            className="flex-shrink-0 rounded-sm border p-1.5 transition-colors"
            style={{ background: viewMode === "calendar" ? tabAccent : "var(--card)", borderColor: "var(--border)", color: viewMode === "calendar" ? "#fff" : "var(--text-faint)" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
          </button>
        </div>
      </div>

      {viewMode === "calendar" ? (
        <div className="flex flex-1 flex-col overflow-auto px-3 py-4 sm:px-5">
          <div className="mb-4 flex flex-shrink-0 items-center justify-center gap-4">
            <button onClick={() => setCalMonth(m => { const d = new Date(m.year, m.month - 2, 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })}
              className="flex h-7 w-7 items-center justify-center rounded text-base font-bold" style={{ background: "var(--card)", color: "var(--text)" }}>‹</button>
            <span className="text-sm font-bold tracking-[2px]" style={{ ...MONO, color: "var(--text)", minWidth: 160, textAlign: "center" }}>{MONTH_NAMES[calMonth.month - 1].toUpperCase()} {calMonth.year}</span>
            <button onClick={() => setCalMonth(m => { const d = new Date(m.year, m.month, 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })}
              className="flex h-7 w-7 items-center justify-center rounded text-base font-bold" style={{ background: "var(--card)", color: "var(--text)" }}>›</button>
          </div>

          <div className="rounded border p-1" style={{ borderColor: "var(--border)" }}>
            <div className="mb-1.5 grid grid-cols-7 gap-1">
              {DAY_NAMES.map(d => <div key={d} className="rounded-sm py-1.5 text-center text-xs font-bold tracking-[1.5px] md:text-sm" style={{ ...MONO, color: "var(--text-muted)", background: isDark ? "#1a2332" : "#e2e8f0" }}>{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {buildCalendar(calMonth.year, calMonth.month).map((day, i) => {
                if (!day) return <div key={i} className="min-h-[56px] sm:min-h-[72px]" />;
                const dateStr = `${calMonth.year}-${String(calMonth.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const data = summaryMap[dateStr];
                const lotPnl = data ? data.totalPnL * LOT_QTY : null;
                const hasData = !!data;
                const isToday = dateStr === today;
                const holiday = holidays[dateStr];
                const isHoliday = !!holiday && !hasData;
                const bg = hasData ? (lotPnl! >= 0 ? "rgba(22,163,74,0.1)" : "rgba(225,29,72,0.1)") : isHoliday ? "rgba(251,191,36,0.35)" : "rgba(100,116,139,0.1)";
                const borderColor = isToday ? tabAccent : hasData ? (lotPnl! >= 0 ? "rgba(22,163,74,0.6)" : "rgba(225,29,72,0.6)") : isHoliday ? "rgba(251,191,36,0.6)" : "rgba(100,116,139,0.3)";
                return (
                  <div key={i} onClick={() => { if (hasData) { setSelDate(dateStr); setViewMode("table"); } }}
                    className="flex min-h-[56px] flex-col rounded-lg p-1.5 transition-colors sm:min-h-[72px] sm:p-2"
                    style={{ background: bg, border: `${isToday ? "2px" : "1px"} solid ${borderColor}`, cursor: hasData ? "pointer" : "default" }}>
                    <span className="text-sm font-bold md:text-sm" style={{ ...MONO, color: isToday ? tabAccent : "var(--text)" }}>{day}</span>
                    {isHoliday && <span className="mt-0.5 break-words text-xs font-bold leading-tight" style={{ ...MONO, color: "#b45309" }}>{holiday}</span>}
                    {hasData && lotPnl !== null && (
                      <>
                        <span className="mt-auto text-sm font-bold leading-tight sm:hidden" style={{ ...MONO, color: lotPnl >= 0 ? "#16a34a" : "#e11d48" }}>{fmtLotPnl(lotPnl)}</span>
                        <span className="mt-auto hidden text-sm font-bold leading-tight sm:block md:text-sm" style={{ ...MONO, color: lotPnl >= 0 ? "#16a34a" : "#e11d48" }}>{fmtLotPnlFull(lotPnl)}</span>
                        <span className="mt-0.5 hidden text-xs sm:block" style={{ ...MONO, color: "var(--text-muted)" }}>{data.trades}T · {data.wins}W</span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {monthStats.days > 0 ? (
            <div className="mt-4 flex-shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)" }}>
              <div className="grid grid-cols-4" style={{ gap: "1px", background: "var(--border)" }}>
                {[
                  ["TRADE DAYS", `${monthStats.days}`, "var(--text-muted)"],
                  ["TOTAL TRADES", `${monthStats.trades}`, "var(--text-muted)"],
                  ["WIN RATE", monthStats.trades > 0 ? `${((monthStats.wins / monthStats.trades) * 100).toFixed(0)}%` : "—", monthStats.trades > 0 && monthStats.wins / monthStats.trades >= 0.7 ? "#16a34a" : "#e11d48"],
                  ["MONTH LOT P&L", fmtLotPnl(monthStats.totalPnL * LOT_QTY), pnlColor(monthStats.totalPnL)],
                ].map(([label, val, color]) => (
                  <div key={label} className="px-3 py-2.5" style={{ background: "var(--bg-elevated)" }}>
                    <div className="mb-1 text-xs uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)" }}>{label}</div>
                    <div className="text-base font-bold leading-tight" style={{ ...MONO, color }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-6 text-center text-sm" style={{ ...MONO, color: "var(--text-faint)" }}>No {tab} data for {MONTH_NAMES[calMonth.month - 1]} {calMonth.year}</div>
          )}
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="flex-1 py-16 text-center text-sm text-muted">No rows for this date</div>
          ) : (
            <>
              {/* Mobile cards */}
              <div className="flex-1 space-y-3 overflow-auto px-3 py-3 md:hidden">
                {rows.map((r, i) => {
                  const pnl = parseFloat(r.PnL) || 0;
                  const lPnl = pnl * LOT_QTY;
                  const pnlPct = parseFloat(r.PnLPct) || 0;
                  const isTimedExit = r.Status === "TIME_EXIT";
                  const isWin = r.Status === "TARGET" || r.Status === "TIME_PROFIT" || (isTimedExit && pnl >= 0);
                  const isLoss = r.Status === "SL" || (isTimedExit && pnl < 0);
                  const dc = dirColor(r.Direction);
                  const sc = isTimedExit ? (pnl >= 0 ? "#22c55e" : "#ef4444") : STATUS_COLOR[r.Status] ?? "#94a3b8";
                  const stIco = r.Status === "TARGET" ? "🎯" : r.Status === "SL" ? "🛑" : r.Status === "EOD" ? "🕐" : r.Status === "ACTIVE" ? "⏳" : r.Status === "TIME_PROFIT" || r.Status === "TIME_EXIT" ? "⏱" : "⏹";
                  const stLbl = r.Status === "TIME_PROFIT" ? "60M PROFIT" : r.Status === "TIME_EXIT" ? "75M EXIT" : r.Status;
                  const t1Hit = r.T1Hit === "Y";
                  const t2Hit = r.Status === "TARGET";
                  return (
                    <div key={i} className="overflow-hidden rounded-xl" style={{ background: isDark ? "#0d1420" : "#fff", border: `1px solid ${isWin ? "#22c55e33" : isLoss ? "#ef444433" : isDark ? "#1e2a3a" : "#e2e8f0"}`, borderLeft: `3px solid ${isWin ? "#22c55e" : isLoss ? "#e11d48" : dc}` }}>
                      <div className="flex items-start justify-between gap-2 px-3 py-3" style={{ background: isWin ? (isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.03)") : isLoss ? (isDark ? "rgba(239,68,68,0.04)" : "rgba(239,68,68,0.03)") : undefined }}>
                        <div className="flex flex-1 items-start gap-2.5 min-w-0">
                          <div className="flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded-xl" style={{ background: `${dc}18`, border: `1.5px solid ${dc}40` }}>
                            <span className="text-xs font-bold" style={{ ...MONO, color: "var(--text-muted)" }}>NI</span>
                            <span className="text-sm font-bold" style={{ ...BEBAS, color: dc }}>{r.Direction}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-base font-bold leading-tight" style={{ ...BEBAS, color: "var(--text)" }}>NIFTY {r.Strike} {r.Direction === "CE" ? "Call" : "Put"}</div>
                            <div className="mt-0.5 text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>{fmtTime(r.EntryTime)}{r.ExitTime ? ` → ${fmtTime(r.ExitTime)}` : " → ACTIVE"}</div>
                            {r.Concepts && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {r.Concepts.split(",").map(c => <span key={c} className="rounded-sm px-1 py-0.5 text-xs font-bold" style={{ ...MONO, background: isDark ? "#1e2a3a" : "#f1f5f9", color: "var(--text-muted)" }}>{c.trim()}</span>)}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                          <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ ...MONO, background: `${sc}18`, color: sc, border: `1px solid ${sc}40` }}>{stIco} {stLbl}</span>
                          <div className="flex gap-1">
                            <span className="rounded-sm px-1.5 py-0.5 text-xs font-bold" style={{ ...MONO, background: t1Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t1Hit ? "#15803d" : "var(--text-faint)" }}>T1{t1Hit ? "✓" : "✗"}</span>
                            <span className="rounded-sm px-1.5 py-0.5 text-xs font-bold" style={{ ...MONO, background: t2Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t2Hit ? "#15803d" : "var(--text-faint)" }}>T2{t2Hit ? "✓" : "✗"}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 border-t px-3 py-1.5" style={{ background: isDark ? "#0d1420" : "#f8fafc", borderColor: isDark ? "#1e2a3a" : "#e2e8f0" }}>
                        <span className="text-xs font-bold" style={{ ...MONO, color: "#b45309" }}>T1 ₹{r.Target1 ?? "—"}{t1Hit ? " ✓" : ""}</span>
                        <span className="text-xs font-bold" style={{ ...MONO, color: "#16a34a" }}>T2 ₹{r.Target2 ?? "—"}{t2Hit ? " ✓" : ""}</span>
                        {r.MaxPoints && <span className="text-xs font-bold" style={{ ...MONO, color: "#7c3aed" }}>MAX +{r.MaxPoints} (+{((parseFloat(r.MaxPoints) / (parseFloat(r.Entry) || 1)) * 100).toFixed(1)}%)</span>}
                      </div>
                      <div className="grid grid-cols-3 border-t" style={{ gap: "1px", background: isDark ? "#1e2a3a" : "#e2e8f0" }}>
                        <div className="px-3 py-2" style={{ background: isDark ? "#0a0f16" : "#f8fafc" }}>
                          <div className="mb-0.5 text-xs tracking-[1px]" style={{ ...MONO, color: "var(--text-muted)" }}>ENTRY</div>
                          <div className="tabular-nums text-sm font-bold" style={{ ...MONO, color: dc }}>₹{r.Entry}</div>
                        </div>
                        <div className="px-3 py-2" style={{ background: isDark ? "#0a0f16" : "#f8fafc" }}>
                          <div className="mb-0.5 text-xs tracking-[1px]" style={{ ...MONO, color: "var(--text-muted)" }}>STOP LOSS</div>
                          <div className="tabular-nums text-sm font-bold" style={{ ...MONO, color: "#e11d48" }}>₹{r.SL}</div>
                        </div>
                        <div className="px-3 py-2" style={{ background: isDark ? "#0a0f16" : "#f8fafc" }}>
                          <div className="mb-0.5 text-xs tracking-[1px]" style={{ ...MONO, color: "var(--text-muted)" }}>LOT P&L</div>
                          <div className="tabular-nums text-base font-bold" style={{ ...MONO, color: pnlColor(lPnl) }}>{fmtLotPnl(lPnl)}</div>
                          <div className="text-xs" style={{ ...MONO, color: pnlColor(pnlPct) }}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="overflow-hidden rounded-xl" style={{ background: isDark ? "#0d1420" : "#f8fafc", border: `1px solid ${isDark ? "#1e2a3a" : "#e2e8f0"}` }}>
                  <div className="grid grid-cols-3" style={{ gap: "1px", background: isDark ? "#1e2a3a" : "#e2e8f0" }}>
                    {[
                      { label: "TRADES", val: `${rows.length}`, color: "var(--text-muted)" },
                      { label: "WIN RATE", val: winRate ? `${winRate}%` : "—", color: winRate && +winRate >= 70 ? "#16a34a" : "#e11d48" },
                      { label: "LOT P&L", val: fmtLotPnl(lotPnL), color: pnlColor(lotPnL) },
                    ].map(({ label, val, color }) => (
                      <div key={label} className="px-3 py-2.5 text-center" style={{ background: isDark ? "#0a0f16" : "#fff" }}>
                        <div className="mb-1 text-xs tracking-[1.5px]" style={{ ...MONO, color: "var(--text-muted)" }}>{label}</div>
                        <div className="text-base font-bold" style={{ ...MONO, color }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Desktop table */}
              <div className="hidden flex-1 flex-col overflow-hidden md:flex">
                <div className="flex-1 overflow-auto">
                  <div style={{ minWidth: 1230 }}>
                    <div className="grid flex-shrink-0 border-b-2" style={{ gridTemplateColumns: COLS_DESKTOP, borderColor: isDark ? "#1e2a3a" : "#cbd5e1", background: isDark ? "#080d14" : "#f8fafc" }}>
                      {["#", "TIME", "CONCEPTS", "STRIKE", "ENTRY", "SL", "T1", "T2", "STATUS", `P&L · LOT (${acctQty}×${LOT_SIZE}=${LOT_QTY})`, "CHARGES", "MAX PTS", "MAX PROFITS"].map(h => (
                        <div key={h} className="px-2 py-2 text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)" }}>{h}</div>
                      ))}
                    </div>
                    <div>
                      {rows.map((r, i) => {
                        const pnl = parseFloat(r.PnL) || 0;
                        const lPnL = pnl * LOT_QTY;
                        const pnlPct = parseFloat(r.PnLPct) || 0;
                        const isTimedWin = r.Status === "TIME_PROFIT";
                        const isTimedExit = r.Status === "TIME_EXIT";
                        const isWin = r.Status === "TARGET" || isTimedWin || (isTimedExit && pnl >= 0);
                        const isLoss = r.Status === "SL" || (isTimedExit && pnl < 0);
                        const isEod = r.Status === "EOD";
                        const dc = dirColor(r.Direction);
                        const stColor = isWin ? "#16a34a" : isLoss ? "#e11d48" : isEod ? "#b45309" : "#0284c7";
                        const pnlClr = pnl >= 0 ? "#16a34a" : "#e11d48";
                        const stIcon = r.Status === "TARGET" ? "🎯" : r.Status === "SL" ? "🛑" : isEod ? "🕐" : isTimedWin ? "⏱" : isTimedExit ? "⏱" : "⏳";
                        const stLabel = isTimedWin ? "60M PROFIT" : isTimedExit ? "75M EXIT" : r.Status;
                        const t1Hit = r.T1Hit === "Y";
                        const t2Hit = r.Status === "TARGET";
                        const rowBg = isWin ? (isDark ? "#052e16" : "#f0fdf4") : isLoss ? (isDark ? "#2d0505" : "#fff5f5") : isEod ? (isDark ? "#1c1500" : "#fefce8") : i % 2 === 0 ? (isDark ? "#0a0f16" : "#fff") : (isDark ? "#0d1420" : "#fafafa");
                        return (
                          <div key={i} className="grid items-center border-b transition-colors" style={{ gridTemplateColumns: COLS_DESKTOP, background: rowBg, borderColor: isDark ? "#0f1923" : "#f1f5f9" }}>
                            <div className="px-2 py-2.5 text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{i + 1}</div>
                            <div className="px-2 py-2.5">
                              <div className="text-sm font-bold" style={{ ...MONO, color: "var(--text)" }}>{fmtTime(r.EntryTime)}</div>
                              <div className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>→{fmtTime(r.ExitTime)}</div>
                            </div>
                            <div className="flex flex-wrap gap-1 px-2 py-2.5">
                              <span className="rounded-sm px-1.5 py-0.5 text-xs font-bold" style={{ ...MONO, background: `${dc}18`, color: dc, border: `1px solid ${dc}30` }}>{r.Direction}</span>
                              {r.Concepts && r.Concepts.split(",").map(c => <span key={c} className="rounded-sm px-1 py-0.5 text-xs font-bold" style={{ ...MONO, background: isDark ? "#1e2a3a" : "#f1f5f9", color: "var(--text-muted)" }}>{c.trim()}</span>)}
                            </div>
                            <div className="px-2 py-2.5">
                              <div className="text-sm font-bold" style={{ ...MONO, color: dc }}>{r.Strike} {r.Direction}</div>
                            </div>
                            <div className="tabular-nums px-2 py-2.5 text-sm font-bold" style={{ ...MONO, color: dc }}>₹{r.Entry}</div>
                            <div className="tabular-nums px-2 py-2.5 text-sm font-bold" style={{ ...MONO, color: "#e11d48" }}>₹{r.SL}</div>
                            <div className="tabular-nums px-2 py-2.5 text-sm font-bold" style={{ ...MONO, color: "#b45309" }}>₹{r.Target1}</div>
                            <div className="tabular-nums px-2 py-2.5 text-sm font-bold" style={{ ...MONO, color: "#16a34a" }}>₹{r.Target2}</div>
                            <div className="px-2 py-2.5">
                              <div className="mb-0.5 flex items-center gap-1">
                                <span className="text-xs">{stIcon}</span>
                                <span className="text-xs font-bold" style={{ ...MONO, color: stColor }}>{stLabel}</span>
                              </div>
                              <div className="mb-0.5 flex gap-1">
                                <span className="rounded-sm px-1 py-0.5 text-xs font-bold" style={{ ...MONO, background: t1Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t1Hit ? "#15803d" : "var(--text-faint)" }}>T1{t1Hit ? "✓" : "✗"}</span>
                                <span className="rounded-sm px-1 py-0.5 text-xs font-bold" style={{ ...MONO, background: t2Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t2Hit ? "#15803d" : "var(--text-faint)" }}>T2{t2Hit ? "✓" : "✗"}</span>
                              </div>
                              <div className="text-xs font-bold" style={{ ...MONO, color: stColor }}>{fmtLotPnl(lPnL)}</div>
                            </div>
                            <div className="px-2 py-2.5">
                              <div className="tabular-nums text-sm font-bold leading-tight" style={{ ...MONO, color: pnlClr }}>{pnl >= 0 ? "+" : "−"}₹{fmtFull(lPnL)}</div>
                              <div className="tabular-nums mt-0.5 text-xs font-bold" style={{ ...MONO, color: pnlClr }}>₹{Math.abs(pnl).toFixed(2)} × {LOT_QTY}</div>
                              <div className="text-xs" style={{ ...MONO, color: pnlClr }}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%</div>
                              {pnl !== 0 && <div className="tabular-nums mt-0.5 text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>exit ₹{(parseFloat(r.Entry) + pnl).toFixed(2)}</div>}
                            </div>
                            <div className="px-2 py-2.5">
                              {(() => {
                                const entry = parseFloat(r.Entry) || 0;
                                const exitP = entry + pnl;
                                const charges = calcCharges(entry, exitP, LOT_QTY);
                                return (
                                  <>
                                    <div className="tabular-nums text-sm font-bold" style={{ ...MONO, color: "#b45309" }}>−₹{fmtFull(charges)}</div>
                                    <div className="mt-0.5 text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>incl. STT+GST</div>
                                  </>
                                );
                              })()}
                            </div>
                            <div className="px-2 py-2.5">
                              {r.MaxPoints && parseFloat(r.MaxPoints) > 0 ? (
                                <>
                                  <div className="tabular-nums text-sm font-bold" style={{ ...MONO, color: "#7c3aed" }}>+{r.MaxPoints}</div>
                                  <div className="tabular-nums text-xs font-bold" style={{ ...MONO, color: "#7c3aed" }}>+{((parseFloat(r.MaxPoints) / (parseFloat(r.Entry) || 1)) * 100).toFixed(1)}%</div>
                                </>
                              ) : <div className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>—</div>}
                            </div>
                            <div className="px-2 py-2.5">
                              {r.MaxPoints && parseFloat(r.MaxPoints) > 0 ? (() => {
                                const maxLot = parseFloat(r.MaxPoints) * LOT_QTY;
                                return (
                                  <>
                                    <div className="tabular-nums text-sm font-bold leading-tight" style={{ ...MONO, color: "#7c3aed" }}>+₹{fmtFull(maxLot)}</div>
                                    <div className="tabular-nums mt-0.5 text-xs font-bold" style={{ ...MONO, color: "#7c3aed" }}>{r.MaxPoints} × {LOT_QTY}</div>
                                    <div className="tabular-nums text-xs font-bold" style={{ ...MONO, color: "#7c3aed" }}>+{((parseFloat(r.MaxPoints) / (parseFloat(r.Entry) || 1)) * 100).toFixed(1)}%</div>
                                  </>
                                );
                              })() : <div className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>—</div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex-shrink-0 border-t" style={{ borderColor: "var(--border)" }}>
                  <div className="grid grid-cols-4 sm:grid-cols-8" style={{ gap: "1px", background: "var(--border)" }}>
                    {[
                      { label: "TOTAL TRADES", val: `${rows.length}`, color: "var(--text-muted)" },
                      { label: "TARGET HIT", val: `${wins}`, color: "#16a34a" },
                      { label: "SL HIT", val: `${losses}`, color: "#e11d48" },
                      { label: "EOD / OPEN", val: `${eod}`, color: "#b45309" },
                      { label: "WIN RATE", val: winRate ? `${winRate}%` : "—", color: winRate && Number(winRate) >= 70 ? "#16a34a" : "#e11d48" },
                      { label: "PREMIUM P&L", val: `${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)} ₹`, color: pnlColor(totalPnL) },
                      { label: "TOTAL CHARGES", val: `−₹${fmtFull(rows.reduce((sum, r) => { const entry = parseFloat(r.Entry) || 0; const p = parseFloat(r.PnL) || 0; return sum + calcCharges(entry, entry + p, LOT_QTY); }, 0))}`, color: "#b45309", sub: "brokerage · STT · GST · NSE" },
                      { label: `LOT P&L (${LOT_QTY}×)`, val: `${lotPnL >= 0 ? "+" : "−"}₹${fmtFull(lotPnL)}`, color: pnlColor(lotPnL) },
                    ].map(({ label, val, color, sub }: any) => (
                      <div key={label} className="px-3 py-2.5" style={{ background: "var(--bg-elevated)" }}>
                        <div className="mb-1 text-xs uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)" }}>{label}</div>
                        <div className="text-base font-bold leading-tight" style={{ ...MONO, color }}>{val}</div>
                        {sub && <div className="mt-0.5 text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{sub}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SegButton<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string, string][] }) {
  return (
    <div className="flex flex-shrink-0 overflow-hidden rounded-sm border" style={{ borderColor: "var(--border)" }}>
      {options.map(([v, label, color]) => (
        <button key={v} onClick={() => onChange(v)} className="whitespace-nowrap px-2 py-1.5 text-xs font-bold tracking-[1px] transition-colors sm:px-3"
          style={{ ...MONO, background: value === v ? color : "transparent", color: value === v ? "#fff" : "var(--text-muted)" }}>
          {label}
        </button>
      ))}
    </div>
  );
}
