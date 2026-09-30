"use client";

// ─── Option chain (Chain tab) ───────────────────────────────────────────────────
// Port of the chain view inside frontend/app/options/page.tsx
// (OptionsPageInner's activeTab==="chain" branch, plus ChainRow): NIFTY only
// (no SENSEX), desktop 7-col chain-grid (bookmark | OI | LTP | STRIKE | LTP |
// OI | bookmark) with the mobile 3-col card layout, the ATM sticky divider,
// per-row bookmark → default watchlist group, payoff view, and split CE+PE
// chart view. The original's Scalper/Strategy order modes are intentionally
// not part of this app, and neither is the Sensibull iframe panel.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { IconBookmark, IconBookmarkFilled, IconChartCandle, IconChartArea, IconColumns } from "@tabler/icons-react";
import { ChartPanel, type ChartTarget } from "./ChartPanel";
import { PayoffChart, type PayoffTarget } from "./PayoffChart";
import { useChainStore, useLtp, usePrevLtp } from "@/lib/store/chainStore";
import { useTheme } from "@/lib/theme";
import { MIN_PREMIUM, MAX_PREMIUM } from "@/lib/strategies/constants";
import type { ChainRow as ChainRowT, OptionChain as Chain, Leg } from "@/lib/broker/types";

const MONO = { fontFamily: "'Inter', sans-serif" } as const;
const index = "NIFTY";

type WatchedItem = { token: number; tradingsymbol: string; strike: number; type: string; ltp: number };

function fmtOI(n: number): string {
  return n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
}

export function OptionChainView() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const chain = useChainStore((s) => s.chain);
  const setChain = useChainStore((s) => s.setChain);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [watchedTokens, setWatchedTokens] = useState<Set<number>>(new Set());
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [splitTarget, setSplitTarget] = useState<{ ce: ChartTarget; pe: ChartTarget } | null>(null);
  const [payoffTarget, setPayoffTarget] = useState<PayoffTarget | null>(null);

  useEffect(() => {
    fetch("/api/watchlist/groups").then(r => r.json()).then(d => {
      const def = (d.groups ?? []).find((g: any) => g.id === "wl_default");
      setWatchedTokens(new Set((def?.items ?? []).map((i: WatchedItem) => i.token)));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/expiries")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setExpiries(d.expiries ?? []);
        setExpiry((cur) => cur || d.expiries?.[0] || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!expiry) return;
    let alive = true;
    setLoading(true);

    const load = () =>
      fetch(`/api/chain?expiry=${expiry}&strikes=15`)
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
  }, [expiry, setChain]);

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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="px-3 py-3 md:px-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div>
            <div className="text-xs text-faint">{index} 50</div>
            <div className="tabular text-2xl font-semibold">{chain ? chain.spot.toFixed(2) : "—"}</div>
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
              <div className="chain-col-oi px-3 py-2 text-right text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--ce)", background: "var(--ce-tint)" }}>CE OI</div>
              <div className="px-3 py-2 text-right text-xs font-bold uppercase tracking-[1.5px] border-r border-[var(--border)]" style={{ ...MONO, color: "var(--ce)", background: "var(--ce-tint)" }}>CE LTP</div>
              <div className="px-2 py-2 text-center text-xs font-bold uppercase tracking-[1.5px] border-x border-[var(--border)]" style={{ ...MONO, color: "var(--text-muted)", background: "var(--card)" }}>STRIKE</div>
              <div className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[1.5px] border-l border-[var(--border)]" style={{ ...MONO, color: "var(--pe)", background: "var(--pe-tint)" }}>PE LTP</div>
              <div className="chain-col-oi px-3 py-2 text-left text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--pe)", background: "var(--pe-tint)" }}>PE OI</div>
              <div className="py-2 border-l border-[var(--border)]" style={{ background: "var(--pe-tint)" }} />
            </div>
          </div>

          {/* ── Mobile column headers ── */}
          <div className="flex-shrink-0 border-b border-[var(--border)] md:hidden">
            <div className="grid grid-cols-[1fr_88px_1fr] text-xs font-bold tracking-[0.5px]" style={MONO}>
              <div className="px-3 py-1.5 text-center" style={{ color: "var(--ce)", background: "var(--ce-tint)" }}>Call (₹)</div>
              <div className="flex items-center justify-center py-1.5 text-center text-xs" style={{ color: "var(--text-muted)", background: "var(--card)" }}>
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
                    <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-sm font-bold" style={{ ...MONO, color: isDark ? "#fff" : "var(--accent)", background: isDark ? "#1e293b" : "#fff", border: "1px solid var(--accent)" }}>
                      {index} {chain.spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <div className="h-px flex-1" style={{ background: "var(--accent-soft)" }} />
                  </div>
                )}
                <Row
                  row={row}
                  watchedTokens={watchedTokens}
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
          <div className="text-sm uppercase tracking-wide text-faint">{label}</div>
          <div className="tabular text-sm font-medium">{value}</div>
        </div>
      ))}
    </div>
  );
}

/** One strike, both mobile card and desktop grid layouts. memo + per-token
 *  price subscriptions mean a tick on this leg re-renders THIS row only. */
const Row = memo(function Row({ row, watchedTokens, onToggleWatch, onOpenChart, onOpenPayoff, onOpenSplit }: {
  row: ChainRowT; watchedTokens: Set<number>;
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
        <div className="grid grid-cols-[1fr_88px_1fr]">
          <div className="flex flex-col gap-1 px-1.5 py-2" style={{ background: isATM ? "var(--ce-tint)" : undefined }}>
            <div className="flex w-full flex-col gap-0.5">
              <div className="flex items-start justify-between">
                <button onClick={() => onToggleWatch(ce, strike, "CE")} className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded" style={{ background: ceWatched ? "#fbbf2420" : "transparent", color: ceWatched ? "#f59e0b" : "var(--text-faint)" }}>
                  {ceWatched ? <IconBookmarkFilled size={11} /> : <IconBookmark size={11} />}
                </button>
                <div className="ml-0.5 flex flex-1 flex-col items-end">
                  <span className="tabular-nums text-base font-bold leading-tight" style={MONO}>{ceLtp.toFixed(2)}</span>
                  <span className="text-xs font-bold" style={{ ...MONO, color: "var(--ce)" }}>{strike} CE</span>
                </div>
              </div>
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{fmtOI(ce.oi)}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => onOpenPayoff(ce, strike, "CE")} title={`Payoff ${strike} CE`} className="flex h-5 w-5 items-center justify-center rounded" style={{ background: "var(--ce-tint)", color: "var(--ce)" }}><IconChartArea size={11} /></button>
                  <button onClick={() => onOpenChart(ce, strike, "CE")} className="flex h-5 w-5 items-center justify-center rounded" style={{ background: "var(--ce-tint)", color: "var(--ce)" }}><IconChartCandle size={11} /></button>
                </div>
              </div>
            </div>
            <OIBar pct={row.ceOIBar} color="var(--ce)" />
          </div>

          <div className="flex flex-col items-center justify-center gap-0.5 border-x py-2" style={{ borderColor: "var(--border)", background: isATM ? "var(--accent-soft)" : "var(--card)" }}>
            <span className="tabular-nums text-sm font-bold leading-none" style={{ ...MONO, color: isATM ? "var(--accent)" : "var(--text)" }}>{strike}</span>
            <span className="tabular-nums text-xs font-bold" style={{ ...MONO, color: rowPCR >= 1 ? "var(--up)" : "var(--down)" }}>PCR {rowPCR.toFixed(2)}</span>
            <button onClick={onOpenSplit} title={`CE + PE ${strike} split chart`} className="flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }}><IconColumns size={11} /></button>
          </div>

          <div className="flex flex-col gap-1 px-1.5 py-2" style={{ background: isATM ? "var(--pe-tint)" : undefined }}>
            <div className="flex w-full flex-col gap-0.5">
              <div className="flex items-start justify-between">
                <div className="mr-0.5 flex flex-1 flex-col items-start">
                  <span className="tabular-nums text-base font-bold leading-tight" style={MONO}>{peLtp.toFixed(2)}</span>
                  <span className="text-xs font-bold" style={{ ...MONO, color: "var(--pe)" }}>{strike} PE</span>
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
                <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{fmtOI(pe.oi)}</span>
              </div>
            </div>
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
            <span className="tabular-nums relative z-10 text-sm" style={{ ...MONO, color: "var(--text-muted)" }}>{fmtOI(ce.oi)}</span>
          </div>

          <div className="group border-r px-2 py-2 text-right" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-end gap-1.5">
              <button onClick={() => onOpenPayoff(ce, strike, "CE")} title={`Payoff ${strike} CE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100" style={{ color: "var(--ce)" }}>
                <IconChartArea size={14} color="var(--ce)" />
              </button>
              <button onClick={() => onOpenChart(ce, strike, "CE")} title={`Chart ${strike} CE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100" style={{ color: "var(--ce)" }}>
                <IconChartCandle size={14} color="var(--ce)" />
              </button>
              <div>
                <div className="tabular-nums text-base font-bold leading-tight" style={{ ...MONO, color: ceInBand ? "var(--up)" : "var(--text)" }}>₹{ceLtp.toFixed(2)}</div>
                <div className="text-xs" style={{ ...MONO, color: ce.ltpChange >= 0 ? "var(--up)" : "var(--down)" }}>{ce.ltpChange >= 0 ? "▲" : "▼"}{Math.abs(ce.ltpChange).toFixed(2)}</div>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center border-x py-2 text-center" style={{ borderColor: "var(--border)", background: isATM ? "var(--accent-soft)" : "var(--card)" }}>
            <div className="tabular-nums text-sm font-bold leading-none" style={{ ...MONO, color: isATM ? "var(--accent)" : "var(--text)" }}>{strike}</div>
            {isATM && <div className="mt-0.5 text-xs font-bold tracking-[1px]" style={{ ...MONO, color: "var(--accent)" }}>ATM</div>}
            <button onClick={onOpenSplit} title={`CE + PE ${strike} split chart`} className="mt-1 flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }}><IconColumns size={11} /></button>
          </div>

          <div className="group border-l px-2 py-2 text-left" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-1.5">
              <div>
                <div className="tabular-nums text-base font-bold leading-tight" style={{ ...MONO, color: peInBand ? "var(--up)" : "var(--text)" }}>₹{peLtp.toFixed(2)}</div>
                <div className="text-xs" style={{ ...MONO, color: pe.ltpChange >= 0 ? "var(--up)" : "var(--down)" }}>{pe.ltpChange >= 0 ? "▲" : "▼"}{Math.abs(pe.ltpChange).toFixed(2)}</div>
              </div>
              <button onClick={() => onOpenChart(pe, strike, "PE")} title={`Chart ${strike} PE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100">
                <IconChartCandle size={14} color="var(--pe)" />
              </button>
              <button onClick={() => onOpenPayoff(pe, strike, "PE")} title={`Payoff ${strike} PE`} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-30 transition-opacity group-hover:opacity-100">
                <IconChartArea size={14} color="var(--pe)" />
              </button>
            </div>
          </div>

          <div className="chain-col-oi relative overflow-hidden px-3 py-2 text-left" style={{ background: "var(--pe-tint)" }}>
            <div className="absolute bottom-0 left-0 top-0" style={{ width: `${row.peOIBar}%`, background: "rgba(225,29,72,0.08)" }} />
            <span className="tabular-nums relative z-10 text-sm" style={{ ...MONO, color: "var(--text-muted)" }}>{fmtOI(pe.oi)}</span>
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
            <div key={i} className="grid animate-pulse grid-cols-[1fr_88px_1fr] border-b border-[var(--border)]" style={{ height: 60 }}>
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
