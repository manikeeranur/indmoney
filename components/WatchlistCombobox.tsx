"use client";

// ─── Cross-segment instrument search (Watchlist tab) ───────────────────────
// Full port of frontend/components/WatchlistCombobox.tsx: search the CURRENT
// option chain's strikes AND the whole NSE/BSE equity universe (via
// /api/search-instruments, backed by INDstocks' own equity instrument
// master), each in its own section with a "show more" expander.
//
// Ported without @radix-ui/react-popover (not a dependency here) — a plain
// absolute-positioned panel with an outside-click listener gives the same
// popover behavior with one less package.
import { useCallback, useEffect, useRef, useState } from "react";
import { IconPlus, IconSearch, IconLoader2, IconX } from "@tabler/icons-react";
import type { Index, OptionChain } from "@/lib/broker/types";

const MONO = { fontFamily: "'Inter', sans-serif" } as const;

export type SearchResult = {
  token: number; tradingsymbol: string; name: string; exchange: string;
  type: "EQ" | "CE" | "PE"; ltp: number; pct?: number; oi?: number; iv?: number;
  isOption?: boolean; strike?: number; index?: Index;
};

type Props = {
  chain: OptionChain | null;
  chainIndex: Index;
  expiry: string;
  watchedTokens: Set<number>;
  onAdd: (result: SearchResult) => void;
};

function StockLogo({ symbol, size = 34 }: { symbol: string; size?: number }) {
  const [err, setErr] = useState(false);
  const letter = (symbol || "?")[0].toUpperCase();
  const colors = ["#0284c7", "#16a34a", "#7c3aed", "#ea580c", "#db2777", "#0891b2", "#b45309"];
  const color = colors[letter.charCodeAt(0) % colors.length];
  if (err) {
    return <div className="flex flex-shrink-0 items-center justify-center rounded-full font-black text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}>{(symbol || "?").slice(0, 2)}</div>;
  }
  return (
    <div className="flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-white" style={{ width: size, height: size, border: "1.5px solid var(--border)" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`https://images.smallcase.com/smallplug-v2/200/${symbol}.png`} alt={symbol} onError={() => setErr(true)} className="h-full w-full object-contain p-0.5" />
    </div>
  );
}
function OptionLogo({ index, type, size = 34 }: { index: Index; type: "CE" | "PE"; size?: number }) {
  const dirClr = type === "CE" ? "var(--ce)" : "var(--pe)";
  return (
    <div className="flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ width: size, height: size, border: `2px solid ${dirClr}`, background: "#111" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={index === "SENSEX" ? "/sensex-logo.avif" : "/nifty-logo.png"} alt={index} className="h-full w-full object-cover" />
    </div>
  );
}

const INITIAL_SHOW = 5;

export default function WatchlistCombobox({ chain, chainIndex, expiry, watchedTokens, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [apiResults, setApiResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAllChain, setShowAllChain] = useState(false);
  const [showAllApi, setShowAllApi] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const q = query.trim().toUpperCase();
  const chainSuggestions: SearchResult[] = [];
  if (chain?.rows.length) {
    const mid = Math.floor(chain.rows.length / 2);
    const queryMatchesChain = !q || chainIndex.includes(q);
    chain.rows.forEach((row, idx) => {
      ([row.ce, row.pe] as const).forEach(leg => {
        const strikeStr = `${row.strike}`;
        const isNearATM = Math.abs(idx - mid) <= 2;
        const match = !q || (isNearATM && queryMatchesChain) || strikeStr.includes(q) || leg.type.includes(q)
          || (q === "CALL" && leg.type === "CE") || (q === "PUT" && leg.type === "PE")
          || chainIndex.includes(q) || `${chainIndex}${strikeStr}`.includes(q.replace(/\s/g, ""));
        if (match) {
          const pct = leg.ltp > 0 && leg.prevLtp > 0 ? ((leg.ltpChange ?? 0) / leg.prevLtp) * 100 : 0;
          chainSuggestions.push({ token: leg.token, tradingsymbol: leg.tradingsymbol, name: `${chainIndex} ${row.strike} ${leg.type === "CE" ? "Call" : "Put"}`, exchange: chainIndex === "SENSEX" ? "BFO" : "NFO", type: leg.type, ltp: leg.ltp, strike: row.strike, oi: leg.oi, iv: leg.iv, pct, isOption: true, index: chainIndex });
        }
      });
    });
  }
  const visibleChainAll = chainSuggestions.filter(r => !watchedTokens.has(r.token));
  const filteredChain = showAllChain ? visibleChainAll : visibleChainAll.slice(0, INITIAL_SHOW);
  const chainHasMore = visibleChainAll.length > INITIAL_SHOW && !showAllChain;

  const visibleApiAll = apiResults.filter(r => !watchedTokens.has(r.token));
  const filteredApi = showAllApi ? visibleApiAll : visibleApiAll.slice(0, INITIAL_SHOW);
  const apiHasMore = visibleApiAll.length > INITIAL_SHOW && !showAllApi;

  const handleQueryChange = useCallback((val: string) => {
    setQuery(val);
    setShowAllChain(false);
    setShowAllApi(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!val.trim()) { setApiResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/search-instruments?q=${encodeURIComponent(val.trim())}`).then(r => r.json());
        setApiResults(r.results ?? []);
      } catch { setApiResults([]); }
      finally { setLoading(false); }
    }, 350);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else { setQuery(""); setApiResults([]); setShowAllChain(false); setShowAllApi(false); }
  }, [open]);

  function handleClick(result: SearchResult, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    onAdd(result);
  }

  const hasResults = visibleChainAll.length > 0 || loading || visibleApiAll.length > 0;

  return (
    <div className="relative mb-4" ref={panelRef}>
      <button onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold transition-colors lg:w-[25vw]"
        style={{ ...MONO, border: "1px solid var(--accent)", background: open ? "var(--accent)" : "var(--accent-soft)", color: open ? "#fff" : "var(--accent)" }}>
        <IconSearch size={13} /><span className="flex-1 text-left">Search stocks &amp; options…</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 flex flex-col overflow-hidden rounded-xl shadow-2xl outline-none"
          style={{ width: "max(25vw, 300px)", maxWidth: "calc(100vw - 24px)", border: "1px solid var(--border)", background: "var(--bg-elevated)", maxHeight: "70vh" }}>
          <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
            <IconSearch size={14} color="var(--text-faint)" />
            <input ref={inputRef} value={query} onChange={e => handleQueryChange(e.target.value)} placeholder="BHEL, RVNL, NIFTY22300, CE…"
              className="flex-1 bg-transparent text-sm outline-none" style={{ ...MONO, color: "var(--text)" }}
              onKeyDown={e => e.key === "Escape" && setOpen(false)} />
            {query && (
              <button onClick={() => { setQuery(""); setApiResults([]); inputRef.current?.focus(); }} className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "var(--card)", color: "var(--text-muted)" }}>
                <IconX size={10} />
              </button>
            )}
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {visibleChainAll.length > 0 && (
              <div>
                <div className="border-b px-3 py-1.5 text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)", borderColor: "var(--border)" }}>{chainIndex} Options · {expiry}</div>
                {filteredChain.map(r => {
                  const dirClr = r.type === "CE" ? "var(--ce)" : "var(--pe)";
                  return (
                    <button key={`opt-${r.token}`} onClick={e => handleClick(r, e)} className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left transition-colors hover:bg-[var(--card-hover)]" style={{ borderColor: "var(--border)" }}>
                      <OptionLogo index={r.index!} type={r.type as "CE" | "PE"} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold" style={{ ...MONO, color: "var(--text)" }}>{r.index} {r.strike}</span>
                          <span className="rounded px-1.5 py-0.5 text-xs font-bold" style={{ background: `${dirClr}22`, color: dirClr }}>{r.type === "CE" ? "Call" : "Put"}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <span className="tabular-nums text-sm font-bold" style={{ ...MONO, color: "var(--text)" }}>₹{r.ltp.toFixed(2)}</span>
                          {r.pct !== undefined && <span className="text-xs font-bold" style={{ ...MONO, color: (r.pct ?? 0) >= 0 ? "var(--up)" : "var(--down)" }}>{(r.pct ?? 0) >= 0 ? "+" : ""}{r.pct?.toFixed(2)}%</span>}
                          {r.oi !== undefined && <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>OI {r.oi >= 100000 ? `${(r.oi / 100000).toFixed(1)}L` : r.oi >= 1000 ? `${(r.oi / 1000).toFixed(0)}K` : r.oi}</span>}
                          {r.iv !== undefined && <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>IV {r.iv?.toFixed(1)}%</span>}
                        </div>
                      </div>
                      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "var(--ce-tint)", color: "var(--ce)" }}><IconPlus size={13} /></div>
                    </button>
                  );
                })}
                {chainHasMore && <button onClick={() => setShowAllChain(true)} className="w-full border-t px-3 py-2 text-center text-sm font-bold" style={{ ...MONO, color: "var(--accent)", borderColor: "var(--border)" }}>Show {visibleChainAll.length - INITIAL_SHOW} more options →</button>}
              </div>
            )}

            {(loading || visibleApiAll.length > 0) && (
              <div>
                {visibleChainAll.length > 0 && <div style={{ height: 1, background: "var(--border)" }} />}
                <div className="border-b px-3 py-1.5 text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-faint)", borderColor: "var(--border)" }}>Stocks</div>
                {loading && <div className="flex items-center gap-2 px-3 py-4 text-sm" style={{ ...MONO, color: "var(--text-faint)" }}><IconLoader2 size={14} className="animate-spin" />Searching…</div>}
                {!loading && filteredApi.map(r => (
                  <button key={`eq-${r.token}`} onClick={e => handleClick(r, e)} className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left transition-colors hover:bg-[var(--card-hover)]" style={{ borderColor: "var(--border)" }}>
                    <StockLogo symbol={r.tradingsymbol} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-bold" style={{ ...MONO, color: "var(--text)" }}>{r.tradingsymbol}</span>
                        <span className="rounded px-1 py-0.5 text-xs font-bold" style={{ background: "var(--card)", color: "var(--text-muted)" }}>{r.exchange}</span>
                      </div>
                      <div className="truncate text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>{r.name}</div>
                      {r.ltp > 0 && <span className="tabular-nums text-sm font-bold" style={{ ...MONO, color: "var(--text)" }}>₹{r.ltp.toFixed(2)}</span>}
                    </div>
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "var(--up-soft)", color: "var(--up)" }}><IconPlus size={13} /></div>
                  </button>
                ))}
                {!loading && apiHasMore && <button onClick={() => setShowAllApi(true)} className="w-full border-t px-3 py-2 text-center text-sm font-bold" style={{ ...MONO, color: "var(--up)", borderColor: "var(--border)" }}>Show {visibleApiAll.length - INITIAL_SHOW} more stocks →</button>}
              </div>
            )}

            {!loading && query.length > 0 && !hasResults && <div className="px-3 py-8 text-center text-sm" style={{ ...MONO, color: "var(--text-faint)" }}>No results for &quot;{query}&quot;</div>}
            {!query && !hasResults && <div className="px-3 py-6 text-center text-sm" style={{ ...MONO, color: "var(--text-faint)" }}>Type stock name or option strike</div>}
          </div>
        </div>
      )}
    </div>
  );
}
