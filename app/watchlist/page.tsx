"use client";

// ─── Watchlist tab ──────────────────────────────────────────────────────────────
// Full port of frontend's watchlist: groups (create/switch/delete, same
// /api/watchlist/groups persistence), the WatchlistRow card design
// (drag-handle reordering, NIFTY/SENSEX index logo, full "NIFTY 29 Sep
// ₹23400 Call" symbol label, live ▲/▼ %-change), the live index ticker strip
// (IndexSwiper), AND the full cross-segment instrument search
// (WatchlistCombobox) — current chain strikes plus the whole NSE/BSE equity
// universe via /api/search-instruments. Equity items get their own card
// variant (StockLogo, exchange tag, no strike/CE-PE) and a lightweight
// separate poll for live price via /api/quotes, since they aren't part of
// the option chain's own WebSocket subscription.
import { useEffect, useState } from "react";
import { useChainStore, useLtp, usePrevLtp } from "@/lib/store/chainStore";
import IndexSwiper from "@/components/IndexSwiper";
import WatchlistCombobox, { type SearchResult } from "@/components/WatchlistCombobox";

type WatchedItem = { token: number; tradingsymbol: string; strike: number; type: string; ltp: number; isEquity?: boolean; exchange?: string; name?: string };
type Group = { id: string; name: string; items: WatchedItem[] };

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function WatchlistPage() {
  const [groups, setGroups] = useState<Group[]>([{ id: "wl_default", name: "My Watchlist", items: [] }]);
  const [activeId, setActiveId] = useState("wl_default");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [dragToken, setDragToken] = useState<number | null>(null);
  const [dragOverToken, setDragOverToken] = useState<number | null>(null);
  const [equityQuotes, setEquityQuotes] = useState<Record<number, number>>({});
  const chain = useChainStore(s => s.chain);

  useEffect(() => {
    fetch("/api/watchlist/groups").then(r => r.json()).then(d => { if (d.groups?.length) setGroups(d.groups); });
  }, []);

  const active = groups.find(g => g.id === activeId) ?? groups[0];

  // Equity items aren't on the chain WebSocket — poll their LTP separately.
  useEffect(() => {
    const equities = active.items.filter(i => i.isEquity);
    if (!equities.length) return;
    let alive = true;
    const poll = () => {
      const codes = equities.map(i => `${i.exchange ?? "NSE"}_${i.token}`).join(",");
      fetch(`/api/quotes?codes=${codes}`).then(r => r.json()).then(d => {
        if (!alive || !d.quotes) return;
        const next: Record<number, number> = {};
        for (const i of equities) { const v = d.quotes[`${i.exchange ?? "NSE"}_${i.token}`]; if (v) next[i.token] = v; }
        setEquityQuotes(prev => ({ ...prev, ...next }));
      }).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [active.items]);

  async function persist(next: Group[]) {
    setGroups(next);
    const g = next.find(x => x.id === activeId);
    if (g) await fetch(`/api/watchlist/groups/${g.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: g.name, items: g.items }) });
  }

  function addItem(item: WatchedItem) {
    if (active.items.some(i => i.token === item.token)) return;
    persist(groups.map(g => g.id === activeId ? { ...g, items: [...g.items, item] } : g));
  }
  function addFromSearch(r: SearchResult) {
    if (r.isOption) addItem({ token: r.token, tradingsymbol: r.tradingsymbol, strike: r.strike ?? 0, type: r.type, ltp: r.ltp });
    else addItem({ token: r.token, tradingsymbol: r.tradingsymbol, strike: 0, type: "EQ", ltp: r.ltp, isEquity: true, exchange: r.exchange, name: r.name });
  }
  function removeItem(token: number) {
    persist(groups.map(g => g.id === activeId ? { ...g, items: g.items.filter(i => i.token !== token) } : g));
  }
  function reorder(fromToken: number, toToken: number) {
    if (fromToken === toToken) return;
    persist(groups.map(g => {
      if (g.id !== activeId) return g;
      const items = [...g.items];
      const from = items.findIndex(i => i.token === fromToken);
      const to = items.findIndex(i => i.token === toToken);
      if (from < 0 || to < 0) return g;
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { ...g, items };
    }));
  }
  function createGroup() {
    if (!newName.trim()) return;
    const id = `wl_${Date.now()}`;
    const next = [...groups, { id, name: newName.trim(), items: [] }];
    setGroups(next);
    setActiveId(id);
    setCreating(false); setNewName("");
    fetch(`/api/watchlist/groups/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName.trim(), items: [] }) });
  }
  async function deleteGroup(id: string) {
    if (id === "wl_default") return;
    await fetch(`/api/watchlist/groups/${id}`, { method: "DELETE" });
    setGroups(prev => prev.filter(g => g.id !== id));
    if (activeId === id) setActiveId("wl_default");
  }

  const watchedTokens = new Set(active.items.map(i => i.token));

  return (
    <div className="py-4">
      <IndexSwiper />
      <div className="px-3 md:px-5">
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {groups.map(g => (
          <button key={g.id} onClick={() => setActiveId(g.id)}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-bold transition-all"
            style={{ background: activeId === g.id ? "var(--accent)" : "var(--card)", color: activeId === g.id ? "#fff" : "var(--text-muted)", border: `1px solid ${activeId === g.id ? "var(--accent)" : "var(--border)"}` }}>
            {g.name} <span className="opacity-70">{g.items.length}</span>
          </button>
        ))}
        {!creating ? (
          <button onClick={() => setCreating(true)} className="flex h-6 w-6 items-center justify-center rounded-full text-xs" style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>+</button>
        ) : (
          <div className="flex items-center gap-1">
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && createGroup()} placeholder="Name…"
              className="w-[120px] rounded-lg border px-2 py-1 text-sm outline-none" style={{ borderColor: "var(--accent)", background: "var(--bg)", color: "var(--text)" }} />
            <button onClick={createGroup} className="flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: "var(--up)" }}>✓</button>
            <button onClick={() => setCreating(false)} className="flex h-6 w-6 items-center justify-center rounded-full text-muted" style={{ background: "var(--card)" }}>✕</button>
          </div>
        )}
        {activeId !== "wl_default" && !creating && (
          <button onClick={() => deleteGroup(activeId)} className="text-sm text-faint hover:text-fg">Delete</button>
        )}
      </div>

      <WatchlistCombobox chain={chain} chainIndex="NIFTY" expiry={chain?.expiry ?? ""} watchedTokens={watchedTokens} onAdd={addFromSearch} />

      {active.items.length === 0 ? (
        <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
          <div className="text-[40px]" style={{ color: "var(--border-strong)" }}>◈</div>
          <p className="text-center text-sm tabular" style={{ color: "var(--text-muted)" }}>{active.name} is empty</p>
          <p className="text-center text-sm tabular" style={{ color: "var(--text-faint)" }}>Search above or use + on chain rows</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 pb-4 lg:grid-cols-4">
          {active.items.map(item => (
            <WatchRow key={item.token} item={item} expiry={chain?.expiry} isDragOver={dragOverToken === item.token} liveEquityLtp={equityQuotes[item.token]}
              onRemove={() => removeItem(item.token)}
              onDragStart={() => setDragToken(item.token)}
              onDragOver={e => { e.preventDefault(); setDragOverToken(item.token); }}
              onDrop={() => { if (dragToken != null) reorder(dragToken, item.token); setDragToken(null); setDragOverToken(null); }}
              onDragEnd={() => { setDragToken(null); setDragOverToken(null); }} />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

function WatchRow(props: {
  item: WatchedItem; expiry?: string; isDragOver: boolean; liveEquityLtp?: number; onRemove: () => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void;
}) {
  return props.item.isEquity ? <EquityWatchRow {...props} /> : <OptionWatchRow {...props} />;
}

function OptionWatchRow({ item, expiry, isDragOver, onRemove, onDragStart, onDragOver, onDrop, onDragEnd }: {
  item: WatchedItem; expiry?: string; isDragOver: boolean; onRemove: () => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void;
}) {
  const ltp = useLtp(item.token) ?? item.ltp;
  const prevLtp = usePrevLtp(item.token);
  // ltp <= 0 means no real live price yet (market closed, or no tick since
  // load) — computing change against that would read as "down 100%" against
  // whatever prevLtp is, which isn't a real move, just missing data.
  const change = ltp > 0 && prevLtp != null ? ltp - prevLtp : 0;
  const pct = ltp > 0 && prevLtp ? (change / Math.abs(prevLtp)) * 100 : 0;
  const pctUp = pct >= 0;
  const isCE = item.type === "CE";
  const dirClr = isCE ? "var(--ce)" : "var(--pe)";
  const underlying = (item.tradingsymbol ?? "").match(/^[A-Z&]+/)?.[0] ?? "NIFTY";
  const isSensex = underlying === "SENSEX" || underlying === "BSX";
  const logoSrc = isSensex ? "/sensex-logo.avif" : "/nifty-logo.png";
  const dateStr = expiry ? (() => { const d = new Date(expiry + "T00:00:00Z"); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; })() : "";

  return (
    <div draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      className="flex select-none items-center gap-3 rounded-xl border px-4 py-3 transition-all"
      style={{ background: "var(--card)", borderColor: isDragOver ? "var(--accent)" : "var(--border)", opacity: isDragOver ? 0.6 : 1 }}>
      <span className="flex-shrink-0 cursor-grab text-base leading-none" style={{ color: "var(--text-faint)" }}>⠿</span>
      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ border: `2px solid ${dirClr}`, background: "#111" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} alt={isSensex ? "SENSEX" : "NIFTY 50"} className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold tabular" style={{ color: "var(--text)" }}>
          {underlying} {dateStr} ₹{item.strike} {isCE ? "Call" : "Put"}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="tabular text-sm font-bold" style={{ color: "var(--text)" }}>₹{ltp?.toFixed(2)}</span>
          <span className="tabular text-sm font-bold" style={{ color: pctUp ? "var(--up)" : "var(--down)" }}>
            {pctUp ? "▲" : "▼"}{Math.abs(pct).toFixed(2)}%
          </span>
        </div>
      </div>
      <button onClick={e => { e.stopPropagation(); onRemove(); }}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:opacity-70"
        style={{ background: "var(--card-hover)", color: "var(--text-faint)" }}>✕</button>
    </div>
  );
}

function EquityWatchRow({ item, isDragOver, liveEquityLtp, onRemove, onDragStart, onDragOver, onDrop, onDragEnd }: {
  item: WatchedItem; isDragOver: boolean; liveEquityLtp?: number; onRemove: () => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void;
}) {
  const [logoErr, setLogoErr] = useState(false);
  const ltp = liveEquityLtp ?? item.ltp;
  const sym = item.tradingsymbol ?? "STOCK";
  const letter = sym[0]?.toUpperCase() ?? "S";
  const colors = ["#0284c7", "#16a34a", "#7c3aed", "#ea580c", "#db2777", "#0891b2", "#b45309"];
  const avatarColor = colors[letter.charCodeAt(0) % colors.length];

  return (
    <div draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      className="flex select-none items-center gap-3 rounded-xl border px-4 py-3 transition-all"
      style={{ background: "var(--card)", borderColor: isDragOver ? "var(--accent)" : "var(--border)", opacity: isDragOver ? 0.6 : 1 }}>
      <span className="flex-shrink-0 cursor-grab text-base leading-none" style={{ color: "var(--text-faint)" }}>⠿</span>
      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ border: "2px solid var(--border)", background: logoErr ? avatarColor : "#fff" }}>
        {logoErr ? <span className="text-base font-black text-white">{sym.slice(0, 2)}</span> : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://images.smallcase.com/smallplug-v2/200/${sym}.png`} alt={sym} onError={() => setLogoErr(true)} className="h-full w-full object-contain p-1" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-bold tabular" style={{ color: "var(--text)" }}>{sym}</span>
          <span className="flex-shrink-0 rounded px-1 py-0.5 text-xs font-bold" style={{ background: "var(--card-hover)", color: "var(--text-muted)" }}>{item.exchange ?? "NSE"}</span>
        </div>
        <span className="tabular text-sm font-bold" style={{ color: "var(--text)" }}>{ltp > 0 ? `₹${ltp.toFixed(2)}` : "—"}</span>
      </div>
      <button onClick={e => { e.stopPropagation(); onRemove(); }}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:opacity-70"
        style={{ background: "var(--card-hover)", color: "var(--text-faint)" }}>✕</button>
    </div>
  );
}
