"use client";

// ─── Option chain (Chain tab) ───────────────────────────────────────────────────
// Full port of the chain view inside frontend/app/options/page.tsx
// (OptionsPageInner's activeTab==="chain" branch, ~1802-2443, plus ChainRow
// ~3306-3719): Scalper/Strategy mode toggle, NIFTY/SENSEX index switch,
// desktop 7-col chain-grid (bookmark | OI | LTP | STRIKE | LTP | OI |
// bookmark) with the mobile 3-col card layout (scalper/strategy/browse-mode
// variants), the ATM sticky divider, per-row bookmark → default watchlist
// group, split CE+PE chart view, and the two bottom order panels: a
// single-leg scalper panel (wallet check, lot stepper, market buy/sell via
// /api/account/order) and a multi-leg strategy/basket panel (max
// profit/breakeven/max loss, execute-all). Real quantity comes from the
// chain response's own `lotSize` (INDstocks instrument master), not a
// hardcoded constant — same "never trust a hardcoded lot size" rule as the
// rest of this app.
//
// SCOPE CUT, stated plainly: the original's Sensibull iframe panel and the
// dedicated payoff-diagram canvas view are not ported — the basket panel
// below already carries the same max-profit/breakeven/max-loss numbers as
// text, which is the metric that matters for a trading decision.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { IconBookmark, IconBookmarkFilled, IconChartCandle, IconChartArea, IconColumns, IconX } from "@tabler/icons-react";
import { ChartPanel, type ChartTarget } from "./ChartPanel";
import { PayoffChart, type PayoffTarget } from "./PayoffChart";
import { useChainStore, useLtp, usePrevLtp } from "@/lib/store/chainStore";
import { useTheme } from "@/lib/theme";
import { useAccountQty } from "@/lib/useAccountQty";
import { NUM_LOTS, MIN_PREMIUM, MAX_PREMIUM } from "@/lib/strategies/constants";
import type { ChainRow as ChainRowT, OptionChain as Chain, Index, Leg } from "@/lib/broker/types";

const MONO = { fontFamily: "'Space Mono', monospace" } as const;

type Order = { strike: number; type: "CE" | "PE"; action: "BUY" | "SELL"; ltp: number; token: number; leg: Leg };
type WatchedItem = { token: number; tradingsymbol: string; strike: number; type: string; ltp: number };

function fmtOI(n: number): string {
  return n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
}

export function OptionChainView() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const chain = useChainStore((s) => s.chain);
  const setChain = useChainStore((s) => s.setChain);
  const [index, setIndexV] = useState<Index>("NIFTY");
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [scalperOn, setScalperOn] = useState(true);
  const [strategyOn, setStrategyOn] = useState(false);
  const acctQty = useAccountQty(NUM_LOTS);
  const [orderLots, setOrderLots] = useState(NUM_LOTS);
  const lotsInitRef = useState({ done: false })[0];
  useEffect(() => { if (!lotsInitRef.done) { lotsInitRef.done = true; setOrderLots(acctQty); } }, [acctQty, lotsInitRef]);

  const [orderPanel, setOrderPanel] = useState<Order | null>(null);
  const [basketLegs, setBasketLegs] = useState<Order[]>([]);
  const [orderState, setOrderState] = useState<{ loading: boolean; result: string | null }>({ loading: false, result: null });
  const [walletAvailable, setWalletAvailable] = useState<number | null>(null);

  const [watchedTokens, setWatchedTokens] = useState<Set<number>>(new Set());
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [splitTarget, setSplitTarget] = useState<{ ce: ChartTarget; pe: ChartTarget } | null>(null);
  const [payoffTarget, setPayoffTarget] = useState<PayoffTarget | null>(null);

  const lotSize = chain?.rows[0]?.ce.lotSize || (index === "SENSEX" ? 20 : 65);

  useEffect(() => {
    fetch("/api/watchlist/groups").then(r => r.json()).then(d => {
      const def = (d.groups ?? []).find((g: any) => g.id === "wl_default");
      setWatchedTokens(new Set((def?.items ?? []).map((i: WatchedItem) => i.token)));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    function poll() {
      fetch("/api/account").then(r => r.json()).then(d => { if (alive) setWalletAvailable(d.wallet?.available ?? null); }).catch(() => {});
    }
    poll();
    const id = setInterval(poll, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    setExpiry("");
    fetch(`/api/expiries?index=${index}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setExpiries(d.expiries ?? []);
        setExpiry((cur) => cur || d.expiries?.[0] || "");
      })
      .catch((e) => setError(e.message));
  }, [index]);

  useEffect(() => {
    if (!expiry) return;
    let alive = true;
    setLoading(true);

    const load = () =>
      fetch(`/api/chain?expiry=${expiry}&strikes=15&index=${index}`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          if (d.error) throw new Error(d.error);
          setChain(d);
          setError(null);
        })
        .catch((e) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));

    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [expiry, index, setChain]);

  const toggleWatch = useCallback((leg: Leg, strike: number, type: "CE" | "PE") => {
    setWatchedTokens(prev => {
      const next = new Set(prev);
      const nowWatching = !next.has(leg.token);
      if (nowWatching) next.add(leg.token); else next.delete(leg.token);
      fetch("/api/watchlist/groups").then(r => r.json()).then(d => {
        const groups = d.groups ?? [{ id: "wl_default", name: "My Watchlist", items: [] }];
        const def = groups.find((g: any) => g.id === "wl_default") ?? groups[0];
        const items: WatchedItem[] = def.items ?? [];
        const nextItems = nowWatching
          ? (items.some(i => i.token === leg.token) ? items : [...items, { token: leg.token, tradingsymbol: leg.tradingsymbol, strike, type, ltp: leg.ltp }])
          : items.filter(i => i.token !== leg.token);
        fetch(`/api/watchlist/groups/${def.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: def.name, items: nextItems }) }).catch(() => {});
      }).catch(() => {});
      return next;
    });
  }, []);

  async function handlePlaceOrder(action: "BUY" | "SELL") {
    if (!orderPanel) return;
    setOrderState({ loading: true, result: null });
    try {
      const qty = orderLots * lotSize;
      const r = await fetch("/api/account/order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradingsymbol: orderPanel.leg.tradingsymbol, security_id: orderPanel.token, transaction_type: action, quantity: qty, limit_price: orderPanel.ltp }),
      }).then(r => r.json());
      if (r.error) throw new Error(r.error);
      setOrderState({ loading: false, result: `✓ ${action} ${qty} placed · ${r.order_id}` });
    } catch (e: any) {
      setOrderState({ loading: false, result: `✕ ${e.message}` });
    }
  }

  async function handleExecuteBasket() {
    setOrderState({ loading: true, result: null });
    try {
      const qty = orderLots * lotSize;
      const ids: string[] = [];
      for (const leg of basketLegs) {
        const r = await fetch("/api/account/order", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tradingsymbol: leg.leg.tradingsymbol, security_id: leg.token, transaction_type: leg.action, quantity: qty, limit_price: leg.ltp }),
        }).then(r => r.json());
        if (r.error) throw new Error(`${leg.strike}${leg.type}: ${r.error}`);
        ids.push(r.order_id);
      }
      setOrderState({ loading: false, result: `✓ ${basketLegs.length} legs placed · ${ids.join(", ")}` });
      setBasketLegs([]);
    } catch (e: any) {
      setOrderState({ loading: false, result: `✕ ${e.message}` });
    }
  }

  function onOrder(leg: Leg, strike: number, type: "CE" | "PE", action: "BUY" | "SELL") {
    if (strategyOn) {
      setBasketLegs((prev) => {
        const key = `${strike}-${type}-${action}`;
        const exists = prev.find((l) => `${l.strike}-${l.type}-${l.action}` === key);
        if (exists) return prev.filter((l) => `${l.strike}-${l.type}-${l.action}` !== key);
        return [...prev, { strike, type, action, ltp: leg.ltp, token: leg.token, leg }];
      });
    } else {
      setOrderPanel({ strike, type, action, ltp: leg.ltp, token: leg.token, leg });
      setOrderLots(acctQty);
      setOrderState({ loading: false, result: null });
    }
  }

  const panelBg = isDark ? "#0f172a" : "#ffffff";
  const panelBorder = isDark ? "#1e293b" : "#e2e8f0";
  const rowDivider = isDark ? "#1e293b" : "#f1f5f9";
  const btnBg = isDark ? "#1e293b" : "#f1f5f9";
  const btnColor = isDark ? "#94a3b8" : "#475569";
  const textPrimary = isDark ? "#e2e8f0" : "#1e293b";
  const textMuted = isDark ? "#64748b" : "#94a3b8";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="px-3 py-3 md:px-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div>
            <div className="text-xs text-faint">{index} 50</div>
            <div className="tabular text-2xl font-semibold">{chain ? chain.spot.toFixed(2) : "—"}</div>
          </div>

          {/* Scalper / Strategy toggles */}
          <div className="flex items-center gap-3">
            <ModeToggle label="Scalper" on={scalperOn} onColor="#0284c7" icon="⚡" onClick={() => setScalperOn(v => !v)} />
            <ModeToggle label="Strategy" on={strategyOn} onColor="#16a34a" icon="🛒" onClick={() => { setStrategyOn(v => !v); setBasketLegs([]); setOrderPanel(null); }} />
          </div>

          {/* Index switch */}
          <div className="flex items-center overflow-hidden rounded-full border text-[10px] font-black" style={{ borderColor: "var(--border)", ...MONO }}>
            {(["NIFTY", "SENSEX"] as const).map((idx) => (
              <button key={idx} onClick={() => setIndexV(idx)} className="px-2.5 py-1 transition-colors"
                style={{ background: index === idx ? "var(--accent)" : "transparent", color: index === idx ? "#fff" : "var(--text-muted)" }}>
                {idx}
              </button>
            ))}
          </div>

          <label className="ml-auto flex items-center gap-2 text-xs text-muted">
            Expiry
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-card px-2 py-1.5 text-sm text-fg outline-none focus:border-[var(--accent)]">
              {expiries.map((e) => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
            </select>
          </label>
        </div>

        {chain && <Stats chain={chain} />}

        {error && (
          <div className="mb-3 rounded-[var(--radius)] border p-3 text-sm" style={{ borderColor: "var(--down)", background: "var(--down-soft)", color: "var(--down)" }}>{error}</div>
        )}
      </div>

      {loading && !chain ? (
        <ChainSkeleton />
      ) : chain ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* ── Desktop column headers ── */}
          <div className="hidden flex-shrink-0 border-b border-[var(--border)] md:block">
            <div className="chain-grid">
              <div className="py-2 border-r border-[var(--border)]" style={{ background: "var(--ce-tint)" }} />
              <div className="chain-col-oi px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--ce)", background: "var(--ce-tint)" }}>CE OI</div>
              <div className="px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[1.5px] border-r border-[var(--border)]" style={{ ...MONO, color: "var(--ce)", background: "var(--ce-tint)" }}>CE LTP</div>
              <div className="px-2 py-2 text-center text-[8px] font-bold uppercase tracking-[1.5px] border-x border-[var(--border)]" style={{ ...MONO, color: "var(--text-muted)", background: "var(--card)" }}>STRIKE</div>
              <div className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[1.5px] border-l border-[var(--border)]" style={{ ...MONO, color: "var(--pe)", background: "var(--pe-tint)" }}>PE LTP</div>
              <div className="chain-col-oi px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--pe)", background: "var(--pe-tint)" }}>PE OI</div>
              <div className="py-2 border-l border-[var(--border)]" style={{ background: "var(--pe-tint)" }} />
            </div>
          </div>

          {/* ── Mobile column headers ── */}
          <div className="flex-shrink-0 border-b border-[var(--border)] md:hidden">
            <div className="grid grid-cols-[1fr_72px_1fr] text-[8px] font-bold tracking-[0.5px]" style={MONO}>
              <div className="px-3 py-1.5 text-center" style={{ color: "var(--ce)", background: "var(--ce-tint)" }}>Call (₹)</div>
              <div className="flex items-center justify-center py-1.5 text-center text-[7px]" style={{ color: "var(--text-muted)", background: "var(--card)" }}>
                {chain.spot.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
              <div className="px-3 py-1.5 text-center" style={{ color: "var(--pe)", background: "var(--pe-tint)" }}>Put (₹)</div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {chain.rows.map((row) => (
              <div key={row.strike}>
                {row.isATM && (
                  <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5" style={{ background: isDark ? "#1e293b" : "#dbeafe", borderTop: "1px solid var(--accent)", borderBottom: "1px solid var(--accent)" }}>
                    <div className="h-px flex-1" style={{ background: "var(--accent-soft)" }} />
                    <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ ...MONO, color: isDark ? "#fff" : "var(--accent)", background: isDark ? "#1e293b" : "#fff", border: "1px solid var(--accent)" }}>
                      {index} {chain.spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <div className="h-px flex-1" style={{ background: "var(--accent-soft)" }} />
                  </div>
                )}
                <Row
                  row={row}
                  watchedTokens={watchedTokens}
                  scalperOn={scalperOn}
                  strategyOn={strategyOn}
                  onOrder={onOrder}
                  onToggleWatch={toggleWatch}
                  onOpenChart={(leg, strike, type) => { setChartTarget({ token: leg.token, tradingsymbol: leg.tradingsymbol, strike, type, expiry, index }); setSplitTarget(null); }}
                  onOpenPayoff={(leg, strike, type) => setPayoffTarget({ strike, type, ltp: leg.ltp, lotSize: leg.lotSize })}
                  onOpenSplit={() => {
                    setSplitTarget({
                      ce: { token: row.ce.token, tradingsymbol: row.ce.tradingsymbol, strike: row.strike, type: "CE", expiry, index },
                      pe: { token: row.pe.token, tradingsymbol: row.pe.tradingsymbol, strike: row.strike, type: "PE", expiry, index },
                    });
                    setChartTarget(null);
                  }}
                />
              </div>
            ))}
          </div>

          {/* ── Scalper order panel ── */}
          {!strategyOn && orderPanel && (() => {
            const approxBuy = orderPanel.ltp * orderLots * lotSize;
            const canBuy = walletAvailable === null || walletAvailable >= approxBuy;
            const fmtWallet = walletAvailable !== null ? `₹${walletAvailable.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—";
            const approxColor = !canBuy ? "var(--down)" : textPrimary;
            return (
              <div className="z-20 flex-shrink-0 shadow-2xl" style={{ background: panelBg, borderTop: `1px solid ${panelBorder}` }}>
                <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: `1px solid ${rowDivider}` }}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[11px] font-bold" style={{ ...MONO, color: textPrimary }}>{index} {orderPanel.strike} {orderPanel.type}</span>
                    <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: orderPanel.action === "BUY" ? "#16a34a20" : "#e11d4820", color: orderPanel.action === "BUY" ? "#16a34a" : "#e11d48" }}>{orderPanel.action}</span>
                    <span className="flex-shrink-0 text-[13px] font-black" style={{ ...MONO, color: textPrimary }}>₹{orderPanel.ltp.toFixed(2)}</span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <button onClick={() => toggleWatch(orderPanel.leg, orderPanel.strike, orderPanel.type)} className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full"
                      style={{ background: watchedTokens.has(orderPanel.token) ? "#fbbf2425" : btnBg, color: watchedTokens.has(orderPanel.token) ? "#f59e0b" : textMuted }}>
                      {watchedTokens.has(orderPanel.token) ? <IconBookmarkFilled size={13} /> : <IconBookmark size={13} />}
                    </button>
                    <button onClick={() => { setOrderPanel(null); setOrderState({ loading: false, result: null }); }} className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full" style={{ background: btnBg, color: textMuted }}><IconX size={13} /></button>
                  </div>
                </div>
                <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: `1px solid ${rowDivider}` }}>
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="text-[8px] uppercase" style={{ ...MONO, color: textMuted }}>Available</span>
                    <span className="text-[12px] font-bold" style={{ ...MONO, color: walletAvailable !== null && !canBuy ? "var(--down)" : "var(--up)" }}>{fmtWallet}</span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-[8px] uppercase" style={{ ...MONO, color: textMuted }}>Approx Req</span>
                    <span className="text-[12px] font-bold" style={{ ...MONO, color: approxColor }}>₹{approxBuy.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-[9px] uppercase" style={{ ...MONO, color: textMuted }}>Lots</span>
                  <button onClick={() => setOrderLots(v => Math.max(1, v - 1))} className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-bold" style={{ background: btnBg, color: btnColor }}>−</button>
                  <span className="w-6 text-center text-[14px] font-bold" style={{ ...MONO, color: textPrimary }}>{orderLots}</span>
                  <button onClick={() => setOrderLots(v => v + 1)} className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-bold" style={{ background: btnBg, color: btnColor }}>+</button>
                  <span className="ml-auto text-[9px]" style={{ ...MONO, color: textMuted }}>{orderLots} × {lotSize} = {orderLots * lotSize} qty</span>
                </div>
                {orderState.result && <OrderResult text={orderState.result} />}
                <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                  <button disabled={!canBuy || orderState.loading} onClick={() => handlePlaceOrder("SELL")} className="rounded-lg py-1.5 text-[10px] font-black tracking-[0.5px] transition-opacity" style={{ background: canBuy ? "#e11d48" : "#e11d4840", color: "#fff", opacity: canBuy && !orderState.loading ? 1 : 0.45, ...MONO }}>{orderState.loading ? "..." : "↙ Sell @ Mkt"}</button>
                  <button disabled={!canBuy || orderState.loading} onClick={() => handlePlaceOrder("BUY")} className="rounded-lg py-1.5 text-[10px] font-black tracking-[0.5px] transition-opacity" style={{ background: canBuy ? "#16a34a" : "#16a34a40", color: "#fff", opacity: canBuy && !orderState.loading ? 1 : 0.45, ...MONO }}>{orderState.loading ? "..." : "↗ Buy @ Mkt"}</button>
                </div>
                {!canBuy && walletAvailable !== null && (
                  <div className="mx-4 mb-3 rounded-lg px-3 py-2 text-center text-[9px] font-bold" style={{ ...MONO, background: "#e11d4815", color: "#e11d48", border: "1px solid #e11d4830" }}>Insufficient funds · Need ₹{(approxBuy - walletAvailable).toLocaleString("en-IN", { maximumFractionDigits: 0 })} more</div>
                )}
              </div>
            );
          })()}

          {/* ── Basket / strategy panel ── */}
          {strategyOn && basketLegs.length > 0 && (() => {
            const netDebit = basketLegs.reduce((s, l) => s + (l.action === "BUY" ? l.ltp : 0), 0);
            const netCredit = basketLegs.reduce((s, l) => s + (l.action === "SELL" ? l.ltp : 0), 0);
            const approxReq = netDebit * orderLots * lotSize;
            const canExecute = walletAvailable === null || walletAvailable >= approxReq;
            const firstLeg = basketLegs[0];
            const breakeven = firstLeg.action === "BUY" ? (firstLeg.type === "CE" ? firstLeg.strike + firstLeg.ltp : firstLeg.strike - firstLeg.ltp) : null;
            const maxLoss = netDebit > 0 ? -(netDebit * orderLots * lotSize) : null;
            const fmtWallet = walletAvailable !== null ? `₹${walletAvailable.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—";
            const approxColor = !canExecute ? "var(--down)" : textPrimary;
            return (
              <div className="z-20 flex-shrink-0 shadow-2xl" style={{ background: panelBg, borderTop: `1px solid ${panelBorder}` }}>
                <div className="flex items-center gap-2 overflow-x-auto px-3 pb-1 pt-2" style={{ borderBottom: `1px solid ${rowDivider}`, scrollbarWidth: "none" }}>
                  {basketLegs.map((l, i) => (
                    <div key={i} className="flex flex-shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[9px] font-bold"
                      style={{ borderColor: l.action === "BUY" ? "#16a34a60" : "#e11d4860", background: l.action === "BUY" ? "#16a34a12" : "#e11d4812", color: l.action === "BUY" ? "#16a34a" : "#e11d48", ...MONO }}>
                      {l.action === "BUY" ? "B" : "S"} {l.strike} {l.type}
                      <button onClick={() => setBasketLegs(prev => prev.filter((_, j) => j !== i))} className="ml-1 text-[10px] opacity-60">×</button>
                    </div>
                  ))}
                  <button onClick={() => setBasketLegs([])} className="ml-auto flex-shrink-0 rounded-lg px-2 py-1 text-[8px] font-bold" style={{ ...MONO, color: "#e11d48", background: "#e11d4815" }}>Clear All</button>
                </div>
                <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: `1px solid ${rowDivider}` }}>
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="text-[8px] uppercase" style={{ ...MONO, color: textMuted }}>Available</span>
                    <span className="text-[12px] font-bold" style={{ ...MONO, color: walletAvailable !== null && !canExecute ? "var(--down)" : "var(--up)" }}>{fmtWallet}</span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-[8px] uppercase" style={{ ...MONO, color: textMuted }}>Approx Req</span>
                    <span className="text-[12px] font-bold" style={{ ...MONO, color: approxColor }}>₹{approxReq.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 px-3 py-2" style={{ borderBottom: `1px solid ${rowDivider}` }}>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[7px] uppercase" style={{ ...MONO, color: textMuted }}>Max Profit</span>
                    <span className="text-[11px] font-black text-[#16a34a]" style={MONO}>{netCredit > netDebit ? `₹${((netCredit - netDebit) * orderLots * lotSize).toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "Unlimited"}</span>
                  </div>
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-[7px] uppercase" style={{ ...MONO, color: textMuted }}>Breakeven</span>
                    <span className="text-[11px] font-black" style={{ ...MONO, color: textPrimary }}>{breakeven != null ? breakeven.toFixed(0) : "—"}</span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-[7px] uppercase" style={{ ...MONO, color: textMuted }}>Max Loss</span>
                    <span className="text-[11px] font-black text-[#e11d48]" style={MONO}>{maxLoss != null ? `-₹${Math.abs(maxLoss).toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "Limited"}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-4 py-2">
                  <button onClick={() => setOrderLots(v => Math.max(1, v - 1))} className="flex h-7 w-7 items-center justify-center rounded-full font-bold" style={{ background: btnBg, color: btnColor }}>−</button>
                  <span className="w-5 text-center text-[12px] font-bold" style={{ ...MONO, color: textPrimary }}>{orderLots}</span>
                  <span className="text-[9px]" style={{ ...MONO, color: textMuted }}>lot{orderLots > 1 ? "s" : ""}</span>
                  <button onClick={() => setOrderLots(v => v + 1)} className="flex h-7 w-7 items-center justify-center rounded-full font-bold" style={{ background: btnBg, color: btnColor }}>+</button>
                </div>
                {orderState.result && <OrderResult text={orderState.result} />}
                <div className="px-4 pb-3">
                  <button disabled={!canExecute || orderState.loading} onClick={handleExecuteBasket} className="w-full rounded-xl py-2.5 text-[12px] font-black tracking-[1px] transition-opacity" style={{ background: canExecute ? "#16a34a" : "#16a34a40", color: "#fff", opacity: canExecute && !orderState.loading ? 1 : 0.5, ...MONO }}>
                    {orderState.loading ? "Placing..." : `Execute Basket (${basketLegs.length} leg${basketLegs.length > 1 ? "s" : ""})`}
                  </button>
                </div>
                {!canExecute && walletAvailable !== null && (
                  <div className="mx-4 mb-3 rounded-lg px-3 py-2 text-center text-[9px] font-bold" style={{ ...MONO, background: "#e11d4815", color: "#e11d48", border: "1px solid #e11d4830" }}>Insufficient funds · Need ₹{(approxReq - walletAvailable).toLocaleString("en-IN", { maximumFractionDigits: 0 })} more</div>
                )}
              </div>
            );
          })()}
        </div>
      ) : null}

      {chartTarget && <ChartPanel {...chartTarget} onClose={() => setChartTarget(null)} />}
      {payoffTarget && chain && <PayoffChart target={payoffTarget} spot={chain.spot} indexLabel={index} onClose={() => setPayoffTarget(null)} />}
      {splitTarget && (
        <div className="fixed inset-0 z-40 flex flex-col gap-2 bg-black/60 p-3 md:flex-row" onClick={() => setSplitTarget(null)}>
          <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}><ChartPanel {...splitTarget.ce} startInTechnical onClose={() => setSplitTarget(null)} /></div>
          <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}><ChartPanel {...splitTarget.pe} startInTechnical onClose={() => setSplitTarget(null)} /></div>
        </div>
      )}
    </div>
  );
}

function ModeToggle({ label, on, onColor, icon, onClick }: { label: string; on: boolean; onColor: string; icon: string; onClick: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-bold" style={{ ...MONO, color: "var(--text-muted)" }}>{label}</span>
      <button onClick={onClick} className="relative h-[18px] w-8 flex-shrink-0 rounded-full transition-colors" style={{ background: on ? onColor : "var(--border)" }}>
        <span className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform" style={{ left: on ? "18px" : "2px" }} />
        {on && <span className="absolute inset-0 flex items-center justify-center text-[8px]">{icon}</span>}
      </button>
    </div>
  );
}

function OrderResult({ text }: { text: string }) {
  const ok = text.startsWith("✓");
  return (
    <div className="mx-4 mb-2 rounded-lg px-3 py-2 text-center text-[9px] font-bold" style={{ ...MONO, background: ok ? "#16a34a15" : "#e11d4815", color: ok ? "#16a34a" : "#e11d48", border: `1px solid ${ok ? "#16a34a30" : "#e11d4830"}` }}>{text}</div>
  );
}

function Stats({ chain }: { chain: Chain }) {
  const items = [
    ["PCR (OI)", chain.pcrOI.toFixed(2)],
    ["Max Pain", String(chain.maxPain)],
    ["ATM IV", `${chain.atmIV.toFixed(1)}%`],
    ["CE OI", fmtOI(chain.totalCEOI)],
    ["PE OI", fmtOI(chain.totalPEOI)],
    ["Expires in", `${chain.daysToExpiry.toFixed(1)}d`],
  ] as const;
  return (
    <div className="mb-1 grid grid-cols-3 gap-2 sm:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-card px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
          <div className="tabular text-sm font-medium">{value}</div>
        </div>
      ))}
    </div>
  );
}

/** One strike, both mobile card and desktop grid layouts. memo + per-token
 *  price subscriptions mean a tick on this leg re-renders THIS row only. */
const Row = memo(function Row({ row, watchedTokens, scalperOn, strategyOn, onOrder, onToggleWatch, onOpenChart, onOpenPayoff, onOpenSplit }: {
  row: ChainRowT; watchedTokens: Set<number>; scalperOn: boolean; strategyOn: boolean;
  onOrder: (leg: Leg, strike: number, type: "CE" | "PE", action: "BUY" | "SELL") => void;
  onToggleWatch: (leg: Leg, strike: number, type: "CE" | "PE") => void;
  onOpenChart: (leg: Leg, strike: number, type: "CE" | "PE") => void;
  onOpenPayoff: (leg: Leg, strike: number, type: "CE" | "PE") => void;
  onOpenSplit: () => void;
}) {
  const { ce, pe, strike, isATM } = row;
  const ceLtp = useLtp(ce.token) ?? ce.ltp;
  const peLtp = useLtp(pe.token) ?? pe.ltp;
  // ceLtp/peLtp read 0 when there's no live price yet (market closed, or no
  // tick since load) — computing against that reads as a fake "down 100%".
  const cePct = ceLtp > 0 && ce.prevLtp > 0 ? ((ceLtp - ce.prevLtp) / ce.prevLtp) * 100 : 0;
  const pePct = peLtp > 0 && pe.prevLtp > 0 ? ((peLtp - pe.prevLtp) / pe.prevLtp) * 100 : 0;
  const ceWatched = watchedTokens.has(ce.token);
  const peWatched = watchedTokens.has(pe.token);
  const ceInBand = ceLtp >= MIN_PREMIUM && ceLtp <= MAX_PREMIUM;
  const peInBand = peLtp >= MIN_PREMIUM && peLtp <= MAX_PREMIUM;
  const rowPCR = ce.oi > 0 ? +(pe.oi / ce.oi).toFixed(2) : 0;

  return (
    <>
      {/* ── Mobile card ── */}
      <div className={`border-b md:hidden`} style={{ background: isATM ? "var(--accent-soft)" : undefined, borderColor: "var(--border)" }}>
        <div className="grid grid-cols-[1fr_72px_1fr]">
          <div className="flex flex-col gap-1 px-1.5 py-2" style={{ background: isATM ? "var(--ce-tint)" : undefined }}>
            {scalperOn ? (
              <button onClick={() => onOrder(ce, strike, "CE", "BUY")} className="flex w-full flex-col items-end">
                <span className="tabular-nums text-[13px] font-bold" style={MONO}>₹{ceLtp.toFixed(2)}</span>
                <span className="text-[9px] font-bold" style={{ ...MONO, color: cePct >= 0 ? "var(--up)" : "var(--down)" }}>{cePct >= 0 ? "+" : ""}{cePct.toFixed(2)}%</span>
              </button>
            ) : strategyOn ? (
              <div className="flex items-center gap-1">
                <div className="flex flex-col gap-0.5">
                  <OrderBtn color="#e11d48" label="S" onClick={() => onOrder(ce, strike, "CE", "SELL")} />
                  <OrderBtn color="#16a34a" label="B" onClick={() => onOrder(ce, strike, "CE", "BUY")} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col items-end">
                  <span className="tabular-nums text-[13px] font-bold leading-none" style={MONO}>₹{ceLtp.toFixed(2)}</span>
                  <span className="mt-0.5 text-[9px] font-bold" style={{ ...MONO, color: cePct >= 0 ? "var(--up)" : "var(--down)" }}>{cePct >= 0 ? "+" : ""}{cePct.toFixed(2)}%</span>
                </div>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-start justify-between">
                  <button onClick={() => onToggleWatch(ce, strike, "CE")} className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded" style={{ background: ceWatched ? "#fbbf2420" : "transparent", color: ceWatched ? "#f59e0b" : "var(--text-faint)" }}>
                    {ceWatched ? <IconBookmarkFilled size={11} /> : <IconBookmark size={11} />}
                  </button>
                  <div className="ml-0.5 flex flex-1 flex-col items-end">
                    <span className="tabular-nums text-[13px] font-bold leading-tight" style={MONO}>{ceLtp.toFixed(2)}</span>
                    <span className="text-[8px] font-bold" style={{ ...MONO, color: "var(--ce)" }}>{strike} CE</span>
                  </div>
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="text-[8px]" style={{ ...MONO, color: "var(--text-faint)" }}>{fmtOI(ce.oi)}</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => onOpenPayoff(ce, strike, "CE")} title={`Payoff ${strike} CE`} className="flex h-5 w-5 items-center justify-center rounded" style={{ background: "var(--ce-tint)", color: "var(--ce)" }}><IconChartArea size={11} /></button>
                    <button onClick={() => onOpenChart(ce, strike, "CE")} className="flex h-5 w-5 items-center justify-center rounded" style={{ background: "var(--ce-tint)", color: "var(--ce)" }}><IconChartCandle size={11} /></button>
                  </div>
                </div>
              </div>
            )}
            <OIBar pct={row.ceOIBar} color="var(--ce)" />
          </div>

          <div className="flex flex-col items-center justify-center gap-0.5 border-x py-2" style={{ borderColor: "var(--border)", background: isATM ? "var(--accent-soft)" : "var(--card)" }}>
            <span className="tabular-nums text-[12px] font-bold leading-none" style={{ ...MONO, color: isATM ? "var(--accent)" : "var(--text)" }}>{strike}</span>
            <span className="tabular-nums text-[8px] font-bold" style={{ ...MONO, color: rowPCR >= 1 ? "var(--up)" : "var(--down)" }}>PCR {rowPCR.toFixed(2)}</span>
            <button onClick={onOpenSplit} title={`CE + PE ${strike} split chart`} className="flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }}><IconColumns size={11} /></button>
          </div>

          <div className="flex flex-col gap-1 px-1.5 py-2" style={{ background: isATM ? "var(--pe-tint)" : undefined }}>
            {scalperOn ? (
              <button onClick={() => onOrder(pe, strike, "PE", "BUY")} className="flex w-full flex-col items-start">
                <span className="tabular-nums text-[13px] font-bold" style={MONO}>₹{peLtp.toFixed(2)}</span>
                <span className="text-[9px] font-bold" style={{ ...MONO, color: pePct >= 0 ? "var(--up)" : "var(--down)" }}>{pePct >= 0 ? "+" : ""}{pePct.toFixed(2)}%</span>
              </button>
            ) : strategyOn ? (
              <div className="flex items-center gap-1">
                <div className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="tabular-nums text-[13px] font-bold leading-none" style={MONO}>₹{peLtp.toFixed(2)}</span>
                  <span className="mt-0.5 text-[9px] font-bold" style={{ ...MONO, color: pePct >= 0 ? "var(--up)" : "var(--down)" }}>{pePct >= 0 ? "+" : ""}{pePct.toFixed(2)}%</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <OrderBtn color="#16a34a" label="B" onClick={() => onOrder(pe, strike, "PE", "BUY")} />
                  <OrderBtn color="#e11d48" label="S" onClick={() => onOrder(pe, strike, "PE", "SELL")} />
                </div>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-start justify-between">
                  <div className="mr-0.5 flex flex-1 flex-col items-start">
                    <span className="tabular-nums text-[13px] font-bold leading-tight" style={MONO}>{peLtp.toFixed(2)}</span>
                    <span className="text-[8px] font-bold" style={{ ...MONO, color: "var(--pe)" }}>{strike} PE</span>
                  </div>
                  <button onClick={() => onToggleWatch(pe, strike, "PE")} className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded" style={{ background: peWatched ? "#fbbf2420" : "transparent", color: peWatched ? "#f59e0b" : "var(--text-faint)" }}>
                    {peWatched ? <IconBookmarkFilled size={11} /> : <IconBookmark size={11} />}
                  </button>
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button onClick={() => onOpenChart(pe, strike, "PE")} className="flex h-5 w-5 items-center justify-center rounded" style={{ background: "var(--pe-tint)", color: "var(--pe)" }}><IconChartCandle size={11} /></button>
                    <button onClick={() => onOpenPayoff(pe, strike, "PE")} title={`Payoff ${strike} PE`} className="flex h-5 w-5 items-center justify-center rounded" style={{ background: "var(--pe-tint)", color: "var(--pe)" }}><IconChartArea size={11} /></button>
                  </div>
                  <span className="text-[8px]" style={{ ...MONO, color: "var(--text-faint)" }}>{fmtOI(pe.oi)}</span>
                </div>
              </div>
            )}
            <OIBar pct={row.peOIBar} color="var(--pe)" />
          </div>
        </div>
      </div>

      {/* ── Desktop row ── */}
      <div className="hidden md:block">
        <div className="chain-grid border-b transition-colors" style={{ borderColor: "var(--border)", background: isATM ? "var(--accent-soft)" : undefined }}>
          <div className="flex items-center justify-center" style={{ background: "var(--ce-tint)" }}>
            <button onClick={() => onToggleWatch(ce, strike, "CE")} title={ceWatched ? `Remove CE ${strike}` : `Add CE ${strike} to watchlist`}
              className="flex h-6 w-6 items-center justify-center rounded border transition-all"
              style={ceWatched ? { background: "rgba(251,191,36,0.15)", borderColor: "rgba(251,191,36,0.6)", color: "#fbbf24" } : { background: "var(--accent-soft)", color: "var(--ce)", borderColor: "var(--border)" }}>
              {ceWatched ? <IconBookmarkFilled size={11} /> : <IconBookmark size={11} />}
            </button>
          </div>

          <div className="chain-col-oi relative overflow-hidden px-3 py-2 text-right" style={{ background: "var(--ce-tint)" }}>
            <div className="absolute bottom-0 right-0 top-0" style={{ width: `${row.ceOIBar}%`, background: "var(--accent-soft)" }} />
            <span className="tabular-nums relative z-10 text-[11px]" style={{ ...MONO, color: "var(--text-muted)" }}>{fmtOI(ce.oi)}</span>
          </div>

          <div className="group border-r px-2 py-2 text-right" style={{ borderColor: "var(--border)" }}>
            {scalperOn ? (
              <button onClick={() => onOrder(ce, strike, "CE", "BUY")} className="flex w-full flex-col items-end">
                <span className="tabular-nums text-[13px] font-bold leading-tight" style={{ ...MONO, color: ceInBand ? "var(--up)" : "var(--text)" }}>₹{ceLtp.toFixed(2)}</span>
                <span className="text-[9px] font-bold" style={{ ...MONO, color: cePct >= 0 ? "var(--up)" : "var(--down)" }}>{cePct >= 0 ? "+" : ""}{cePct.toFixed(2)}%</span>
              </button>
            ) : strategyOn ? (
              <div className="flex items-center justify-end gap-1.5">
                <div>
                  <div className="tabular-nums text-[13px] font-bold leading-tight" style={{ ...MONO, color: ceInBand ? "var(--up)" : "var(--text)" }}>₹{ceLtp.toFixed(2)}</div>
                  <div className="text-[8px]" style={{ ...MONO, color: cePct >= 0 ? "var(--up)" : "var(--down)" }}>{cePct >= 0 ? "+" : ""}{cePct.toFixed(2)}%</div>
                </div>
                <div className="flex flex-col gap-0.5">
                  <OrderBtn color="#e11d48" label="S" onClick={() => onOrder(ce, strike, "CE", "SELL")} />
                  <OrderBtn color="#16a34a" label="B" onClick={() => onOrder(ce, strike, "CE", "BUY")} />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-1.5">
                <button onClick={() => onOpenPayoff(ce, strike, "CE")} title={`Payoff ${strike} CE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100" style={{ color: "var(--ce)" }}>
                  <IconChartArea size={14} color="var(--ce)" />
                </button>
                <button onClick={() => onOpenChart(ce, strike, "CE")} title={`Chart ${strike} CE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100" style={{ color: "var(--ce)" }}>
                  <IconChartCandle size={14} color="var(--ce)" />
                </button>
                <div>
                  <div className="tabular-nums text-[13px] font-bold leading-tight" style={{ ...MONO, color: ceInBand ? "var(--up)" : "var(--text)" }}>₹{ceLtp.toFixed(2)}</div>
                  <div className="text-[8px]" style={{ ...MONO, color: ce.ltpChange >= 0 ? "var(--up)" : "var(--down)" }}>{ce.ltpChange >= 0 ? "▲" : "▼"}{Math.abs(ce.ltpChange).toFixed(2)}</div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col items-center justify-center border-x py-2 text-center" style={{ borderColor: "var(--border)", background: isATM ? "var(--accent-soft)" : "var(--card)" }}>
            <div className="tabular-nums text-[12px] font-bold leading-none" style={{ ...MONO, color: isATM ? "var(--accent)" : "var(--text)" }}>{strike}</div>
            {isATM && <div className="mt-0.5 text-[6px] font-bold tracking-[1px]" style={{ ...MONO, color: "var(--accent)" }}>ATM</div>}
            <button onClick={onOpenSplit} title={`CE + PE ${strike} split chart`} className="mt-1 flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }}><IconColumns size={11} /></button>
          </div>

          <div className="group border-l px-2 py-2 text-left" style={{ borderColor: "var(--border)" }}>
            {scalperOn ? (
              <button onClick={() => onOrder(pe, strike, "PE", "BUY")} className="flex w-full flex-col items-start">
                <span className="tabular-nums text-[13px] font-bold leading-tight" style={{ ...MONO, color: peInBand ? "var(--up)" : "var(--text)" }}>₹{peLtp.toFixed(2)}</span>
                <span className="text-[9px] font-bold" style={{ ...MONO, color: pePct >= 0 ? "var(--up)" : "var(--down)" }}>{pePct >= 0 ? "+" : ""}{pePct.toFixed(2)}%</span>
              </button>
            ) : strategyOn ? (
              <div className="flex items-center gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <OrderBtn color="#16a34a" label="B" onClick={() => onOrder(pe, strike, "PE", "BUY")} />
                  <OrderBtn color="#e11d48" label="S" onClick={() => onOrder(pe, strike, "PE", "SELL")} />
                </div>
                <div>
                  <div className="tabular-nums text-[13px] font-bold leading-tight" style={{ ...MONO, color: peInBand ? "var(--up)" : "var(--text)" }}>₹{peLtp.toFixed(2)}</div>
                  <div className="text-[8px]" style={{ ...MONO, color: pePct >= 0 ? "var(--up)" : "var(--down)" }}>{pePct >= 0 ? "+" : ""}{pePct.toFixed(2)}%</div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <div>
                  <div className="tabular-nums text-[13px] font-bold leading-tight" style={{ ...MONO, color: peInBand ? "var(--up)" : "var(--text)" }}>₹{peLtp.toFixed(2)}</div>
                  <div className="text-[8px]" style={{ ...MONO, color: pe.ltpChange >= 0 ? "var(--up)" : "var(--down)" }}>{pe.ltpChange >= 0 ? "▲" : "▼"}{Math.abs(pe.ltpChange).toFixed(2)}</div>
                </div>
                <button onClick={() => onOpenChart(pe, strike, "PE")} title={`Chart ${strike} PE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100">
                  <IconChartCandle size={14} color="var(--pe)" />
                </button>
                <button onClick={() => onOpenPayoff(pe, strike, "PE")} title={`Payoff ${strike} PE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100">
                  <IconChartArea size={14} color="var(--pe)" />
                </button>
              </div>
            )}
          </div>

          <div className="chain-col-oi relative overflow-hidden px-3 py-2 text-left" style={{ background: "var(--pe-tint)" }}>
            <div className="absolute bottom-0 left-0 top-0" style={{ width: `${row.peOIBar}%`, background: "rgba(225,29,72,0.08)" }} />
            <span className="tabular-nums relative z-10 text-[11px]" style={{ ...MONO, color: "var(--text-muted)" }}>{fmtOI(pe.oi)}</span>
          </div>

          <div className="flex items-center justify-center" style={{ background: "var(--pe-tint)" }}>
            <button onClick={() => onToggleWatch(pe, strike, "PE")} title={peWatched ? `Remove PE ${strike}` : `Add PE ${strike} to watchlist`}
              className="flex h-6 w-6 items-center justify-center rounded border transition-all"
              style={peWatched ? { background: "rgba(251,191,36,0.15)", borderColor: "rgba(251,191,36,0.6)", color: "#fbbf24" } : { background: "rgba(225,29,72,0.1)", color: "var(--pe)", borderColor: "var(--border)" }}>
              {peWatched ? <IconBookmarkFilled size={11} /> : <IconBookmark size={11} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
});

// Mirrors the real chain's wrapper (flex min-h-0 flex-1 flex-col overflow-
// hidden) and row height/count so the flex layout computes the same space
// before and after the data arrives — a bare "Loading…" line let the parent
// flex box collapse to a small height, then jump to the real table's height
// the instant data landed, which was the single biggest layout shift
// Lighthouse flagged (CLS 0.22, "poor").
function ChainSkeleton() {
  const rows = Array.from({ length: 15 });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="hidden flex-shrink-0 border-b border-[var(--border)] md:block">
        <div className="chain-grid">
          {Array.from({ length: 7 }).map((_, i) => <div key={i} className="py-2" style={{ background: i % 2 === 0 ? "var(--ce-tint)" : "var(--pe-tint)" }} />)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Desktop rows — 7-col chain-grid, matches the real Row's desktop block. */}
        <div className="hidden md:block">
          {rows.map((_, i) => (
            <div key={i} className="chain-grid animate-pulse border-b border-[var(--border)]" style={{ height: 44 }}>
              {Array.from({ length: 7 }).map((_, j) => <div key={j} className="m-2 rounded" style={{ background: "var(--card-hover)" }} />)}
            </div>
          ))}
        </div>
        {/* Mobile rows — 3-col grid (CE | strike | PE), matches the real Row's mobile block. */}
        <div className="md:hidden">
          {rows.map((_, i) => (
            <div key={i} className="grid animate-pulse grid-cols-[1fr_72px_1fr] border-b border-[var(--border)]" style={{ height: 60 }}>
              <div className="m-2 rounded" style={{ background: "var(--card-hover)" }} />
              <div className="m-2 rounded" style={{ background: "var(--card-hover)" }} />
              <div className="m-2 rounded" style={{ background: "var(--card-hover)" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OrderBtn({ color, label, onClick }: { color: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-[22px] w-[22px] flex-shrink-0 cursor-pointer items-center justify-center rounded text-[9px] font-black transition-all active:scale-90"
      style={{ ...MONO, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {label}
    </button>
  );
}

function OIBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-[3px] overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: color, opacity: 0.55 }} />
    </div>
  );
}

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function fmtExpiry(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}
