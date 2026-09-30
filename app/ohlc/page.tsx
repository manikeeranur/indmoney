"use client";

// ─── OHLC CSV download tab ──────────────────────────────────────────────────────
// Ported from frontend/app/options/page.tsx's OhlcTab (~7616-8300): same grid
// layout (TIME | CE | STRIKE | PE | TIME), same top-opening-price banner, same
// click-to-select CE/PE cells, same CSV format/filename via
// lib/telegram/candleCsv.ts (verified byte-identical against the old backend
// earlier in this migration). Colors now route through the shared CSS
// variables so this tab follows the light/dark toggle like the rest of the
// app — the original relies on globals.css's [data-theme] class overrides for
// the same effect, since OhlcTab itself has no isDark branches either.
import { useEffect, useMemo, useState } from "react";
import { MIN_PREMIUM, MAX_PREMIUM } from "@/lib/strategies/constants";

const MONO = { fontFamily: "'Inter', sans-serif" } as const;
const BEBAS = { fontFamily: "'Inter', sans-serif" } as const;
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DAYS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

type HistRow = { strike: number; isATM: boolean; ce: { token: number | null; open: number | null }; pe: { token: number | null; open: number | null } };

function getTradingDays(n: number): string[] {
  const days: string[] = [];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  while (days.length < n) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() - 1);
  }
  return days;
}
function fmtTradingDay(iso: string): string {
  const [y, mo, dd] = iso.split("-").map(Number);
  const day = new Date(y, mo - 1, dd).getDay();
  return `${String(dd).padStart(2, "0")} ${MONTHS[mo - 1]} ${y}  ·  ${DAYS[day]}`;
}

export default function OhlcPage() {
  const [expiry, setExpiry] = useState("");
  const [ohlcDate, setOhlcDate] = useState(getTradingDays(30)[0]);
  const [ohlcCE, setOhlcCE] = useState<{ token: number; strike: number } | null>(null);
  const [ohlcPE, setOhlcPE] = useState<{ token: number; strike: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [histData, setHistData] = useState<{ spot: number; atm: number; rows: HistRow[] } | null>(null);
  const [loadingHist, setLoadingHist] = useState(false);

  const tradingDays = useMemo(() => getTradingDays(30), []);

  useEffect(() => { fetch("/api/expiries").then(r => r.json()).then(d => setExpiry(d.expiries?.[0] ?? "")); }, []);

  const inRange = (p: number | null | undefined) => p != null && p >= MIN_PREMIUM && p <= MAX_PREMIUM;

  useEffect(() => {
    if (!ohlcDate || !expiry) return;
    setHistData(null); setOhlcCE(null); setOhlcPE(null); setLoadingHist(true);
    fetch(`/api/historical-open-prices?date=${ohlcDate}&expiry=${expiry}`)
      .then(r => r.json())
      .then((d: any) => {
        if (d.error) throw new Error(d.error);
        setHistData(d);
        const bCE = d.rows.filter((r: HistRow) => inRange(r.ce.open)).sort((a: HistRow, b: HistRow) => (b.ce.open ?? 0) - (a.ce.open ?? 0))[0];
        const bPE = d.rows.filter((r: HistRow) => inRange(r.pe.open)).sort((a: HistRow, b: HistRow) => (b.pe.open ?? 0) - (a.pe.open ?? 0))[0];
        if (bCE?.ce.token) setOhlcCE({ token: bCE.ce.token, strike: bCE.strike });
        if (bPE?.pe.token) setOhlcPE({ token: bPE.pe.token, strike: bPE.strike });
      })
      .catch(() => {})
      .finally(() => setLoadingHist(false));
  }, [ohlcDate, expiry]);

  const displayRows = histData?.rows ?? [];
  const bestCERow = displayRows.filter(r => inRange(r.ce.open)).sort((a, b) => (b.ce.open ?? 0) - (a.ce.open ?? 0))[0];
  const bestPERow = displayRows.filter(r => inRange(r.pe.open)).sort((a, b) => (b.pe.open ?? 0) - (a.pe.open ?? 0))[0];
  const hasPrices = displayRows.some(r => r.ce.open != null || r.pe.open != null);

  function symbol(strike: number, type: "CE" | "PE") {
    const exp = new Date(expiry);
    const ddmmmyy = `${String(exp.getUTCDate()).padStart(2, "0")}${MONTHS[exp.getUTCMonth()]}${String(exp.getUTCFullYear()).slice(-2)}`;
    return `NIFTY${ddmmmyy}${strike}${type}`;
  }

  async function downloadOne(token: number, strike: number, type: "CE" | "PE") {
    const d = await fetch(`/api/candles?token=${token}&date=${ohlcDate}&interval=1minute`).then(r => r.json());
    const filename = `${ohlcDate}_${symbol(strike, type)}.csv`;
    const header = "Date,Open,High,Low,Close,Volume,OI,RSI(14)\n";
    const body = (d.rows ?? []).map((r: any) => `${r.date},${r.open},${r.high},${r.low},${r.close},${r.volume},${r.oi ?? ""},${r.rsi14 ?? ""}`).join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDownload() {
    if (!ohlcCE && !ohlcPE) { alert("Select at least one CE or PE"); return; }
    setBusy(true);
    try {
      if (ohlcCE) await downloadOne(ohlcCE.token, ohlcCE.strike, "CE");
      if (ohlcPE) await downloadOne(ohlcPE.token, ohlcPE.strike, "PE");
    } catch (e: any) { alert("Download failed: " + e.message); }
    finally { setBusy(false); }
  }

  const GRID = "56px 1fr 90px 1fr 56px";

  function TimeCorner({ side }: { side: "CE" | "PE" }) {
    return (
      <div className="flex flex-col items-center justify-center gap-0.5 py-2" style={{ background: side === "CE" ? "var(--ce-tint)" : "var(--pe-tint)" }}>
        <div className="text-xs font-bold tracking-[0.5px]" style={{ ...MONO, color: side === "CE" ? "#0284c7" : "#e11d48" }}>{side}</div>
        <div className="text-xs font-bold" style={{ ...MONO, color: "var(--text-muted)" }}>9:15</div>
        <div className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>AM</div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto px-4 pb-8 pt-6">
      <div className="w-full max-w-[680px] space-y-4">
        {/* Header card */}
        <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          <div className="border-b px-4 py-3 sm:px-5" style={{ borderColor: "var(--border)", background: "var(--accent-soft)" }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <div className="rounded border px-2 py-1.5" style={{ background: "rgba(22,163,74,0.1)", borderColor: "rgba(22,163,74,0.3)" }}>
                  <div className="mb-0.5 text-xs uppercase leading-none tracking-[1px]" style={{ ...MONO, color: "rgba(22,163,74,0.7)" }}>OPEN</div>
                  <div className="text-sm font-bold leading-none sm:text-base" style={{ ...MONO, color: "#16a34a" }}>9:15 AM</div>
                </div>
              </div>
              <div className="min-w-0 text-center">
                <div className="text-base tracking-[2px] sm:text-base" style={{ ...BEBAS, color: "#0284c7" }}>OHLC CSV DOWNLOAD</div>
                <div className="truncate text-xs sm:text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>
                  {histData ? `ATM ${histData.atm} · ${displayRows.length} strikes` : `${displayRows.length} strikes`} · OHLCV+OI+RSI
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <div className="rounded border px-2 py-1.5" style={{ background: "rgba(225,29,72,0.1)", borderColor: "rgba(225,29,72,0.3)" }}>
                  <div className="mb-0.5 text-xs uppercase leading-none tracking-[1px]" style={{ ...MONO, color: "rgba(225,29,72,0.7)" }}>CLOSE</div>
                  <div className="text-sm font-bold leading-none sm:text-base" style={{ ...MONO, color: "#e11d48" }}>3:30 PM</div>
                </div>
              </div>
            </div>
          </div>

          <div className="px-5 py-3">
            <div className="mb-2 text-xs uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-muted)" }}>Select Date — Last 30 Trading Days</div>
            <select value={ohlcDate} onChange={e => setOhlcDate(e.target.value)} className="h-9 w-full rounded border px-2 text-sm" style={{ ...MONO, borderColor: "var(--border)", background: "var(--bg)", color: "var(--text)" }}>
              {tradingDays.map(d => <option key={d} value={d}>{fmtTradingDay(d)}</option>)}
            </select>
          </div>
        </div>

        {/* Top opening price banner */}
        {hasPrices && (
          <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
            <div className="border-b px-4 py-2" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <div className="text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "#475569" }}>
                ★ TOP OPENING PRICE · {fmtTradingDay(ohlcDate)} · ₹{MIN_PREMIUM}–₹{MAX_PREMIUM} SCAN RANGE
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr]">
              <div className={`px-5 py-3 ${bestCERow ? "" : "opacity-40"}`}>
                <div className="mb-1 text-xs uppercase tracking-[1px]" style={{ ...MONO, color: "var(--text-faint)" }}>CE · Best Opening</div>
                {bestCERow ? (
                  <>
                    <div className="text-lg font-bold" style={{ ...MONO, color: "#0284c7" }}>{bestCERow.strike} CE</div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <span className="text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>9:15 AM</span>
                      <span className="text-base font-bold" style={{ ...MONO, color: "#16a34a" }}>₹{bestCERow.ce.open}</span>
                      <span className="text-xs font-bold" style={{ ...MONO, color: "#16a34a" }}>★ BEST</span>
                    </div>
                  </>
                ) : <div className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>No CE in ₹{MIN_PREMIUM}–₹{MAX_PREMIUM} range</div>}
              </div>
              <div className="my-2 w-px" style={{ background: "var(--border)" }} />
              <div className={`px-5 py-3 text-right ${bestPERow ? "" : "opacity-40"}`}>
                <div className="mb-1 text-xs uppercase tracking-[1px]" style={{ ...MONO, color: "var(--text-faint)" }}>PE · Best Opening</div>
                {bestPERow ? (
                  <>
                    <div className="text-lg font-bold" style={{ ...MONO, color: "#e11d48" }}>{bestPERow.strike} PE</div>
                    <div className="mt-0.5 flex items-baseline justify-end gap-2">
                      <span className="text-xs font-bold" style={{ ...MONO, color: "#16a34a" }}>★ BEST</span>
                      <span className="text-base font-bold" style={{ ...MONO, color: "#16a34a" }}>₹{bestPERow.pe.open}</span>
                      <span className="text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>9:15 AM</span>
                    </div>
                  </>
                ) : <div className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>No PE in ₹{MIN_PREMIUM}–₹{MAX_PREMIUM} range</div>}
              </div>
            </div>
          </div>
        )}

        {/* Strike table */}
        <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          <div className="grid border-b" style={{ gridTemplateColumns: GRID, borderColor: "var(--border)", background: "var(--card)" }}>
            <div className="border-r py-2 text-center text-xs font-bold uppercase tracking-[1px]" style={{ ...MONO, color: "#0284c7", borderColor: "var(--border)", background: "var(--ce-tint)" }}>TIME</div>
            <div className="px-3 py-2 text-right text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "#0284c7" }}>CE · 9:15 AM OPENING</div>
            <div className="border-x py-2 text-center text-xs uppercase tracking-[1.5px]" style={{ ...MONO, color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--card-hover)" }}>STRIKE</div>
            <div className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: "#e11d48" }}>PE · 9:15 AM OPENING</div>
            <div className="border-l py-2 text-center text-xs font-bold uppercase tracking-[1px]" style={{ ...MONO, color: "#e11d48", borderColor: "var(--border)", background: "var(--pe-tint)" }}>TIME</div>
          </div>

          {loadingHist && (
            <div className="flex items-center justify-center gap-2 border-b py-6" style={{ borderColor: "var(--border)" }}>
              <div className="h-4 w-4 animate-spin rounded-full border-2" style={{ borderColor: "rgba(2,132,199,0.2)", borderTopColor: "#0284c7" }} />
              <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>Loading {fmtTradingDay(ohlcDate)} historical strikes…</span>
            </div>
          )}

          <div className="max-h-[400px] divide-y overflow-y-auto" style={{ borderColor: "var(--border)" }}>
            {displayRows.map(r => {
              const ceP = r.ce.open, peP = r.pe.open;
              const ceOk = inRange(ceP), peOk = inRange(peP);
              const ceSel = ohlcCE?.token === r.ce.token, peSel = ohlcPE?.token === r.pe.token;
              const isBestCE = bestCERow?.strike === r.strike, isBestPE = bestPERow?.strike === r.strike;
              return (
                <div key={r.strike} className="grid" style={{ gridTemplateColumns: GRID, background: r.isATM ? "var(--accent-soft)" : "transparent" }}>
                  <TimeCorner side="CE" />
                  <button
                    onClick={() => r.ce.token && setOhlcCE(ceSel ? null : { token: r.ce.token, strike: r.strike })}
                    disabled={!r.ce.token}
                    className="border-r px-4 py-3 text-right transition-colors"
                    style={{ borderColor: "var(--border)", background: ceSel ? "rgba(2,132,199,0.1)" : "transparent" }}
                  >
                    {ceP != null ? (
                      <div>
                        <div className="text-base font-bold tabular-nums leading-tight" style={{ ...MONO, color: ceSel ? "#0284c7" : ceOk ? "#16a34a" : "var(--text-faint)" }}>{ceSel ? "✓ " : ""}₹{ceP}</div>
                        <div className="mt-0.5 text-xs font-semibold" style={MONO}>
                          {ceSel ? <span style={{ color: "#0284c7" }}>SELECTED</span> : isBestCE ? <span style={{ color: "#16a34a" }}>★ BEST</span> : ceOk ? <span style={{ color: "#16a34a" }}>✓ IN RANGE</span> : <span style={{ color: "#4a6080" }}>{r.strike} CE</span>}
                        </div>
                      </div>
                    ) : <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{loadingHist ? "…" : "—"}</span>}
                  </button>
                  <div className="flex flex-col items-center justify-center border-x py-3" style={{ borderColor: "var(--border)", background: r.isATM ? "var(--card-hover)" : "var(--card)" }}>
                    <div className="text-sm font-bold tabular-nums leading-none" style={{ ...MONO, color: r.isATM ? "#0284c7" : "var(--text)" }}>{r.strike}</div>
                    {r.isATM && <div className="mt-0.5 text-xs font-bold tracking-[1px]" style={{ ...MONO, color: "rgba(2,132,199,0.6)" }}>ATM</div>}
                  </div>
                  <button
                    onClick={() => r.pe.token && setOhlcPE(peSel ? null : { token: r.pe.token, strike: r.strike })}
                    disabled={!r.pe.token}
                    className="border-l px-4 py-3 text-left transition-colors"
                    style={{ borderColor: "var(--border)", background: peSel ? "rgba(225,29,72,0.1)" : "transparent" }}
                  >
                    {peP != null ? (
                      <div>
                        <div className="text-base font-bold tabular-nums leading-tight" style={{ ...MONO, color: peSel ? "#e11d48" : peOk ? "#16a34a" : "var(--text-faint)" }}>{peSel ? "✓ " : ""}₹{peP}</div>
                        <div className="mt-0.5 text-xs font-semibold" style={MONO}>
                          {peSel ? <span style={{ color: "#e11d48" }}>SELECTED</span> : isBestPE ? <span style={{ color: "#16a34a" }}>★ BEST</span> : peOk ? <span style={{ color: "#16a34a" }}>✓ IN RANGE</span> : <span style={{ color: "#4a6080" }}>{r.strike} PE</span>}
                        </div>
                      </div>
                    ) : <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{loadingHist ? "…" : "—"}</span>}
                  </button>
                  <TimeCorner side="PE" />
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t px-4 py-2" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
            <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>{displayRows.length} strikes · Green = ₹{MIN_PREMIUM}–₹{MAX_PREMIUM} · ★ = best opening price · Click to select/deselect</span>
            {loadingHist && (
              <div className="flex items-center gap-1">
                <div className="h-2.5 w-2.5 animate-spin rounded-full border" style={{ borderColor: "rgba(2,132,199,0.3)", borderTopColor: "#0284c7" }} />
                <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>fetching historical prices…</span>
              </div>
            )}
          </div>
        </div>

        {/* Selected files preview */}
        {(ohlcCE || ohlcPE) && (
          <div className="grid grid-cols-2 gap-3">
            {ohlcCE ? (
              <div className="rounded-md border px-4 py-2.5" style={{ borderColor: "rgba(2,132,199,0.3)", background: "rgba(2,132,199,0.05)" }}>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-[1px]" style={{ ...MONO, color: "#0284c7" }}>CE FILE</span>
                  <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>9:15 AM → 3:30 PM</span>
                </div>
                <div className="truncate text-xs font-bold" style={{ ...MONO, color: "#0284c7" }}>{ohlcDate}_{symbol(ohlcCE.strike, "CE")}.csv</div>
                <div className="mt-0.5 text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>Open ₹{displayRows.find(r => r.ce.token === ohlcCE.token)?.ce.open ?? "—"} · Minute candles</div>
              </div>
            ) : <div />}
            {ohlcPE ? (
              <div className="rounded-md border px-4 py-2.5" style={{ borderColor: "rgba(225,29,72,0.3)", background: "rgba(225,29,72,0.05)" }}>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-xs font-bold uppercase tracking-[1px]" style={{ ...MONO, color: "#e11d48" }}>PE FILE</span>
                  <span className="text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>9:15 AM → 3:30 PM</span>
                </div>
                <div className="truncate text-xs font-bold" style={{ ...MONO, color: "#e11d48" }}>{ohlcDate}_{symbol(ohlcPE.strike, "PE")}.csv</div>
                <div className="mt-0.5 text-xs" style={{ ...MONO, color: "var(--text-muted)" }}>Open ₹{displayRows.find(r => r.pe.token === ohlcPE.token)?.pe.open ?? "—"} · Minute candles</div>
              </div>
            ) : <div />}
          </div>
        )}

        {/* Download */}
        <button
          onClick={handleDownload}
          disabled={busy || (!ohlcCE && !ohlcPE)}
          className="w-full cursor-pointer rounded-md py-3.5 text-sm font-bold tracking-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{ ...MONO, background: busy ? "rgba(2,132,199,0.15)" : "rgba(2,132,199,0.1)", border: "1.5px solid #0284c7", color: "#0284c7" }}
        >
          {busy ? "DOWNLOADING…" : "↓  DOWNLOAD CSV  (9:15 AM – 3:30 PM)"}
        </button>

        <div className="text-center text-xs" style={{ ...MONO, color: "var(--text-faint)" }}>
          Each selected leg → 1 CSV file · Full day minute candles · OHLCV + OI + RSI(14)
        </div>
      </div>
    </div>
  );
}
