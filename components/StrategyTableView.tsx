"use client";

// ─── Strategy table view ──────────────────────────────────────────────────────
// Full port of frontend/app/options/page.tsx's SMCTableView (~5101-6601) and
// VWAP930TableView (~6602-7425): same LIVE/TEST mode switcher, same backtest
// date-picker + RUN/CLR flow, same auto-trade positions panel, same rich
// mobile-card design (direction badge, concept/VWAP pills, progress bar with
// a T1 tick mark, WIN/LOSS/T1/T2 badges, 3-col ENTRY/CMP-SL/LOT-P&L footer),
// same dense desktop table (#, TIME, SIGNALS or VWAP, STRIKE, ENTRY, CMP, SL,
// T1/T2 or TARGET, STATUS+progress, P&L, CHARGES, MAX PTS, MAX PROFITS, chart
// + watchlist button), and the same footer stats strip. `api.hasTwoTargets`
// (already the parameterisation point between SMC and VWAP930) toggles the
// SMC-only concepts/score/trend/T1-T2 columns vs VWAP930's single VWAP/TARGET
// column and its extra exit statuses (STAGNANT_EXIT, VWAP_EXIT).
import { useEffect, useState, useCallback } from "react";
import { IconChartCandle } from "@tabler/icons-react";
import type { AlertRecord } from "@/lib/strategies/types";
import { useTheme } from "@/lib/theme";
import { useAccountQty } from "@/lib/useAccountQty";
import { LOT_SIZE, NUM_LOTS } from "@/lib/strategies/constants";
import { ChartPanel, type ChartTarget } from "./ChartPanel";

const MONO = { fontFamily: "'Space Mono', monospace" } as const;
const BEBAS = { fontFamily: "'Bebas Neue', sans-serif" } as const;
const CONCEPT_COLOR: Record<string, string> = { LiqGrab: "#7c3aed", FVG: "#0284c7", OrdBlock: "#b45309", Breaker: "#ea580c", SMTrap: "#e11d48" };

export type StrategyApi = {
  base: string; // "/api/smc" | "/api/vwap930"
  autoTradeBase: string; // "/api/auto-trade" | "/api/vwap930-auto-trade"
  label: string; // "SMC" | "VWAP 9:30"
  hasTwoTargets: boolean; // SMC: target1/target2, VWAP930: single target
};

type Status = { marketOpen: boolean; scanActive?: boolean; lastScanAt: string | null; scanRunning: boolean; totalAlerts: number; winRate: number | null; wins: number; losses: number };
type AutoTradePosition = { alertId: string; tradingsymbol: string; direction: string; strike: number; status: string; entryOrderId?: string; slOrderId?: string; logs?: string[] };
type Mode = "live" | "backtest";
type WatchedItem = { token: number; tradingsymbol: string; strike: number; type: string; ltp: number };

function todayStr() { return new Date().toISOString().split("T")[0]; }
function fmtTime(t: string) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const hr = h % 12 || 12;
  return `${String(hr).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function fmtExpiry(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]}`;
}
function fmtLotPnl(n: number) {
  const abs = Math.abs(n);
  const s = n >= 0 ? "+" : "−";
  return abs >= 100000 ? `${s}₹${(abs / 100000).toFixed(2)}L` : abs >= 1000 ? `${s}₹${(abs / 1000).toFixed(1)}K` : `${s}₹${abs.toFixed(0)}`;
}
function fmtFull(n: number) {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  if (int.length <= 3) return `${int}.${dec}`;
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}.${dec}`;
}
// INDstocks' real F&O charge structure (verified against GET /margin and
// https://api-docs.indstocks.com/margin_calculation/ — same rates
// lib/runtime/accountService.ts's estimateCharges() uses for the Account
// tab): ₹10 flat brokerage per order (₹20 round-trip), STT 0.1% sell-side
// only, exchange 0.03503%, SEBI ₹10/crore, stamp duty 0.003% buy-side only,
// GST 18% on brokerage+exchange only. NOT Zerodha's ₹20/order + 0.0625% STT.
function calcCharges(entry: number, exit: number, qty: number): number {
  const turnover = (entry + exit) * qty;
  const brokerage = 20; // ₹10 × 2 orders (entry + exit)
  const exchange = turnover * 0.0003503;
  const sebi = turnover * 0.0000001;
  const stt = exit * qty * 0.001; // sell-side only
  const stamp = entry * qty * 0.00003; // buy-side only
  const gst = (brokerage + exchange) * 0.18;
  return brokerage + stt + exchange + sebi + gst + stamp;
}
function statusMeta(status: string, pnl: number, hasTwoTargets: boolean) {
  if (status === "TARGET") return { icon: "🎯", label: "TARGET", color: "#16a34a" };
  if (status === "SL") return { icon: "🛑", label: "SL", color: "#e11d48" };
  if (status === "EOD") return { icon: "🕐", label: "EOD", color: "#b45309" };
  if (status === "TIME_EXIT") return { icon: "⏱", label: hasTwoTargets ? "75M EXIT" : "15:20 EXIT", color: pnl >= 0 ? "#16a34a" : "#e11d48" };
  if (status === "STAGNANT_EXIT") return { icon: "💤", label: "STAGNANT", color: pnl >= 0 ? "#16a34a" : "#e11d48" };
  if (status === "VWAP_EXIT") return { icon: "⚡", label: "VWAP EXIT", color: pnl >= 0 ? "#16a34a" : "#e11d48" };
  return { icon: "⏳", label: "ACTIVE", color: "#0284c7" };
}

export function StrategyTableView({ api, expiry }: { api: StrategyApi; expiry: string }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const accent = api.hasTwoTargets ? "#7c3aed" : "#0d9488";
  const acctQty = useAccountQty(NUM_LOTS);
  const LOT_QTY = LOT_SIZE * acctQty;

  const [mode, setMode] = useState<Mode>("live");
  const [status, setStatus] = useState<Status | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [autoTrade, setAutoTrade] = useState<{ enabled: boolean; positions: AutoTradePosition[] }>({ enabled: false, positions: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [watchedTokens, setWatchedTokens] = useState<Set<number>>(new Set());

  const [histDate, setHistDate] = useState(todayStr());
  const [histBusy, setHistBusy] = useState(false);
  const [histErr, setHistErr] = useState("");
  const [histResults, setHistResults] = useState<AlertRecord[] | null>(null);

  const load = useCallback(async () => {
    if (!expiry) return;
    try {
      const [s, a, at] = await Promise.all([
        fetch(`${api.base}/status`).then(r => r.json()),
        fetch(`${api.base}/alerts?expiry=${expiry}`).then(r => r.json()),
        fetch(`${api.autoTradeBase}/status`).then(r => r.json()),
      ]);
      setStatus(s);
      if (a.alerts) setAlerts(a.alerts);
      setAutoTrade(at);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [api, expiry]);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    fetch("/api/watchlist/groups").then(r => r.json()).then(d => {
      const def = (d.groups ?? []).find((g: any) => g.id === "wl_default");
      setWatchedTokens(new Set((def?.items ?? []).map((i: WatchedItem) => i.token)));
    }).catch(() => {});
  }, []);

  async function addToWatch(leg: { token: number; tradingsymbol: string; strike: number; type: string; ltp: number } | undefined) {
    if (!leg) return;
    setWatchedTokens(prev => new Set(prev).add(leg.token));
    const d = await fetch("/api/watchlist/groups").then(r => r.json());
    const groups = d.groups ?? [{ id: "wl_default", name: "My Watchlist", items: [] }];
    const def = groups.find((g: any) => g.id === "wl_default") ?? groups[0];
    const items: WatchedItem[] = def.items ?? [];
    if (items.some(i => i.token === leg.token)) return;
    const nextItems = [...items, { token: leg.token, tradingsymbol: leg.tradingsymbol, strike: leg.strike, type: leg.type, ltp: leg.ltp }];
    fetch(`/api/watchlist/groups/${def.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: def.name, items: nextItems }) }).catch(() => {});
  }

  async function scan() {
    if (!expiry) return;
    setBusy(true);
    try { await fetch(`${api.base}/scan?expiry=${expiry}`, { method: "POST" }); await load(); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!confirm(`Clear all ${api.label} alerts?`)) return;
    await fetch(`${api.base}/clear`, { method: "DELETE" });
    await load();
  }
  async function toggleAutoTrade() {
    const endpoint = autoTrade.enabled ? "disable" : "enable";
    setBusy(true);
    try {
      const res = await fetch(`${api.autoTradeBase}/${endpoint}`, { method: "POST" }).then(r => r.json());
      if (res.error) { setError(res.error); return; }
      await load();
    } finally { setBusy(false); }
  }
  async function runBacktest() {
    if (!expiry) return;
    setHistBusy(true); setHistErr("");
    try {
      const d = await fetch(`${api.base}/historical?date=${histDate}&expiry=${expiry}`).then(r => r.json());
      if (d.error) { setHistErr(d.error); setHistResults(null); return; }
      setHistResults(d.results ?? []);
    } catch (e: any) {
      setHistErr(e.message);
    } finally {
      setHistBusy(false);
    }
  }
  function clearBacktest() { setHistResults(null); setHistErr(""); }

  const tableAlerts = mode === "backtest" ? (histResults ?? []) : alerts;
  const wins = tableAlerts.filter(a => a.status === "TARGET" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) >= 0)).length;
  const losses = tableAlerts.filter(a => a.status === "SL" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) < 0)).length;
  const eod = tableAlerts.filter(a => a.status === "EOD").length;
  const active = tableAlerts.filter(a => a.status === "ACTIVE").length;
  const total = wins + losses;
  const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : null;
  const totalLotPnl = tableAlerts.reduce((s, a) => s + (a.currentPnL ?? 0) * LOT_QTY, 0);
  const realizedLotPnl = tableAlerts.filter(a => a.status !== "ACTIVE").reduce((s, a) => s + (a.currentPnL ?? 0) * LOT_QTY, 0);

  // Same column layout for both strategies now — VWAP930 only has one real
  // target (rr.target, no target1/target2 split), so its T2 cell just shows
  // "—" rather than a fabricated duplicate value, and its SIGNALS cell stays
  // empty (no concepts/score data exists for it). The "#" and SIGNALS columns
  // being genuinely used is also what gives this layout its natural 1fr
  // stretch to fill wide screens — no special-cased filler column needed.
  const COLS = "40px 75px 1fr max-content 70px 70px 72px 72px 72px 90px 155px 80px 65px 130px 80px";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Mode switcher + action bar ── */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:gap-3 sm:px-5" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
        <div className="flex flex-shrink-0 overflow-hidden rounded-sm border" style={{ borderColor: "var(--border)" }}>
          {(["live", "backtest"] as Mode[]).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className="whitespace-nowrap px-2 py-1.5 text-[9px] font-bold tracking-[1px] transition-colors sm:px-3"
              style={{ ...MONO, background: mode === m ? (m === "live" ? accent : "#ea580c") : "transparent", color: mode === m ? "#fff" : "var(--text-muted)" }}>
              {m === "live" ? "▶ LIVE" : "◉ TEST"}
            </button>
          ))}
        </div>

        {mode === "live" ? (
          <>
            <Pill active={!!status?.scanActive} activeColor={accent} label={status?.scanActive ? "SCANNING" : "CLOSED"} />
            {wr !== null && <WinRatePill wr={wr} wins={wins} losses={losses} />}
            <span className="hidden flex-shrink-0 whitespace-nowrap text-[9px] sm:block" style={{ ...MONO, color: "var(--text-faint)" }}>
              <span className="font-bold" style={{ color: "var(--ce)" }}>{active}</span> active · {alerts.length} total
            </span>
            <div className="ml-auto flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
              <button onClick={toggleAutoTrade}
                className="whitespace-nowrap rounded-sm border px-2 py-1.5 text-[9px] font-bold transition-all sm:px-3"
                style={{ ...MONO, background: autoTrade.enabled ? "#16a34a" : "var(--bg)", borderColor: autoTrade.enabled ? "#16a34a" : "#e11d48", color: autoTrade.enabled ? "#fff" : "#e11d48" }}>
                {autoTrade.enabled ? "⏹ STOP" : "▶ AUTO"}
              </button>
              <button onClick={scan} disabled={busy || !expiry}
                className="whitespace-nowrap rounded-sm border px-2 py-1.5 text-[9px] font-bold disabled:opacity-40 sm:px-3"
                style={{ ...MONO, background: `${accent}18`, borderColor: accent, color: accent }}>
                {busy ? "…" : "▶ SCAN"}
              </button>
              {alerts.length > 0 && (
                <button onClick={clear} className="whitespace-nowrap rounded-sm border px-2 py-1.5 text-[9px]" style={{ ...MONO, borderColor: "var(--border)", color: "var(--text-faint)" }}>CLR</button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
              <span className="hidden text-[9px] tracking-[1px] sm:block" style={{ ...MONO, color: "var(--text-faint)" }}>DATE</span>
              <input type="date" value={histDate} max={todayStr()} onChange={e => setHistDate(e.target.value)}
                className="cursor-pointer rounded-sm border px-2 py-1 text-[10px] outline-none sm:text-[11px]"
                style={{ ...MONO, borderColor: "var(--border)", background: "var(--bg)", color: "var(--text)" }} />
              <button onClick={runBacktest} disabled={histBusy || !expiry}
                className="whitespace-nowrap rounded-sm border px-2 py-1.5 text-[9px] font-bold transition-colors disabled:opacity-40 sm:px-3"
                style={{ ...MONO, background: "rgba(234,88,12,0.1)", borderColor: "#ea580c", color: "#ea580c" }}>
                {histBusy ? "…" : "◉ RUN"}
              </button>
              {histErr && <span className="whitespace-nowrap text-[9px]" style={{ ...MONO, color: "#e11d48" }}>{histErr}</span>}
            </div>
            {histResults !== null && wr !== null && <WinRatePill wr={wr} wins={wins} losses={losses} eod={eod} />}
            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
              {histResults !== null && (
                <button onClick={clearBacktest} className="whitespace-nowrap rounded-sm border px-2 py-1.5 text-[9px]" style={{ ...MONO, borderColor: "var(--border)", color: "var(--text-faint)" }}>CLR</button>
              )}
            </div>
          </>
        )}
      </div>

      {error && <div className="m-3 rounded-[var(--radius)] border p-3 text-sm" style={{ borderColor: "var(--down)", background: "var(--down-soft)", color: "var(--down)" }}>{error}</div>}

      {/* ── Auto-trade positions ── */}
      {mode === "live" && autoTrade.positions.length > 0 && (
        <div className="flex-shrink-0 border-b px-5 py-2" style={{ background: isDark ? "#052e16" : "#f0fdf4", borderColor: isDark ? "#166534" : "#bbf7d0" }}>
          <div className="mb-1.5 text-[8px] font-bold tracking-[1.5px]" style={{ ...MONO, color: "#16a34a" }}>AUTO TRADE POSITIONS ({autoTrade.positions.length})</div>
          <div className="flex flex-col gap-1">
            {autoTrade.positions.map((p, i) => (
              <div key={i} className="flex items-center gap-3 text-[9px]" style={MONO}>
                <span className="font-bold" style={{ color: "var(--text)" }}>{p.tradingsymbol}</span>
                <span className="rounded-sm px-1.5 py-0.5 text-[8px] font-bold" style={{ background: p.status?.startsWith("EXITED") || p.status === "ACTIVE" ? "#16a34a22" : p.status === "ERROR" ? "#ef444422" : "#f59e0b22", color: p.status?.startsWith("EXITED") || p.status === "ACTIVE" ? "#16a34a" : p.status === "ERROR" ? "#ef4444" : "#b45309" }}>{p.status}</span>
                {p.entryOrderId && <span style={{ color: "var(--text-muted)" }}>Entry: {p.entryOrderId}</span>}
                {p.slOrderId && <span style={{ color: "#ef4444" }}>SL: {p.slOrderId}</span>}
                {p.logs?.[p.logs.length - 1] && <span className="max-w-[300px] truncate" style={{ color: "var(--text-faint)" }}>{p.logs[p.logs.length - 1]}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {tableAlerts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4">
          <IconChartCandle size={48} style={{ color: "var(--border)" }} />
          <p className="text-center text-[11px]" style={{ ...MONO, color: "var(--text-faint)" }}>
            {mode === "backtest" ? "Select a date and tap RUN to check that day's signals" : `No ${api.label} alerts yet ${status?.marketOpen ? "— scanning…" : "— market closed"}`}
          </p>
          {mode === "live" && (
            <button onClick={scan} disabled={busy} className="rounded-sm border px-5 py-2.5 text-[10px] font-bold tracking-[2px] disabled:opacity-40" style={{ ...MONO, background: `${accent}18`, borderColor: accent, color: accent }}>
              {busy ? "SCANNING…" : `▶ RUN ${api.label.toUpperCase()} SCAN NOW`}
            </button>
          )}
          {mode === "backtest" && (
            <button onClick={runBacktest} disabled={histBusy} className="rounded-sm border px-5 py-2.5 text-[10px] font-bold tracking-[2px] disabled:opacity-40" style={{ ...MONO, background: "#ea580c18", borderColor: "#ea580c", color: "#ea580c" }}>
              {histBusy ? "SCANNING…" : "◉ RUN BACKTEST NOW"}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* ── Mobile cards ── */}
          <div className="flex-1 space-y-3 overflow-auto px-3 py-3 md:hidden">
            {tableAlerts.map((a, idx) => (
              <MobileCard key={a.id ?? idx} a={a} api={api} isDark={isDark} accent={accent} LOT_QTY={LOT_QTY}
                onOpenChart={() => a.leg && setChartTarget({ token: a.leg.token, tradingsymbol: a.leg.tradingsymbol, strike: a.strike, type: a.direction, expiry: a.expiry, patternZones: a.patternZones })} />
            ))}
            <div className="overflow-hidden rounded-xl" style={{ background: isDark ? "#0d1420" : "#f8fafc", border: `1px solid ${isDark ? "#1e2a3a" : "#e2e8f0"}` }}>
              <div className="grid grid-cols-3" style={{ gap: "1px", background: isDark ? "#1e2a3a" : "#e2e8f0" }}>
                {[
                  { label: "TRADES", val: `${tableAlerts.length}`, color: "#475569" },
                  { label: "WIN RATE", val: wr ? `${wr}%` : "—", color: wr && Number(wr) >= 70 ? "#16a34a" : "#e11d48" },
                  { label: "LOT P&L", val: tableAlerts.length > 0 ? fmtLotPnl(totalLotPnl) : "—", color: totalLotPnl >= 0 ? "#16a34a" : "#e11d48" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="px-3 py-2.5 text-center" style={{ background: isDark ? "#0a0f16" : "#fff" }}>
                    <div className="mb-1 text-[7px] tracking-[1.5px]" style={{ ...MONO, color: "#64748b" }}>{label}</div>
                    <div className="text-[15px] font-bold" style={{ ...MONO, color }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Desktop table ── */}
          <div className="hidden flex-1 overflow-auto md:block">
            <div style={{ minWidth: 1200 }}>
              <div className="sticky top-0 z-10 grid border-b-2" style={{ gridTemplateColumns: COLS, borderColor: isDark ? "#1e2a3a" : "#cbd5e1", background: isDark ? "#080d14" : "#f8fafc" }}>
                {["#", "TIME", "SIGNALS", "STRIKE", "ENTRY", "CMP", "SL", "T1", "T2", "STATUS", `P&L · LOT (${acctQty}×${LOT_SIZE}=${LOT_QTY})`, "CHARGES", "MAX PTS", "MAX PROFITS", ""].map((h, i) => (
                  <div key={i} className="px-2 py-2 text-[8px] font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)" }}>{h}</div>
                ))}
              </div>
              {tableAlerts.map((a, idx) => (
                <DesktopRow key={a.id ?? idx} a={a} idx={idx} api={api} isDark={isDark} accent={accent} LOT_QTY={LOT_QTY} cols={COLS}
                  watched={a.leg ? watchedTokens.has(a.leg.token) : false}
                  onOpenChart={() => a.leg && setChartTarget({ token: a.leg.token, tradingsymbol: a.leg.tradingsymbol, strike: a.strike, type: a.direction, expiry: a.expiry, patternZones: a.patternZones })}
                  onAddWatch={() => addToWatch(a.leg)} />
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Footer stats ── */}
      {tableAlerts.length > 0 && (
        <div className="hidden flex-shrink-0 border-t md:block" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          {mode === "backtest" && histResults !== null && (
            <div className="border-b px-5 py-1.5 text-[8px]" style={{ ...MONO, background: isDark ? "#1c1500" : "#fef9ec", borderColor: isDark ? "#3a2e00" : "#fde68a", color: "#b45309" }}>
              ◉ BACKTEST {histDate} · expiry {expiry} · all prices from historical candles · EOD = position open at 15:30
            </div>
          )}
          <div className={`grid ${api.hasTwoTargets ? "grid-cols-4 sm:grid-cols-8" : "grid-cols-3 sm:grid-cols-6"}`} style={{ gap: "1px", background: isDark ? "#1e2a3a" : "#cbd5e1" }}>
            {(api.hasTwoTargets ? [
              { label: "TOTAL SIGNALS", val: `${tableAlerts.length}`, color: "#475569" },
              { label: "ACTIVE", val: `${active}`, color: "#0284c7" },
              { label: "TARGET HIT", val: `${wins}`, color: "#16a34a" },
              { label: "SL HIT", val: `${losses}`, color: "#e11d48" },
              { label: "EOD / OPEN", val: `${eod}`, color: "#b45309" },
              { label: "WIN RATE", val: wr ? `${wr}%` : "—", color: wr && Number(wr) >= 70 ? "#16a34a" : "#e11d48" },
              { label: "TOTAL CHARGES", val: tableAlerts.length > 0 ? `−₹${fmtFull(tableAlerts.reduce((s, a) => { const e = a.rr?.entry ?? 0; const x = a.status === "ACTIVE" ? (a.lastLtp ?? e) : e + (a.currentPnL ?? 0); return s + calcCharges(e, x, LOT_QTY); }, 0))}` : "—", color: "#b45309", sub: "brokerage · STT · GST · NSE" },
              { label: `LOT P&L (${LOT_QTY}×)`, val: tableAlerts.length > 0 ? `${totalLotPnl >= 0 ? "+" : "−"}₹${fmtFull(totalLotPnl)}` : "—", color: totalLotPnl >= 0 ? "#16a34a" : "#e11d48", sub: active > 0 ? `realized ${totalLotPnl >= 0 ? "+" : "−"}₹${fmtFull(realizedLotPnl)}` : undefined },
            ] : [
              { label: "TOTAL TRADES", val: `${tableAlerts.length}`, color: "#475569" },
              { label: "ACTIVE", val: `${active}`, color: "#0284c7" },
              { label: "TARGET HIT", val: `${wins}`, color: "#16a34a" },
              { label: "SL HIT", val: `${losses}`, color: "#e11d48" },
              { label: "WIN RATE", val: wr ? `${wr}%` : "—", color: wr && Number(wr) >= 70 ? "#16a34a" : "#e11d48" },
              { label: `LOT P&L (${LOT_QTY}×)`, val: tableAlerts.length > 0 ? `${totalLotPnl >= 0 ? "+" : "−"}₹${fmtFull(totalLotPnl)}` : "—", color: totalLotPnl >= 0 ? "#16a34a" : "#e11d48", sub: active > 0 ? `realized ${totalLotPnl >= 0 ? "+" : "−"}₹${fmtFull(realizedLotPnl)}` : undefined },
            ]).map(({ label, val, color, sub }: any) => (
              <div key={label} className="px-3 py-2.5" style={{ background: isDark ? "#0a0f16" : "#fff" }}>
                <div className="mb-1 text-[7px] uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)" }}>{label}</div>
                <div className="text-[15px] font-bold leading-tight" style={{ ...MONO, color }}>{val}</div>
                {sub && <div className="mt-0.5 text-[7px]" style={{ ...MONO, color: "var(--text-faint)" }}>{sub}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {chartTarget && <ChartPanel {...chartTarget} startInTechnical onClose={() => setChartTarget(null)} />}
    </div>
  );
}

function MobileCard({ a, api, isDark, accent, LOT_QTY, onOpenChart }: { a: AlertRecord; api: StrategyApi; isDark: boolean; accent: string; LOT_QTY: number; onOpenChart: () => void }) {
  const isCE = a.direction === "CE";
  const dirClr = isCE ? "#0284c7" : "#e11d48";
  const sm = statusMeta(a.status, a.currentPnL ?? 0, api.hasTwoTargets);
  const isWin = a.status === "TARGET" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) >= 0);
  const isLoss = a.status === "SL" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) < 0);
  const pnlUp = (a.currentPnL ?? 0) >= 0;
  const pnlClr = pnlUp ? "#16a34a" : "#e11d48";
  const sl = a.rr?.sl ?? 0;
  const t2 = api.hasTwoTargets ? (a.rr?.target2 ?? 0) : (a.rr?.target ?? 0);
  const ltp = a.leg?.ltp ?? a.lastLtp ?? a.rr?.entry ?? 0;
  const fill = t2 - sl > 0 ? Math.min(Math.max(((ltp - sl) / (t2 - sl)) * 100, 0), 100) : 50;
  const t1Pct = api.hasTwoTargets && (a.rr?.target2 ?? 0) - sl > 0 ? Math.min((((a.rr?.target1 ?? 0) - sl) / ((a.rr?.target2 ?? 0) - sl)) * 100, 100) : 67;
  const t1Hit = a.t1Hit || a.status === "TARGET";
  const t2Hit = a.status === "TARGET";

  return (
    <div className="overflow-hidden rounded-xl" style={{ background: isDark ? "#0d1420" : "#fff", border: `1px solid ${isWin ? "#22c55e33" : isLoss ? "#ef444433" : isDark ? "#1e2a3a" : "#e2e8f0"}`, borderLeft: `3px solid ${isWin ? "#22c55e" : isLoss ? "#e11d48" : a.status === "ACTIVE" ? dirClr : "#334155"}` }}>
      <div className="flex items-start justify-between gap-2 px-3 py-3">
        <div className="flex flex-1 items-start gap-2.5 min-w-0">
          <div className="flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded-xl" style={{ background: `${dirClr}18`, border: `1.5px solid ${dirClr}40` }}>
            <span className="text-[7px] font-bold" style={{ ...MONO, color: "#64748b" }}>NI</span>
            <span className="text-[12px] font-bold" style={{ ...BEBAS, color: dirClr }}>{a.direction}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold leading-tight" style={{ ...BEBAS, color: isDark ? "#e2e8f0" : "#1e293b" }}>NIFTY {a.strike} {a.direction === "CE" ? "Call" : "Put"}</div>
            <div className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[8px]" style={{ ...MONO, color: "#64748b" }}>{fmtTime(a.entryTime)}{a.exitTime ? ` → ${fmtTime(a.exitTime)}` : " → ACTIVE"}{a.spot ? `  ·  spot ${a.spot.toFixed(0)}` : ""}</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {api.hasTwoTargets ? (
                <>
                  <span className="rounded-sm px-1.5 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: `${dirClr}18`, color: dirClr, border: `1px solid ${dirClr}30` }}>{a.direction} {a.score}/5</span>
                  {(a.concepts ?? []).map(c => <span key={c} className="rounded-sm px-1 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: `${CONCEPT_COLOR[c] ?? "#64748b"}14`, color: CONCEPT_COLOR[c] ?? "#64748b" }}>{c}</span>)}
                  {a.trendOk && <span className="text-[7px]" style={{ ...MONO, color: "#16a34a" }}>+EMA✓</span>}
                </>
              ) : (
                <span className="rounded-sm px-1.5 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: `${dirClr}18`, color: dirClr, border: `1px solid ${dirClr}30` }}>VWAP ₹{a.vwap?.toFixed?.(2) ?? a.vwap ?? "—"}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
          <span className="rounded-full px-2 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: `${sm.color}18`, color: sm.color, border: `1px solid ${sm.color}40` }}>{sm.icon} {sm.label}</span>
          {api.hasTwoTargets ? (
            <div className="flex gap-1">
              <span className="rounded-sm px-1 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: t1Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t1Hit ? "#15803d" : (isDark ? "#4a6080" : "#94a3b8") }}>T1{t1Hit ? "✓" : "✗"}</span>
              <span className="rounded-sm px-1 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: t2Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t2Hit ? "#15803d" : (isDark ? "#4a6080" : "#94a3b8") }}>T2{t2Hit ? "✓" : "✗"}</span>
            </div>
          ) : (
            <span className="rounded-sm px-1.5 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: t2Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t2Hit ? "#15803d" : (isDark ? "#4a6080" : "#94a3b8") }}>TGT{t2Hit ? "✓" : "✗"}</span>
          )}
          {a.leg && (
            <button onClick={onOpenChart} title="Open chart" className="flex h-5 w-5 cursor-pointer items-center justify-center" style={{ color: dirClr, opacity: 0.7 }}><IconChartCandle size={14} color={dirClr} /></button>
          )}
        </div>
      </div>

      {a.status === "ACTIVE" && (
        <div className="px-3 pb-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full" style={{ background: "#e2e8f0" }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${fill}%`, background: fill >= 67 ? "#16a34a" : fill >= 33 ? "#f59e0b" : "#e11d48" }} />
            {api.hasTwoTargets && <div className="absolute bottom-0 top-0 w-px opacity-70" style={{ left: `${t1Pct}%`, background: "#7c3aed" }} />}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 border-t px-3 py-1.5" style={{ background: isDark ? "#0d1420" : "#fff", borderColor: isDark ? "#1e2a3a" : "#e2e8f0" }}>
        {api.hasTwoTargets ? (
          <>
            <span className="text-[9px] font-bold" style={{ ...MONO, color: "#b45309" }}>T1 ₹{a.rr?.target1?.toFixed(2) ?? "—"}{t1Hit ? " ✓" : ""}</span>
            <span className="text-[9px] font-bold" style={{ ...MONO, color: "#16a34a" }}>T2 ₹{a.rr?.target2?.toFixed(2) ?? "—"}{t2Hit ? " ✓" : ""}</span>
          </>
        ) : (
          <>
            <span className="text-[9px] font-bold" style={{ ...MONO, color: "#e11d48" }}>SL ₹{a.rr?.sl?.toFixed(2) ?? "—"}</span>
            <span className="text-[9px] font-bold" style={{ ...MONO, color: "#16a34a" }}>TGT ₹{a.rr?.target?.toFixed(2) ?? "—"}{t2Hit ? " ✓" : ""}</span>
          </>
        )}
        {(a.peakMove ?? 0) > 0 && <span className="text-[9px] font-bold" style={{ ...MONO, color: "#7c3aed" }}>MAX +{a.peakMove.toFixed(1)} (+{((a.peakMove / (a.rr?.entry || 1)) * 100).toFixed(1)}%)</span>}
      </div>

      <div className="grid grid-cols-3 border-t" style={{ gap: "1px", background: isDark ? "#1e2a3a" : "#e2e8f0" }}>
        <div className="px-3 py-2" style={{ background: isDark ? "#0a0f16" : "#f8fafc" }}>
          <div className="mb-0.5 text-[7px] tracking-[1px]" style={{ ...MONO, color: "#64748b" }}>ENTRY</div>
          <div className="tabular-nums text-[12px] font-bold" style={{ ...MONO, color: dirClr }}>₹{a.rr?.entry?.toFixed(2) ?? "—"}</div>
        </div>
        <div className="px-3 py-2" style={{ background: isDark ? "#0a0f16" : "#f8fafc" }}>
          <div className="mb-0.5 text-[7px] tracking-[1px]" style={{ ...MONO, color: "#64748b" }}>{a.status === "ACTIVE" ? "CMP" : "SL"}</div>
          <div className="tabular-nums text-[12px] font-bold" style={{ ...MONO, color: a.status === "ACTIVE" ? ((a.lastLtp ?? ltp) >= (a.rr?.entry ?? 0) ? "#16a34a" : "#e11d48") : "#e11d48" }}>₹{(a.status === "ACTIVE" ? (a.lastLtp ?? ltp) : a.rr?.sl)?.toFixed(2) ?? "—"}</div>
          {a.status === "ACTIVE" && <div className="mt-0.5 text-[7px]" style={{ ...MONO, color: "#94a3b8" }}>SL ₹{a.rr?.sl?.toFixed(0)}</div>}
        </div>
        <div className="px-3 py-2" style={{ background: isDark ? "#0a0f16" : "#f8fafc" }}>
          <div className="mb-0.5 text-[7px] tracking-[1px]" style={{ ...MONO, color: "#64748b" }}>LOT P&L</div>
          <div className="tabular-nums text-[13px] font-bold" style={{ ...MONO, color: pnlClr }}>{fmtLotPnl((a.currentPnL ?? 0) * LOT_QTY)}</div>
          <div className="text-[8px]" style={{ ...MONO, color: pnlClr }}>{pnlUp ? "+" : ""}{a.pnlPct?.toFixed(1) ?? "0.0"}%</div>
        </div>
      </div>
    </div>
  );
}

function DesktopRow({ a, idx, api, isDark, accent, LOT_QTY, cols, watched, onOpenChart, onAddWatch }: {
  a: AlertRecord; idx: number; api: StrategyApi; isDark: boolean; accent: string; LOT_QTY: number; cols: string; watched: boolean;
  onOpenChart: () => void; onAddWatch: () => void;
}) {
  const isCE = a.direction === "CE";
  const dirClr = isCE ? "#0284c7" : "#e11d48";
  const sm = statusMeta(a.status, a.currentPnL ?? 0, api.hasTwoTargets);
  const isWin = a.status === "TARGET" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) >= 0);
  const isLoss = a.status === "SL" || (a.status === "TIME_EXIT" && (a.currentPnL ?? 0) < 0);
  const rowBg = isWin ? (isDark ? "#052e16" : "#f0fdf4") : isLoss ? (isDark ? "#2d0505" : "#fff5f5") : a.status === "EOD" ? (isDark ? "#1c1500" : "#fefce8") : idx % 2 === 0 ? (isDark ? "#0a0f16" : "#fff") : (isDark ? "#0d1420" : "#fafafa");
  const pnlUp = (a.currentPnL ?? 0) >= 0;
  const pnlColor = pnlUp ? "#16a34a" : "#e11d48";
  const ltp = a.lastLtp ?? a.leg?.ltp ?? a.rr?.entry ?? 0;
  const sl = a.rr?.sl ?? 0;
  const t2 = api.hasTwoTargets ? (a.rr?.target2 ?? 0) : (a.rr?.target ?? 0);
  const fillPct = t2 - sl > 0 ? Math.min(Math.max(((ltp - sl) / (t2 - sl)) * 100, 0), 100) : 50;
  const t1Pct = api.hasTwoTargets && (a.rr?.target2 ?? 0) - sl > 0 ? Math.min((((a.rr?.target1 ?? 0) - sl) / ((a.rr?.target2 ?? 0) - sl)) * 100, 100) : 67;
  const t1Hit = a.t1Hit || a.status === "TARGET";
  const t2Hit = a.status === "TARGET";
  const entry = a.rr?.entry ?? 0;
  const exitP = a.status === "ACTIVE" ? (a.lastLtp ?? entry) : entry + (a.currentPnL ?? 0);
  const charges = calcCharges(entry, exitP, LOT_QTY);

  return (
    <div className="grid items-center border-b transition-colors hover:bg-[rgba(124,58,237,0.04)]" style={{ gridTemplateColumns: cols, borderColor: isDark ? "#0f1923" : "#f1f5f9", background: rowBg }}>
      <div className="px-2 py-2.5 text-[9px]" style={{ ...MONO, color: "#94a3b8" }}>{idx + 1}</div>

      <div className="px-2 py-2.5">
        {api.hasTwoTargets ? (
          <>
            <div className="whitespace-nowrap text-[10px] font-bold" style={{ ...MONO, color: "var(--text)" }}>{fmtTime(a.entryTime)}</div>
            {a.exitTime ? (
              <div className="whitespace-nowrap text-[8px]" style={{ ...MONO, color: "#94a3b8" }}>→{fmtTime(a.exitTime)}</div>
            ) : (
              <div className="whitespace-nowrap text-[8px]" style={{ ...MONO, color: "#94a3b8" }}>{a.strength}</div>
            )}
          </>
        ) : (
          <div className="whitespace-nowrap text-[10px] font-bold" style={{ ...MONO, color: "var(--text)" }}>
            {fmtTime(a.entryTime)}{a.exitTime ? ` → ${fmtTime(a.exitTime)}` : ""}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 px-2 py-2.5">
        {api.hasTwoTargets && (
          <>
            <span className="rounded-sm px-1.5 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: `${dirClr}18`, color: dirClr, border: `1px solid ${dirClr}30` }}>{a.direction} {a.score}/5</span>
            {(a.concepts ?? []).map(c => <span key={c} className="rounded-sm px-1 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: `${CONCEPT_COLOR[c] ?? "#64748b"}14`, color: CONCEPT_COLOR[c] ?? "#64748b" }}>{c}</span>)}
            {a.trendOk && <span className="text-[7px]" style={{ ...MONO, color: "#16a34a" }}>+EMA✓</span>}
          </>
        )}
      </div>

      <div className="px-2 py-2.5">
        <div className="whitespace-nowrap text-[10px] font-bold leading-tight" style={{ ...MONO, color: dirClr }}>NIFTY {fmtExpiry(a.expiry)} {a.strike} {a.direction}</div>
        <div className="text-[8px]" style={{ ...MONO, color: "#94a3b8" }}>spot {a.spot?.toFixed?.(0) ?? "—"}</div>
      </div>

      <div className="tabular-nums px-2 py-2.5 text-[12px] font-bold" style={{ ...MONO, color: dirClr }}>₹{a.rr?.entry?.toFixed(2) ?? "—"}</div>

      <div className="px-2 py-2.5">
        <div className="tabular-nums text-[11px] font-bold" style={{ ...MONO, color: a.status === "ACTIVE" ? (ltp >= (a.rr?.entry ?? 0) ? "#16a34a" : "#e11d48") : "#64748b" }}>₹{ltp?.toFixed?.(2) ?? "—"}</div>
        {a.status === "ACTIVE" && a.lastLtp != null && (
          <div className="text-[8px]" style={{ ...MONO, color: a.lastLtp >= (a.rr?.entry ?? 0) ? "#16a34a" : "#e11d48" }}>{a.lastLtp >= (a.rr?.entry ?? 0) ? "+" : ""}{(a.lastLtp - (a.rr?.entry ?? 0)).toFixed(2)}</div>
        )}
      </div>

      <div className="tabular-nums px-2 py-2.5 text-[11px] font-bold" style={{ ...MONO, color: "#e11d48" }}>₹{a.rr?.sl?.toFixed(2) ?? "—"}</div>

      {/* T1: SMC's own target1, or VWAP930's single target shown here. T2:
          only ever real for SMC — VWAP930 has no second target, so this
          stays a plain "—" rather than duplicating T1's value. */}
      <div className="tabular-nums px-2 py-2.5 text-[11px] font-bold" style={{ ...MONO, color: "#b45309" }}>₹{(a.rr?.target1 ?? a.rr?.target)?.toFixed(2) ?? "—"}</div>
      <div className="tabular-nums px-2 py-2.5 text-[11px] font-bold" style={{ ...MONO, color: "#16a34a" }}>{a.rr?.target2 != null ? `₹${a.rr.target2.toFixed(2)}` : "—"}</div>

      <div className="px-2 py-2.5">
        <div className="mb-0.5 flex items-center gap-1">
          <span className="text-[9px]">{sm.icon}</span>
          <span className="text-[8px] font-bold" style={{ ...MONO, color: sm.color }}>{sm.label}</span>
        </div>
        {api.hasTwoTargets && (
          <div className="mb-0.5 flex gap-1">
            <span className="rounded-sm px-1 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: t1Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t1Hit ? "#15803d" : (isDark ? "#4a6080" : "#94a3b8") }}>T1{t1Hit ? "✓" : "✗"}</span>
            <span className="rounded-sm px-1 py-0.5 text-[7px] font-bold" style={{ ...MONO, background: t2Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t2Hit ? "#15803d" : (isDark ? "#4a6080" : "#94a3b8") }}>T2{t2Hit ? "✓" : "✗"}</span>
          </div>
        )}
        {a.status === "ACTIVE" ? (
          <div className="relative h-1.5 w-full overflow-hidden rounded-full" style={{ background: "#e2e8f0" }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${fillPct}%`, background: fillPct >= 67 ? "#16a34a" : fillPct >= 33 ? "#f59e0b" : "#e11d48" }} />
            {api.hasTwoTargets && <div className="absolute bottom-0 top-0 w-px opacity-70" style={{ left: `${t1Pct}%`, background: "#7c3aed" }} />}
          </div>
        ) : (
          <div className="text-[8px] font-bold" style={{ ...MONO, color: sm.color }}>{fmtLotPnl((a.currentPnL ?? 0) * LOT_QTY)}</div>
        )}
      </div>

      <div className="px-2 py-2.5">
        <div className="tabular-nums text-[12px] font-bold leading-tight" style={{ ...MONO, color: pnlColor }}>{pnlUp ? "+" : "−"}₹{fmtFull((a.currentPnL ?? 0) * LOT_QTY)}</div>
        <div className="tabular-nums mt-0.5 text-[8px] font-bold" style={{ ...MONO, color: pnlColor }}>₹{Math.abs(a.currentPnL ?? 0).toFixed(2)} × {LOT_QTY}</div>
        <div className="text-[8px]" style={{ ...MONO, color: pnlColor }}>{pnlUp ? "+" : ""}{a.pnlPct?.toFixed(2) ?? "0.00"}%</div>
        {a.status !== "ACTIVE" && (a.currentPnL ?? 0) !== 0 && <div className="tabular-nums mt-0.5 text-[8px]" style={{ ...MONO, color: "#64748b" }}>exit ₹{((a.rr?.entry ?? 0) + (a.currentPnL ?? 0)).toFixed(2)}</div>}
      </div>

      <div className="px-2 py-2.5">
        <div className="tabular-nums text-[11px] font-bold" style={{ ...MONO, color: "#b45309" }}>−₹{fmtFull(charges)}</div>
        <div className="mt-0.5 text-[7px]" style={{ ...MONO, color: "#94a3b8" }}>{a.status === "ACTIVE" ? "est." : "incl. STT+GST"}</div>
      </div>

      <div className="px-2 py-2.5">
        {(a.peakMove ?? 0) > 0 ? (
          <>
            <div className="tabular-nums text-[11px] font-bold" style={{ ...MONO, color: "#7c3aed" }}>+{a.peakMove.toFixed(2)}</div>
            <div className="tabular-nums text-[8px] font-bold" style={{ ...MONO, color: "#7c3aed" }}>+{((a.peakMove / (a.rr?.entry || 1)) * 100).toFixed(1)}%</div>
          </>
        ) : <div className="text-[9px]" style={{ ...MONO, color: "#94a3b8" }}>—</div>}
      </div>

      <div className="px-2 py-2.5">
        {(a.peakMove ?? 0) > 0 ? (
          <>
            <div className="tabular-nums text-[12px] font-bold leading-tight" style={{ ...MONO, color: "#7c3aed" }}>+₹{fmtFull(a.peakMove * LOT_QTY)}</div>
            <div className="tabular-nums mt-0.5 text-[8px] font-bold" style={{ ...MONO, color: "#7c3aed" }}>{a.peakMove.toFixed(2)} × {LOT_QTY}</div>
            <div className="tabular-nums text-[8px] font-bold" style={{ ...MONO, color: "#7c3aed" }}>+{((a.peakMove / (a.rr?.entry || 1)) * 100).toFixed(1)}%</div>
          </>
        ) : <div className="text-[9px]" style={{ ...MONO, color: "#94a3b8" }}>—</div>}
      </div>

      <div className="flex items-center justify-center gap-1 px-2 py-2.5">
        {a.leg && (
          <button onClick={onOpenChart} title="Open chart" className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded" style={{ color: dirClr, opacity: 0.7 }}>
            <IconChartCandle size={14} color={dirClr} />
          </button>
        )}
        {a.leg && a.status === "ACTIVE" && !watched && (
          <button onClick={onAddWatch} title="Add to watchlist" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border text-[11px] font-bold transition-all" style={{ background: `${dirClr}15`, borderColor: `${dirClr}50`, color: dirClr }}>+</button>
        )}
      </div>
      {/* Trailing filler column (VWAP930 only) — soaks up leftover width on
          wide screens without stretching any real data column. */}
      {!api.hasTwoTargets && <div />}
    </div>
  );
}

function Pill({ active, activeColor, label }: { active: boolean; activeColor: string; label: string }) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1" style={{ background: active ? `${activeColor}0d` : "var(--card)", borderColor: active ? `${activeColor}66` : "var(--border)" }}>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${active ? "live-pulse" : ""}`} style={{ background: active ? activeColor : "var(--flat)" }} />
      <span className="hidden whitespace-nowrap text-[9px] font-bold sm:block" style={{ ...MONO, color: active ? activeColor : "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

function WinRatePill({ wr, wins, losses, eod }: { wr: string; wins: number; losses: number; eod?: number }) {
  const good = Number(wr) >= 70;
  const { theme } = useTheme();
  const isDark = theme === "dark";
  return (
    <div className="hidden flex-shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 md:flex" style={{ background: good ? (isDark ? "#052e16" : "#f0fdf4") : (isDark ? "#2d0505" : "#fef2f2"), borderColor: good ? (isDark ? "#166534" : "#bbf7d0") : (isDark ? "#991b1b" : "#fecaca") }}>
      <span className="whitespace-nowrap text-[9px] font-bold" style={{ ...MONO, color: good ? "#16a34a" : "#e11d48" }}>{wr}% · {wins}W/{losses}L{eod ? ` · ${eod}E` : ""}</span>
    </div>
  );
}
