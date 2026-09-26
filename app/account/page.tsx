"use client";

// ─── Account tab ────────────────────────────────────────────────────────────────
// Ported to match frontend/components/AccountTab.tsx's exact 3-card summary
// layout (Wallet / Charges Today / Overall P&L — same field order, same
// accent colors #16a34a/#f59e0b/#ea580c, same detail-row structure and the
// margin-utilisation bar), the Lock All / Stop Loss / Target / Breakeven
// toggle rows and Auto-Trade Defaults (Qty/Product/Mode) settings section —
// the same /api/settings + /api/settings/account-defaults +
// /api/settings/global-lock endpoints the auto-trade engine itself reads —
// the full PositionCard (logo, live SL/Target/Lock-Points monitor that
// auto-exits on trigger, Instant Exit) — and the order book below it.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";

const MONO = { fontFamily: "'Space Mono', monospace" } as const;

type AccountData = {
  wallet: { available: number; used: number; net: number; deposit: number; withdrawal: number };
  charges: { brokerage: number; stt: number; exchange: number; sebi: number; gst: number; stampDuty: number; total: number };
  pnl: { realised: number; unrealised: number; total: number };
  positions: Array<{ tradingsymbol: string; token: number | null; direction: string | null; strike: number | null; quantity: number; buyPrice: number; sellPrice: number; currentPrice: number; pnl: number; status: "OPEN" | "CLOSED"; entryTime: string | null; exitTime: string | null; durationSecs: number | null }>;
  stats: { totalTrades: number; openTrades: number; winners: number; losers: number; winRate: number; avgPnl: number };
  orderBook: Array<{ order_id: string; tradingsymbol: string; transaction_type: string; quantity: number; price: number; order_type: string; status: string; status_message: string | null }>;
};

type AccountDefaults = {
  lockPoints: number | null;
  stopLoss: number | null;
  target: number | null;
  quantity: number;
  productType: string;
  tradingMode: "LIVE" | "PAPER";
  breakevenTriggerPct: number | null;
};

type ToastKind = "success" | "error";
type ToastItem = { id: number; text: string; kind: ToastKind };

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtClock(t: string | null): string {
  if (!t) return "—";
  return t.replace(/\s?(am|pm)$/i, m => m.toUpperCase());
}

function fmtDuration(secs: number | null): string {
  if (secs === null || secs < 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function AccountPage() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const border = isDark ? "#1e293b" : "#e2e8f0";
  const rowBorder = isDark ? "#1e293b" : "#f1f5f9";
  const subtext = isDark ? "#64748b" : "#94a3b8";
  const muted = isDark ? "#94a3b8" : "#64748b";

  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  function showToast(text: string, kind: ToastKind = "success") {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2800);
  }

  const [accountDefaults, setAccountDefaults] = useState<AccountDefaults | null>(null);
  const [globalLockOn, setGlobalLockOn] = useState(false);
  const [globalLockPts, setGlobalLockPts] = useState<number | null>(null);
  const [globalLockInput, setGlobalLockInput] = useState("");
  const [showDefSl, setShowDefSl] = useState(false);
  const [defSlInput, setDefSlInput] = useState("");
  const [showDefTarget, setShowDefTarget] = useState(false);
  const [defTargetInput, setDefTargetInput] = useState("");
  const [showDefBreakeven, setShowDefBreakeven] = useState(false);
  const [defBreakevenInput, setDefBreakevenInput] = useState("");

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(s => {
      setAccountDefaults(s.accountDefaults);
      setDefSlInput(s.accountDefaults.stopLoss != null ? String(s.accountDefaults.stopLoss) : "");
      setDefTargetInput(s.accountDefaults.target != null ? String(s.accountDefaults.target) : "");
      setDefBreakevenInput(s.accountDefaults.breakevenTriggerPct != null ? String(s.accountDefaults.breakevenTriggerPct) : "");
      setShowDefSl(s.accountDefaults.stopLoss != null);
      setShowDefTarget(s.accountDefaults.target != null);
      setShowDefBreakeven(s.accountDefaults.breakevenTriggerPct != null);
      setGlobalLockOn(s.globalLock?.on ?? false);
      setGlobalLockPts(s.globalLock?.pts ?? null);
      setGlobalLockInput(s.globalLock?.pts != null ? String(s.globalLock.pts) : "");
    }).catch(() => setAccountDefaults({
      lockPoints: null, stopLoss: null, target: null,
      quantity: 10, productType: "INTRADAY", tradingMode: "PAPER",
      breakevenTriggerPct: null,
    }));
  }, []);

  async function updateAccountDefaults(patch: Partial<AccountDefaults>, label: string) {
    const prev = accountDefaults;
    setAccountDefaults(d => (d ? { ...d, ...patch } : d));
    try {
      const updated = await fetch("/api/settings/account-defaults", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(r => r.json());
      if (updated.error) throw new Error(updated.error);
      setAccountDefaults(updated.accountDefaults);
      showToast(label);
    } catch (e: any) {
      setAccountDefaults(prev);
      showToast(`Failed to save — ${e.message}`, "error");
    }
  }

  async function updateGlobalLock(patch: { on?: boolean; pts?: number | null }) {
    return fetch("/api/settings/global-lock", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(r => r.json());
  }

  function toggleGlobalLock() {
    if (globalLockOn) {
      setGlobalLockOn(false); setGlobalLockInput("");
      updateGlobalLock({ on: false, pts: null }).then(() => showToast("Lock All disabled")).catch(() => {});
      setGlobalLockPts(null);
    } else setGlobalLockOn(true);
  }
  function applyGlobalLock() {
    const pts = parseFloat(globalLockInput);
    if (isNaN(pts) || pts <= 0) return;
    setGlobalLockPts(pts);
    updateGlobalLock({ on: true, pts }).then(() => showToast("Lock All enabled")).catch((e: any) => showToast(`Failed to save — ${e.message}`, "error"));
  }

  function toggleDefSl() {
    if (showDefSl) { setShowDefSl(false); setDefSlInput(""); updateAccountDefaults({ stopLoss: null }, "Default Stop Loss disabled"); }
    else setShowDefSl(true);
  }
  function saveDefSl() {
    const v = defSlInput === "" ? null : parseFloat(defSlInput);
    if (v === null || (!isNaN(v) && v > 0)) updateAccountDefaults({ stopLoss: v }, v === null ? "Default Stop Loss cleared" : `Default Stop Loss set to ${v} pts`);
  }
  function toggleDefTarget() {
    if (showDefTarget) { setShowDefTarget(false); setDefTargetInput(""); updateAccountDefaults({ target: null }, "Default Target disabled"); }
    else setShowDefTarget(true);
  }
  function saveDefTarget() {
    const v = defTargetInput === "" ? null : parseFloat(defTargetInput);
    if (v === null || (!isNaN(v) && v > 0)) updateAccountDefaults({ target: v }, v === null ? "Default Target cleared" : `Default Target set to ${v} pts`);
  }
  function toggleDefBreakeven() {
    if (showDefBreakeven) { setShowDefBreakeven(false); setDefBreakevenInput(""); updateAccountDefaults({ breakevenTriggerPct: null }, "Breakeven SL trigger disabled — using each strategy's default"); }
    else setShowDefBreakeven(true);
  }
  function saveDefBreakeven() {
    const v = defBreakevenInput === "" ? null : parseFloat(defBreakevenInput);
    if (v === null || (!isNaN(v) && v > 0)) updateAccountDefaults({ breakevenTriggerPct: v }, v === null ? "Breakeven SL trigger cleared — using each strategy's default" : `Breakeven SL trigger set to ${v}%`);
  }

  const load = useCallback(() => {
    fetch("/api/account").then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setData(d); setError(null); }).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  async function exitAll() {
    if (!confirm("Exit ALL open positions at market?")) return;
    setBusy(true);
    try { await fetch("/api/account/exit-all", { method: "POST" }); load(); } finally { setBusy(false); }
  }

  const [exitingSet, setExitingSet] = useState<Set<string>>(new Set());
  async function handleExit(p: AccountData["positions"][number]) {
    if (!p.token) return;
    setExitingSet(prev => new Set(prev).add(p.tradingsymbol));
    try {
      await fetch("/api/account/exit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ security_id: p.token, tradingsymbol: p.tradingsymbol, quantity: p.quantity, limit_price: p.currentPrice || p.buyPrice }),
      });
      load();
    } finally {
      setExitingSet(prev => { const next = new Set(prev); next.delete(p.tradingsymbol); return next; });
    }
  }

  if (error) return <div className="p-5"><Notice>{error}</Notice></div>;
  if (!data) return <div className="p-5 text-sm text-muted">Loading account…</div>;

  const open = data.positions.filter(p => p.status === "OPEN");
  const closed = data.positions.filter(p => p.status === "CLOSED");
  const net = +(data.pnl.unrealised - data.charges.total).toFixed(2);
  const marginTotal = data.wallet.used + data.wallet.available;
  const marginPct = marginTotal > 0 ? Math.min(100, +((data.wallet.used / marginTotal) * 100).toFixed(1)) : 0;
  const barColor = marginPct > 80 ? "#e11d48" : marginPct > 50 ? "#f59e0b" : "#16a34a";

  return (
    <div className="px-3 py-4 md:px-5">
      {/* ── Three summary cards — exact field set/order as AccountTab.tsx ── */}
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        <SCard title="Wallet" accent="#16a34a">
          <div className="px-4 pb-3">
            <div className="text-[28px] font-black leading-none" style={{ ...MONO, color: "#16a34a" }}>₹{fmt(data.wallet.available)}</div>
            <div className="mt-0.5 text-[10px]" style={{ ...MONO, color: subtext }}>Available Balance</div>
          </div>
          <div className="border-t" style={{ borderColor: border }}>
            <Row label="Used Margin" value={`₹${fmt(data.wallet.used)}`} color="#f59e0b" />
            <Row label="Net Balance" value={`₹${fmt(data.wallet.net)}`} color={muted} />
            <div className="flex border-b" style={{ borderColor: rowBorder }}>
              <div className="flex flex-1 items-center gap-1.5 border-r px-4 py-2" style={{ borderColor: rowBorder }}>
                <span className="text-[9px]" style={{ ...MONO, color: subtext }}>↓ Deposit</span>
                <span className="ml-auto text-[11px] font-bold" style={{ ...MONO, color: data.wallet.deposit > 0 ? "#16a34a" : muted }}>₹{fmt(data.wallet.deposit)}</span>
              </div>
              <div className="flex flex-1 items-center gap-1.5 px-4 py-2">
                <span className="text-[9px]" style={{ ...MONO, color: subtext }}>↑ Withdrawal</span>
                <span className="ml-auto text-[11px] font-bold" style={{ ...MONO, color: data.wallet.withdrawal > 0 ? "#e11d48" : muted }}>₹{fmt(data.wallet.withdrawal)}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex justify-between text-[9px]" style={MONO}>
                <span style={{ color: subtext }}>Margin Utilisation</span>
                <span style={{ color: barColor, fontWeight: 700 }}>{marginPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full" style={{ background: rowBorder }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${marginPct}%`, background: barColor }} />
              </div>
            </div>
          </div>
        </SCard>

        <SCard title="Charges Today" accent="#f59e0b">
          <div className="px-4 pb-3">
            <div className="text-[28px] font-black leading-none" style={{ ...MONO, color: "#f59e0b" }}>₹{fmt(data.charges.total)}</div>
            <div className="mt-0.5 text-[10px]" style={{ ...MONO, color: subtext }}>Total Charges</div>
          </div>
          <div className="grid grid-cols-2 border-t" style={{ borderColor: border }}>
            <div className="flex flex-col border-r" style={{ borderColor: border }}>
              {[["Brokerage", data.charges.brokerage], ["STT", data.charges.stt], ["Exchange Turnover", data.charges.exchange], ["SEBI Turnover", data.charges.sebi]].map(([l, v], i, arr) => (
                <div key={l as string} className="flex items-center justify-between px-3 py-2" style={i < arr.length - 1 ? { borderBottom: `1px solid ${rowBorder}` } : undefined}>
                  <span className="text-[9px]" style={{ ...MONO, color: subtext }}>{l}</span>
                  <span className="text-[10px] font-bold" style={{ ...MONO, color: muted }}>₹{fmt(v as number)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col">
              {[["GST", data.charges.gst], ["Stamp Duty", data.charges.stampDuty]].map(([l, v], i, arr) => (
                <div key={l as string} className="flex items-center justify-between px-3 py-2" style={i < arr.length - 1 ? { borderBottom: `1px solid ${rowBorder}` } : undefined}>
                  <span className="text-[9px]" style={{ ...MONO, color: subtext }}>{l}</span>
                  <span className="text-[10px] font-bold" style={{ ...MONO, color: muted }}>₹{fmt(v as number)}</span>
                </div>
              ))}
            </div>
          </div>
        </SCard>

        <SCard title="Overall P&L" accent="#ea580c">
          <div className="px-4 pb-3">
            <div className="text-[28px] font-black leading-none" style={{ ...MONO, color: net >= 0 ? "#16a34a" : "#e11d48" }}>{net >= 0 ? "+" : ""}₹{fmt(net)}</div>
            <div className="mt-0.5 text-[10px]" style={{ ...MONO, color: subtext }}>Gross P&amp;L (Today)</div>
          </div>
          <div className="border-t" style={{ borderColor: border }}>
            <Row label="Realised" value={`${data.pnl.realised >= 0 ? "+" : ""}₹${fmt(Math.abs(data.pnl.realised))}`} color={data.pnl.realised >= 0 ? "#16a34a" : "#e11d48"} />
            <Row label="Unrealised" value={`${data.pnl.unrealised >= 0 ? "+" : ""}₹${fmt(Math.abs(data.pnl.unrealised))}`} color={data.pnl.unrealised >= 0 ? "#16a34a" : "#e11d48"} />
            <Row label="Charges" value={`-₹${fmt(data.charges.total)}`} color="#e11d48" />
            <div className="flex items-center justify-between px-4 py-3" style={{ background: net >= 0 ? "rgba(22,163,74,0.07)" : "rgba(225,29,72,0.07)" }}>
              <span className="text-[10px] font-bold" style={{ ...MONO, color: net >= 0 ? "#16a34a" : "#e11d48" }}>Net (after charges)</span>
              <span className="text-[13px] font-black" style={{ ...MONO, color: net >= 0 ? "#16a34a" : "#e11d48" }}>{net >= 0 ? "+" : ""}₹{fmt(net)}</span>
            </div>
          </div>
        </SCard>
      </div>

      <div className="mb-4 rounded-[var(--radius-sm)] border p-2.5 text-xs" style={{ borderColor: "var(--border)", background: "var(--card)", color: "var(--text-muted)" }}>
        Charges (including the STT/exchange/SEBI/GST/stamp-duty split) are computed per order via INDstocks&apos; own <code>GET /margin</code> — the same figures a contract note would show, not an estimate. Only falls back to a rate-schedule approximation if that call is ever unreachable.
      </div>

      {/* ── Lock All / Stop Loss / Target / Breakeven — one shared toggle row ── */}
      <div className="mb-3 flex flex-col gap-2.5">
        <ToggleField label="🔒 Lock All" show={globalLockOn} onToggle={toggleGlobalLock}
          value={globalLockPts} input={globalLockInput} setInput={setGlobalLockInput}
          onApply={applyGlobalLock} activeColor="#6366f1" />
        <ToggleField label="🛑 Stop Loss" show={showDefSl} onToggle={toggleDefSl}
          value={accountDefaults?.stopLoss ?? null} input={defSlInput} setInput={setDefSlInput}
          onApply={saveDefSl} activeColor="#e11d48" />
        <ToggleField label="🎯 Target" show={showDefTarget} onToggle={toggleDefTarget}
          value={accountDefaults?.target ?? null} input={defTargetInput} setInput={setDefTargetInput}
          onApply={saveDefTarget} activeColor="#16a34a" />
        <ToggleField label="⚖️ Breakeven SL Trigger" show={showDefBreakeven} onToggle={toggleDefBreakeven}
          value={accountDefaults?.breakevenTriggerPct ?? null} input={defBreakevenInput} setInput={setDefBreakevenInput}
          onApply={saveDefBreakeven} activeColor="#7c3aed" unit="%" />
      </div>

      {/* ── Auto-trade account defaults (persisted to DB) ── */}
      <div className="mb-4 flex flex-col gap-3 rounded-2xl border px-3.5 py-3.5" style={{ borderColor: border, background: isDark ? "#0f172a" : "#f8f8ff" }}>
        <span className="text-[9px] font-bold uppercase tracking-[1px]" style={{ ...MONO, color: subtext }}>⚙ Auto-Trade Defaults</span>
        <div className="flex flex-col gap-2.5 lg:flex-row lg:flex-nowrap lg:items-center lg:gap-4 lg:overflow-x-auto">
          <div className="flex w-full flex-shrink-0 items-center justify-between gap-2 lg:w-auto lg:justify-start">
            <span className="text-[10px] font-semibold" style={{ color: subtext }}>Qty</span>
            <SegmentToggle options={[1, 2, 5, 10, 15, 20].map(q => ({ value: q, label: String(q) }))}
              value={accountDefaults?.quantity ?? 10} activeColor="#6366f1"
              onChange={v => updateAccountDefaults({ quantity: v as number }, `Quantity set to ${v} lots`)} />
          </div>
          <div className="flex w-full flex-shrink-0 items-center justify-between gap-2 lg:w-auto lg:justify-start">
            <span className="text-[10px] font-semibold" style={{ color: subtext }}>Product</span>
            <SegmentToggle options={[{ value: "INTRADAY", label: "INTRADAY" }, { value: "MARGIN", label: "MARGIN" }]}
              value={accountDefaults?.productType ?? "INTRADAY"} activeColor="#0284c7"
              onChange={v => updateAccountDefaults({ productType: v as string }, `Product set to ${v}`)} />
          </div>
          <div className="flex w-full flex-shrink-0 items-center justify-between gap-2 lg:w-auto lg:justify-start">
            <span className="text-[10px] font-semibold" style={{ color: subtext }}>Mode</span>
            <SegmentToggle options={[{ value: "LIVE", label: "LIVE" }, { value: "PAPER", label: "PAPER" }]}
              value={accountDefaults?.tradingMode ?? "PAPER"} activeColor={accountDefaults?.tradingMode === "PAPER" ? "#f59e0b" : "#16a34a"}
              onChange={v => updateAccountDefaults({ tradingMode: v as "LIVE" | "PAPER" }, v === "PAPER" ? "PAPER mode enabled — orders will be simulated" : "LIVE mode enabled — real orders will be placed")} />
          </div>
        </div>
      </div>

      {open.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-faint">Open Positions</div>
            <button onClick={exitAll} disabled={busy} className="rounded-[var(--radius-sm)] px-3 py-1 text-xs font-semibold text-white transition-colors disabled:opacity-50" style={{ background: "#e11d48" }}>Exit All</button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {open.map(p => (
              <PositionCard key={p.tradingsymbol} p={p} onExit={() => handleExit(p)} isExiting={exitingSet.has(p.tradingsymbol)}
                defaultLockPts={globalLockOn ? globalLockPts : null} accountDefaults={accountDefaults} />
            ))}
          </div>
        </div>
      )}

      {closed.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Closed Today</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {closed.map(p => <PositionCard key={p.tradingsymbol} p={p} />)}
          </div>
        </div>
      )}

      <ReportDownloader todayData={data} />

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Order Book</div>
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full min-w-[600px] border-collapse text-sm">
            <thead><tr className="text-[11px] uppercase tracking-wide text-faint"><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th><Th>Price</Th><Th>Type</Th><Th>Status</Th></tr></thead>
            <tbody>
              {data.orderBook.map(o => (
                <React.Fragment key={o.order_id}>
                  <tr className="border-t border-[var(--border)]">
                    <Td>{o.tradingsymbol}</Td>
                    <Td style={{ color: o.transaction_type === "BUY" ? "var(--up)" : "var(--down)" }}>{o.transaction_type}</Td>
                    <Td>{o.quantity}</Td><Td>₹{o.price.toFixed(2)}</Td><Td>{o.order_type}</Td><Td>{o.status}</Td>
                  </tr>
                  {o.status_message && (
                    <tr className="border-t-0">
                      <td colSpan={6} className="px-2 pb-1.5 text-[10px]" style={{ color: "#e11d48" }}>⚠ {o.status_message}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ToastStack toasts={toasts} />
    </div>
  );
}

function SegmentToggle<T extends string | number>({ options, value, onChange, activeColor }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; activeColor: string;
}) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-lg p-0.5" style={{ background: isDark ? "#1e293b" : "#eef1f6" }}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button key={String(opt.value)} type="button" onClick={() => onChange(opt.value)}
            className="rounded-md px-2.5 py-1 text-[10px] font-bold transition-all duration-150 active:scale-95"
            style={{ background: active ? activeColor : "transparent", color: active ? "#fff" : (isDark ? "#94a3b8" : "#64748b"), ...MONO }}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ToggleField({ label, show, onToggle, value, input, setInput, onApply, activeColor, unit = "pts" }: {
  label: string; show: boolean; onToggle: () => void; value: number | null;
  input: string; setInput: (v: string) => void; onApply: () => void; activeColor: string; unit?: string;
}) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const text = isDark ? "#e2e8f0" : "#1a2332";
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-2xl px-3.5 py-2.5 transition-colors duration-200"
      style={{ background: isDark ? "#0f172a" : "#f8f8ff", border: `1px solid ${show ? `${activeColor}50` : (isDark ? "#1e293b" : "#e2e8f0")}`, boxShadow: show ? `0 0 0 3px ${activeColor}12` : "none" }}>
      <button onClick={onToggle} className="flex flex-shrink-0 items-center gap-2 transition-transform active:scale-95">
        <div className="relative h-[22px] w-10 rounded-full transition-colors duration-200" style={{ background: show ? activeColor : (isDark ? "#334155" : "#cbd5e1") }}>
          <div className="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform duration-200" style={{ transform: show ? "translateX(20px)" : "translateX(3px)" }} />
        </div>
        <span className="flex items-center gap-1 text-[11px] font-bold" style={{ color: show ? activeColor : text }}>{label}</span>
      </button>
      {show && (
        <>
          <input type="number" min="1" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && onApply()}
            placeholder={`${unit} e.g. 10`} className="min-w-[90px] flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold outline-none"
            style={{ background: isDark ? "#1e293b" : "#fff", color: text, border: `1px solid ${activeColor}40`, ...MONO }} />
          <button onClick={onApply} className="flex-shrink-0 rounded-lg px-3 py-1.5 text-[10px] font-bold text-white transition-transform active:scale-95" style={{ background: activeColor }}>Set All</button>
          {value != null && (
            <span className="flex-shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-[9px] font-bold" style={{ background: `${activeColor}15`, color: activeColor }}>+{value} {unit} active</span>
          )}
        </>
      )}
    </div>
  );
}

function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-5 left-1/2 z-[999] flex flex-col items-center gap-2 px-4" style={{ transform: "translateX(-50%)" }}>
      {toasts.map(t => (
        <div key={t.id} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[11px] font-bold"
          style={{ background: t.kind === "success" ? "#16a34a" : "#e11d48", color: "#fff", ...MONO, boxShadow: "0 8px 24px rgba(0,0,0,0.28)", maxWidth: "min(90vw, 360px)" }}>
          <span>{t.kind === "success" ? "✓" : "✕"}</span>
          <span className="truncate">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function SCard({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const bg = isDark ? "#0f172a" : "#fff";
  const border = isDark ? "#1e293b" : "#e2e8f0";
  const subtext = isDark ? "#64748b" : "#94a3b8";
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border" style={{ background: bg, borderColor: border, borderTop: `2px solid ${accent}` }}>
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <span className="text-[10px] font-bold uppercase tracking-[1.8px]" style={{ ...MONO, color: subtext }}>{title}</span>
      </div>
      {children}
    </div>
  );
}
function Row({ label, value, color }: { label: string; value: string; color: string }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const border = isDark ? "#1e293b" : "#e2e8f0";
  const subtext = isDark ? "#64748b" : "#94a3b8";
  return (
    <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: border }}>
      <span className="text-[10px]" style={{ ...MONO, color: subtext }}>{label}</span>
      <span className="text-[11px] font-bold" style={{ ...MONO, color }}>{value}</span>
    </div>
  );
}

// ─── SL/TP/Lock persistence (survives page refresh) — ported verbatim from
// frontend/components/AccountTab.tsx, keyed by the real tradingsymbol. ──────
type SLTPStore = { sl: number | null; tp: number | null; lockPts: number | null; lockDir: "up" | "down" | null };
const EMPTY_SLTP: SLTPStore = { sl: null, tp: null, lockPts: null, lockDir: null };
function sltpKey(tradingsymbol: string) { return `algo:sltp:${tradingsymbol}`; }
function loadSLTP(tradingsymbol: string): SLTPStore {
  if (typeof window === "undefined") return EMPTY_SLTP;
  try {
    const raw = window.localStorage.getItem(sltpKey(tradingsymbol));
    return raw ? { ...EMPTY_SLTP, ...JSON.parse(raw) } : EMPTY_SLTP;
  } catch { return EMPTY_SLTP; }
}
function saveSLTP(tradingsymbol: string, patch: Partial<SLTPStore>) {
  if (typeof window === "undefined") return;
  try {
    const next = { ...loadSLTP(tradingsymbol), ...patch };
    if (next.sl == null && next.tp == null && next.lockPts == null) window.localStorage.removeItem(sltpKey(tradingsymbol));
    else window.localStorage.setItem(sltpKey(tradingsymbol), JSON.stringify(next));
  } catch {}
}

function IndexLogo({ tradingsymbol }: { tradingsymbol: string }) {
  const isSensex = tradingsymbol.startsWith("SENSEX") || tradingsymbol.startsWith("BSX");
  const typeColor = tradingsymbol.endsWith("PE") ? "#e11d48" : "#16a34a";
  return (
    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ border: `2px solid ${typeColor}`, background: "#111" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={isSensex ? "/sensex-logo.avif" : "/nifty-logo.png"} alt={isSensex ? "SENSEX" : "NIFTY 50"} className="h-full w-full object-cover" />
    </div>
  );
}

// ─── Position card — full port of frontend/components/AccountTab.tsx's
// PositionCard: header (logo/qty/price/%), entry/exit/gain-loss stats, Lock
// Points input, the SL/Target/Lock chips with a live MONITORING badge, the
// SL/Target edit panel, and Instant Exit — including the actual watcher
// effect that auto-exits when the live price crosses whichever threshold is
// set. SCOPE CUT, stated plainly: the original's entry→exit duration
// timeline is dropped — INDstocks' order-book response carries no fill
// timestamp anywhere in this app yet, so that row would have to show fake
// data; better to omit it than invent it.
function PositionCard({ p, onExit, isExiting, defaultLockPts, accountDefaults }: {
  p: AccountData["positions"][number]; onExit?: () => void; isExiting?: boolean;
  defaultLockPts?: number | null; accountDefaults?: AccountDefaults | null;
}) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const border = isDark ? "#1e293b" : "#e8edf2";
  const subtext = isDark ? "#94a3b8" : "#8a9bb0";
  const text = isDark ? "#e2e8f0" : "#1a2332";
  const cardBg = isDark ? "#0f172a" : "#ffffff";

  const isOpen = p.status === "OPEN";
  const pnlVal = p.pnl;
  const pnlColor = pnlVal > 0 ? "#16a34a" : pnlVal < 0 ? "#e11d48" : subtext;
  // currentPrice reads 0 when the live feed hasn't ticked this symbol yet
  // (e.g. right after a restart) — treating that as "down 100%" on a real
  // open position would be an alarming fake number, not a real loss.
  const pricePct = p.buyPrice > 0 && p.currentPrice > 0 ? ((p.currentPrice - p.buyPrice) / p.buyPrice * 100) : 0;
  const pctUp = pricePct >= 0;

  const [showSLTP, setShowSLTP] = useState(false);
  const [slInput, setSlInput] = useState(() => { const v = loadSLTP(p.tradingsymbol).sl; return v != null ? String(v) : ""; });
  const [tpInput, setTpInput] = useState(() => { const v = loadSLTP(p.tradingsymbol).tp; return v != null ? String(v) : ""; });
  const [slSet, setSlSet] = useState<number | null>(() => loadSLTP(p.tradingsymbol).sl);
  const [tpSet, setTpSet] = useState<number | null>(() => loadSLTP(p.tradingsymbol).tp);
  const [lockInput, setLockInput] = useState(() => { const v = loadSLTP(p.tradingsymbol).lockPts; return v != null ? String(v) : ""; });
  const [lockSet, setLockSet] = useState<number | null>(() => loadSLTP(p.tradingsymbol).lockPts);
  const [lockDir, setLockDir] = useState<"up" | "down" | null>(() => loadSLTP(p.tradingsymbol).lockDir);
  const lockTarget = lockSet !== null && p.buyPrice > 0 ? p.buyPrice + lockSet : null;

  function confirmSLTP() {
    const sl = parseFloat(slInput), tp = parseFloat(tpInput);
    const patch: Partial<SLTPStore> = {};
    if (!isNaN(sl) && sl > 0) { setSlSet(sl); patch.sl = sl; }
    if (!isNaN(tp) && tp > 0) { setTpSet(tp); patch.tp = tp; }
    if (Object.keys(patch).length) saveSLTP(p.tradingsymbol, patch);
    setShowSLTP(false);
  }
  function applyLockPoints() {
    const pts = parseFloat(lockInput);
    if (!isNaN(pts) && pts > 0) {
      const target = p.buyPrice + pts;
      const dir = p.currentPrice >= target ? "down" : "up";
      setLockDir(dir); setLockSet(pts);
      saveSLTP(p.tradingsymbol, { lockPts: pts, lockDir: dir });
    }
  }

  const movePts = +((isOpen ? p.currentPrice : p.sellPrice) - p.buyPrice).toFixed(2);
  const triggeredRef = useRef(false);
  const onExitRef = useRef(onExit);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);

  // Auto-exit when the live price hits SL, TP, or the Lock target
  useEffect(() => {
    if (!isOpen || triggeredRef.current) return;
    const cmp = p.currentPrice;
    if (cmp <= 0) return;
    const hitSL = slSet !== null && cmp <= slSet;
    const hitTP = tpSet !== null && cmp >= tpSet;
    const hitLock = lockTarget !== null && (lockDir === "down" ? cmp <= lockTarget : cmp >= lockTarget);
    if ((hitSL || hitTP || hitLock) && onExitRef.current) { triggeredRef.current = true; onExitRef.current(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.currentPrice, slSet, tpSet, lockTarget, isOpen]);
  useEffect(() => { triggeredRef.current = false; }, [slSet, tpSet, lockSet, lockDir]);
  useEffect(() => { if (!isOpen) saveSLTP(p.tradingsymbol, { sl: null, tp: null, lockPts: null, lockDir: null }); }, [isOpen, p.tradingsymbol]);

  // One-time seed from Auto-Trade Defaults for a genuinely new position
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !accountDefaults || p.buyPrice <= 0) return;
    const existing = loadSLTP(p.tradingsymbol);
    if (existing.sl != null || existing.tp != null) { seededRef.current = true; return; }
    seededRef.current = true;
    const patch: Partial<SLTPStore> = {};
    if (accountDefaults.stopLoss != null) { const sl = +(p.buyPrice - accountDefaults.stopLoss).toFixed(2); setSlSet(sl); setSlInput(String(sl)); patch.sl = sl; }
    if (accountDefaults.target != null) { const tp = +(p.buyPrice + accountDefaults.target).toFixed(2); setTpSet(tp); setTpInput(String(tp)); patch.tp = tp; }
    if (Object.keys(patch).length) saveSLTP(p.tradingsymbol, patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountDefaults]);

  // Global "Lock All" toggle
  const prevDefaultLockPts = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevDefaultLockPts.current;
    prevDefaultLockPts.current = defaultLockPts;
    if (defaultLockPts != null && defaultLockPts > 0 && p.buyPrice > 0) {
      const target = p.buyPrice + defaultLockPts;
      const dir = p.currentPrice >= target ? "down" : "up";
      setLockDir(dir); setLockSet(defaultLockPts); setLockInput(String(defaultLockPts));
      saveSLTP(p.tradingsymbol, { lockPts: defaultLockPts, lockDir: dir });
    } else if (defaultLockPts == null && prev != null) {
      setLockSet(null); setLockDir(null); setLockInput("");
      saveSLTP(p.tradingsymbol, { lockPts: null, lockDir: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultLockPts]);

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl" style={{ background: cardBg, border: `1px solid ${border}`, boxShadow: isDark ? "none" : "0 2px 10px rgba(0,0,0,0.06)" }}>
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <IndexLogo tradingsymbol={p.tradingsymbol} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 flex-1 text-[12px] font-bold leading-snug" style={{ color: text }}>
              {p.strike ? `NIFTY ${p.strike} ${p.direction === "CE" ? "Call" : "Put"}` : p.tradingsymbol}
            </span>
            {isOpen ? (
              <span className="flex flex-shrink-0 items-center gap-1 text-[10px] font-semibold" style={{ color: isDark ? "#64748b" : "#6b7a90" }}>
                <span style={{ fontSize: 12 }}>🧳</span>{p.quantity} QTY
              </span>
            ) : (
              <span className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ color: "#16a34a", background: "#16a34a15" }}>
                <span style={{ fontSize: 10 }}>✓</span>{p.quantity} QTY Traded
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px]" style={{ color: subtext }}>Price:</span>
            <span className="text-[12px] font-bold" style={{ color: text }}>₹{fmt(p.currentPrice || p.buyPrice)}</span>
            {p.buyPrice > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] font-bold" style={{ color: pctUp ? "#16a34a" : "#e11d48" }}>
                {pctUp ? "▲" : "▼"} {Math.abs(pricePct).toFixed(2)}%
              </span>
            )}
            <div className="ms-auto mt-0.5 text-[10px] font-semibold" style={{ ...MONO, color: pnlColor }}>{movePts >= 0 ? "+" : ""}{fmt(movePts)} × {p.quantity}</div>
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: border, marginBottom: 2 }} />

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1 pt-3">
        <span style={{ color: subtext, fontSize: 12 }}>⏱</span>
        <span className="text-[10px] font-bold" style={{ ...MONO, color: text }}>{fmtClock(p.entryTime)}</span>
        <span style={{ color: subtext }}>→</span>
        <span className="text-[10px] font-bold" style={{ ...MONO, color: isOpen ? "#16a34a" : text }}>
          {isOpen ? "Live" : fmtClock(p.exitTime)}
        </span>
        <span className="ml-auto flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold" style={{ ...MONO, background: isDark ? "#1e293b" : "#f1f5f9", color: subtext }}>
          {fmtDuration(p.durationSecs)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 px-4 pb-3 pt-3">
        <div>
          <div className="mb-0.5 text-[10px]" style={{ color: subtext }}>Entry Price</div>
          <div className="text-[12px] font-bold" style={{ color: text }}>₹{fmt(p.buyPrice)}</div>
        </div>
        <div>
          <div className="mb-0.5 text-[10px]" style={{ color: subtext }}>Exit Price</div>
          <div className="text-[12px] font-bold" style={{ color: text }}>{p.sellPrice > 0 ? `₹${fmt(p.sellPrice)}` : "—"}</div>
        </div>
        <div className="text-end">
          <div className="mb-0.5 text-[10px]" style={{ color: subtext }}>Gain/Loss</div>
          <div className="text-[12px] font-bold" style={{ color: pnlColor }}>{pnlVal >= 0 ? "+" : ""}₹{fmt(pnlVal)}</div>
        </div>
      </div>

      {isOpen && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: isDark ? "#1a1f35" : "#f0f1ff", border: "1px solid #6366f130" }}>
          <span className="flex-shrink-0 text-[10px] font-bold" style={{ color: "#6366f1" }}>🔒 Lock Pts</span>
          <input type="number" min="1" value={lockInput} onChange={e => setLockInput(e.target.value)} onKeyDown={e => e.key === "Enter" && applyLockPoints()}
            placeholder="e.g. 10" className="min-w-0 flex-1 rounded-lg px-2 py-1 text-[10px] font-bold outline-none"
            style={{ background: isDark ? "#0f172a" : "#fff", color: text, border: "1px solid #6366f140", ...MONO }} />
          {p.buyPrice > 0 && lockInput && !isNaN(parseFloat(lockInput)) && parseFloat(lockInput) > 0 && (
            <span className="flex-shrink-0 whitespace-nowrap text-[10px] font-bold" style={{ color: "#6366f1" }}>→ ₹{fmt(p.buyPrice + parseFloat(lockInput))}</span>
          )}
          <button onClick={applyLockPoints} disabled={!lockInput || isNaN(parseFloat(lockInput)) || parseFloat(lockInput) <= 0}
            className="flex-shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold text-white disabled:opacity-40" style={{ background: "#6366f1" }}>Set</button>
        </div>
      )}

      {(slSet !== null || tpSet !== null || lockTarget !== null) && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "#f59e0b18", color: "#f59e0b" }}>
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#f59e0b" }} />MONITORING
          </span>
          {slSet !== null && (
            <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold" style={{ background: "#e11d4815", color: "#e11d48" }}>
              SL ₹{fmt(slSet)}
              <button onClick={() => { setSlSet(null); saveSLTP(p.tradingsymbol, { sl: null }); triggeredRef.current = false; }} className="ml-0.5 opacity-60 hover:opacity-100">×</button>
            </span>
          )}
          {tpSet !== null && (
            <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold" style={{ background: "#16a34a15", color: "#16a34a" }}>
              TP ₹{fmt(tpSet)}
              <button onClick={() => { setTpSet(null); saveSLTP(p.tradingsymbol, { tp: null }); triggeredRef.current = false; }} className="ml-0.5 opacity-60 hover:opacity-100">×</button>
            </span>
          )}
          {lockTarget !== null && (
            <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold" style={{ background: "#6366f115", color: "#6366f1" }}>
              🔒 +{lockSet}pts → ₹{fmt(lockTarget)}
              <button onClick={() => { setLockSet(null); setLockDir(null); setLockInput(""); saveSLTP(p.tradingsymbol, { lockPts: null, lockDir: null }); triggeredRef.current = false; }} className="ml-0.5 opacity-60 hover:opacity-100">×</button>
            </span>
          )}
          <button onClick={() => setShowSLTP(true)} className="ml-auto text-[10px] font-bold underline" style={{ color: subtext }}>edit</button>
        </div>
      )}

      {showSLTP && (
        <div className="mx-3 mb-3 flex flex-col gap-2 rounded-xl p-3" style={{ background: isDark ? "#1e293b" : "#f8fafc", border: `1px solid ${border}` }}>
          <div className="flex gap-2">
            <div className="flex-1">
              <div className="mb-1 text-[10px] font-bold" style={{ color: subtext }}>Stop Loss ₹</div>
              <input type="number" value={slInput} onChange={e => setSlInput(e.target.value)} placeholder={p.buyPrice > 0 ? fmt(p.buyPrice * 0.88) : "0.00"}
                className="w-full rounded-lg px-2 py-1.5 text-[10px] font-bold outline-none" style={{ background: isDark ? "#0f172a" : "#fff", color: text, border: `1px solid ${border}`, ...MONO }} />
            </div>
            <div className="flex-1">
              <div className="mb-1 text-[10px] font-bold" style={{ color: subtext }}>Target ₹</div>
              <input type="number" value={tpInput} onChange={e => setTpInput(e.target.value)} placeholder={p.buyPrice > 0 ? fmt(p.buyPrice * 1.24) : "0.00"}
                className="w-full rounded-lg px-2 py-1.5 text-[10px] font-bold outline-none" style={{ background: isDark ? "#0f172a" : "#fff", color: text, border: `1px solid ${border}`, ...MONO }} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowSLTP(false)} className="flex-1 rounded-lg py-1.5 text-[10px] font-bold" style={{ background: isDark ? "#0f172a" : "#e2e8f0", color: subtext }}>Cancel</button>
            <button onClick={confirmSLTP} className="flex-1 rounded-lg py-1.5 text-[10px] font-bold text-white" style={{ background: "#16a34a" }}>Set</button>
          </div>
        </div>
      )}

      {isOpen && (
        <div className="grid grid-cols-2 border-t" style={{ borderColor: border }}>
          <button onClick={onExit} disabled={isExiting} className="flex items-center justify-center gap-2 border-r py-3.5 text-[12px] font-semibold disabled:opacity-50"
            style={{ color: "#1d6ff5", borderColor: border, background: isDark ? "#0a1628" : "#ebf3ff" }}>
            {isExiting && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#1d6ff5]/30 border-t-[#1d6ff5]" />}
            {isExiting ? "Exiting…" : "Instant Exit"}
          </button>
          <button onClick={() => setShowSLTP(v => !v)} className="flex items-center justify-center gap-2 py-3.5 text-[12px] font-semibold" style={{ color: "#16a34a", background: isDark ? "#071a0e" : "#ecfdf5" }}>
            {slSet || tpSet ? "Edit SL/Target" : "Add SL/Target"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── CSV from already-loaded today's data (no DB round-trip needed) ────────
function downloadTodayCSV(data: AccountData, type: "trades" | "summary") {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const cell = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const row = (cols: any[]) => cols.map(cell).join(",");
  let csv = "";
  if (type === "summary") {
    const closed = data.positions.filter(p => p.status === "CLOSED");
    const winners = closed.filter(p => p.pnl > 0).length;
    const losers = closed.filter(p => p.pnl < 0).length;
    const winRate = closed.length ? (winners / closed.length * 100).toFixed(1) : "0.0";
    const gross = data.pnl.total, chrgs = data.charges.total;
    csv = row(["Date", "Trades", "Winners", "Losers", "Win Rate (%)", "Gross P&L (₹)", "Charges (₹)", "Net P&L (₹)"]) + "\n";
    csv += row([today, closed.length, winners, losers, winRate, gross.toFixed(2), chrgs.toFixed(2), (gross - chrgs).toFixed(2)]) + "\n";
    csv += row(["OVERALL TOTAL", closed.length, winners, losers, winRate, gross.toFixed(2), chrgs.toFixed(2), (gross - chrgs).toFixed(2)]) + "\n";
  } else {
    csv = row(["Date", "Symbol", "Direction", "Strike", "Qty", "Entry Time", "Exit Time", "Entry Price (₹)", "Exit Price (₹)", "Gross P&L (₹)", "Status"]) + "\n";
    for (const p of data.positions) csv += row([today, p.tradingsymbol, p.direction, p.strike ?? "", p.quantity, p.entryTime ?? "", p.exitTime ?? "", p.buyPrice, p.sellPrice || "", p.pnl, p.status]) + "\n";
    const totalPnl = data.positions.reduce((s, p) => s + p.pnl, 0);
    const totalCharges = data.charges.total;
    csv += row(["OVERALL GROSS P&L", "", "", "", "", "", "", "", "", totalPnl.toFixed(2), ""]) + "\n";
    csv += row(["OVERALL CHARGES", "", "", "", "", "", "", "", "", `-${totalCharges.toFixed(2)}`, ""]) + "\n";
    csv += row(["NET P&L (FINAL)", "", "", "", "", "", "", "", "", (totalPnl - totalCharges).toFixed(2), ""]) + "\n";
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `pnl_${type}_${today}.csv`; a.click();
  URL.revokeObjectURL(url);
}

async function downloadRangeCSV(from: string, to: string, type: "trades" | "summary") {
  const res = await fetch(`/api/account/report?from=${from}&to=${to}&type=${type}`);
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Download failed"); }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `pnl_${type}_${from}_${to}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── Report downloader panel — the /api/account/report route this calls was
// already built and verified; nothing in the UI called it until now. ───────
function ReportDownloader({ todayData }: { todayData: AccountData }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const subtext = isDark ? "#64748b" : "#94a3b8";
  const muted = isDark ? "#94a3b8" : "#64748b";
  const text = isDark ? "#e2e8f0" : "#1e293b";

  const [reportType, setReportType] = useState<"trades" | "summary">("trades");
  const [preset, setPreset] = useState<"today" | "month" | "lastmonth" | "custom">("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function handleDownload() {
    setErr(""); setBusy(true);
    try {
      if (preset === "today") {
        downloadTodayCSV(todayData, reportType);
      } else {
        let f = from, t = to;
        if (preset !== "custom") {
          const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
          if (preset === "month") {
            f = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
            t = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
          } else {
            const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const last = new Date(now.getFullYear(), now.getMonth(), 0);
            f = first.toLocaleDateString("en-CA");
            t = last.toLocaleDateString("en-CA");
          }
        }
        if (!f || !t) { setErr("Select a date range"); setBusy(false); return; }
        await downloadRangeCSV(f, t, reportType);
      }
    } catch (e: any) {
      const msg = e.message || "Download failed";
      setErr(msg.includes("No trading data") || msg.includes("No data") ? "No trading data saved yet for this period. Data is captured daily from 3:31 PM IST." : msg);
    } finally {
      setBusy(false);
    }
  }

  const pill = (label: string, active: boolean, onClick: () => void) => (
    <button onClick={onClick} className="rounded-lg px-3 py-1 text-[10px] font-bold tracking-[0.5px]" style={{ ...MONO, background: active ? "#ea580c" : (isDark ? "#1e293b" : "#f1f5f9"), color: active ? "#fff" : muted }}>{label}</button>
  );

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border p-4" style={{ background: isDark ? "#0f172a" : "#fff", borderColor: isDark ? "#1e293b" : "#e2e8f0" }}>
      <div className="flex items-center gap-1.5">
        <span style={{ color: "#ea580c" }}>⬇</span>
        <span className="text-[9px] font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: subtext }}>Download P&amp;L Report</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] uppercase tracking-[1px]" style={{ ...MONO, color: subtext }}>Type</span>
        <div className="flex gap-2">
          {pill("Trades", reportType === "trades", () => setReportType("trades"))}
          {pill("Daily Summary", reportType === "summary", () => setReportType("summary"))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] uppercase tracking-[1px]" style={{ ...MONO, color: subtext }}>Period</span>
        <div className="flex flex-wrap gap-2">
          {pill("Today", preset === "today", () => setPreset("today"))}
          {pill("This Month", preset === "month", () => setPreset("month"))}
          {pill("Last Month", preset === "lastmonth", () => setPreset("lastmonth"))}
          {pill("Custom", preset === "custom", () => setPreset("custom"))}
        </div>
      </div>
      {preset === "custom" && (
        <div className="flex flex-wrap gap-3">
          {(["From", "To"] as const).map((label, i) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="text-[9px] uppercase tracking-[1px]" style={{ ...MONO, color: subtext }}>{label}</span>
              <input type="date" value={i === 0 ? from : to} onChange={e => i === 0 ? setFrom(e.target.value) : setTo(e.target.value)}
                className="rounded-lg border px-2 py-1 text-[11px] outline-none" style={{ ...MONO, background: isDark ? "#1e293b" : "#f8fafc", borderColor: isDark ? "#334155" : "#e2e8f0", color: text }} />
            </div>
          ))}
        </div>
      )}
      {err && <span className="text-[10px]" style={{ ...MONO, color: "#e11d48" }}>{err}</span>}
      <button onClick={handleDownload} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[11px] font-bold uppercase tracking-[1px] disabled:opacity-50" style={{ ...MONO, background: "#ea580c", color: "#fff" }}>
        <span>⬇</span>{busy ? "Downloading…" : "Download CSV"}
      </button>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[var(--radius)] border p-3 text-sm" style={{ borderColor: "var(--down)", background: "var(--down-soft)", color: "var(--down)" }}>{children}</div>;
}
function Th({ children }: { children: React.ReactNode }) { return <th className="px-3 py-2 text-left font-medium">{children}</th>; }
function Td({ children, className = "", style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <td className={`px-3 py-2 ${className}`} style={style}>{children}</td>;
}
