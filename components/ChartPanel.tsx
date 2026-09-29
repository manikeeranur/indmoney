"use client";

// ─── Chart panel ────────────────────────────────────────────────────────────────
// Full port of frontend/components/TradingChartModal.tsx: the simple/area
// default view (price + change + Open/Low/High/Prev-Close, period buttons)
// with a "Tech Chart" button into the full technical view (TF dropdown
// 1m-1W, chart type incl. Heikin-Ashi, RSI/BB/VOL/VWAP indicators computed
// client-side exactly like the original, drag-resizable RSI pane, chart
// nav — scroll/zoom/fit-today, replay mode with speed control, PNG
// screenshot export, live position card with one-tap exit, and the
// buy/sell order footer with wallet check, lot stepper and trade-line
// overlays (auto for an open position, or right after a manual order).
//
// SCOPE CUT, stated plainly: the original's equity/index chart modes
// (isEquity/isIndex, 5x-margin equity charges, the IndexSwiper "open option
// chain" shortcut) are not ported — INDMONEY only ever charts a NIFTY/SENSEX
// option leg, so that whole code path is unreachable here, not simplified.
// Lot size uses the same LOT_SIZE/SENSEX_LOT_SIZE fallback constants the
// rest of the app falls back to when a live lookup isn't in scope (see
// lib/strategies/constants.ts's own header note on why that's safe).
import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries, AreaSeries, HistogramSeries } from "lightweight-charts";
import { IconX, IconChevronLeft, IconChartBar, IconCamera, IconCheck } from "@tabler/icons-react";
import { subscribeTokens } from "@/lib/useLiveSocket";
import { useLtp } from "@/lib/store/chainStore";
import { useTheme } from "@/lib/theme";
import { useAccountQty } from "@/lib/useAccountQty";
import { NUM_LOTS, LOT_SIZE, SENSEX_LOT_SIZE } from "@/lib/strategies/constants";

const MONO = { fontFamily: "'Space Mono', monospace" } as const;

type TfLabel = "1m" | "3m" | "5m" | "10m" | "15m" | "1h" | "4h" | "1D" | "1W";
type ChartType = "candle" | "ha" | "line" | "area";
type Indicator = "RSI" | "BB" | "VOL" | "VWAP";
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type PatternZone = { concept: string; top: number; bottom: number; fromTime: number; toTime: number };
export type ChartTarget = { token: number; tradingsymbol: string; strike: number; type: "CE" | "PE"; expiry: string; index?: "NIFTY" | "SENSEX"; patternZones?: PatternZone[] };

type TfConfig = { label: TfLabel; interval: string; fromDays: number; aggMinutes: number };
const TF_LIST: TfConfig[] = [
  { label: "1m", interval: "minute", fromDays: 2, aggMinutes: 1 },
  { label: "3m", interval: "minute", fromDays: 2, aggMinutes: 3 },
  { label: "5m", interval: "minute", fromDays: 3, aggMinutes: 5 },
  { label: "10m", interval: "minute", fromDays: 4, aggMinutes: 10 },
  { label: "15m", interval: "minute", fromDays: 5, aggMinutes: 15 },
  { label: "1h", interval: "60minute", fromDays: 20, aggMinutes: 0 },
  { label: "4h", interval: "60minute", fromDays: 45, aggMinutes: 240 },
  { label: "1D", interval: "day", fromDays: 90, aggMinutes: 0 },
  { label: "1W", interval: "day", fromDays: 1825, aggMinutes: 7200 },
];
const SIMPLE_PERIOD_TF: Record<string, TfLabel> = { "1D": "1m", "1W": "1D", "1M": "1D", "3M": "1D", "6M": "1D", "1Y": "1D", "5Y": "1W" };
const SIMPLE_PERIOD_DAYS: Record<string, number> = { "1D": 1, "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "5Y": 1825 };

// ── Pure helpers — verbatim math from the original ──────────────────────────
function istToUnix(s: string): number {
  const [dp, tp] = s.split(" ");
  const [dd, mm, yyyy] = dp.split("-");
  const [hh, mi] = (tp ?? "09:15").split(":");
  return Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi) / 1000;
}
function dateFromDaysAgo(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}
function filterMarketHours(candles: Candle[]): Candle[] {
  const open = 9 * 3600 + 15 * 60, close = 15 * 3600 + 30 * 60;
  return candles.filter(c => { const s = c.time % 86400; return s >= open && s <= close; });
}
function aggregate(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return candles;
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const b = Math.floor(c.time / (minutes * 60)) * (minutes * 60);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(c);
  }
  return Array.from(buckets.entries()).sort(([a], [b]) => a - b).map(([t, cs]) => ({
    time: t, open: cs[0].open, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)),
    close: cs[cs.length - 1].close, volume: cs.reduce((s, c) => s + c.volume, 0),
  }));
}
function toHeikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hc = (c.open + c.high + c.low + c.close) / 4;
    const ho = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: c.time, open: ho, high: Math.max(c.high, ho, hc), low: Math.min(c.low, ho, hc), close: hc, volume: c.volume });
  }
  return out;
}
function computeRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let sg = 0, sl = 0, ag = 0, al = 0, warm = false;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l2 = Math.max(-d, 0);
    if (!warm) {
      sg += g; sl += l2;
      const sag = sg / i, sal = sl / i;
      out[i] = sal === 0 ? 100 : +(100 - 100 / (1 + sag / sal)).toFixed(2);
      if (i >= period) { ag = sg / period; al = sl / period; warm = true; }
    } else {
      ag = (ag * (period - 1) + g) / period;
      al = (al * (period - 1) + l2) / period;
      out[i] = al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2);
    }
  }
  return out;
}
function computeVWAP(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length);
  let cumPV = 0, cumVol = 0, curDay = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Math.floor(c.time / 86400);
    if (day !== curDay) { cumPV = 0; cumVol = 0; curDay = day; }
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    cumPV += typical * vol; cumVol += vol;
    out[i] = +(cumVol > 0 ? cumPV / cumVol : typical).toFixed(2);
  }
  return out;
}
function computeBB(closes: number[], period = 20, mult = 2) {
  return closes.map((_, i) => {
    const p = Math.min(i + 1, period);
    const sl = closes.slice(i - p + 1, i + 1);
    const mid = sl.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
    return { mid: +mid.toFixed(2), up: +(mid + mult * sd).toFixed(2), dn: +(mid - mult * sd).toFixed(2) };
  });
}
function calcRR(entry: number) {
  const risk = +(entry * 0.12).toFixed(2), reward = +(entry * 0.24).toFixed(2);
  return { sl: +(entry - risk).toFixed(2), target1: +(entry + risk).toFixed(2), target2: +(entry + reward).toFixed(2) };
}
function getExpiryStart(expiry: string): string {
  const exp = new Date(expiry + "T00:00:00Z");
  exp.setUTCDate(exp.getUTCDate() - 35);
  const today = new Date();
  return (exp > today ? today : exp).toISOString().split("T")[0];
}

// The EXPIRED-contract historical endpoint needs its own compact symbol
// format — <UNDERLYING><YYMMMDD><STRIKE><CE|PE>, e.g. "NIFTY26SEP2922900PE"
// (2-digit year, 3-letter month, 2-digit day, no separators) — verified
// against api-docs.indstocks.com/utility/. This is NOT the same string the
// live option-chain returns as trading_symbol (that one looks like
// "NIFTY-Aug2026-24450-CE" — hyphenated, full month, 4-digit year), so it
// has to be built fresh from the strike/type/expiry fields already on hand
// rather than reusing the live-chain tradingsymbol prop.
function expiredSymbol(underlying: string, expiry: string, strike: number, type: "CE" | "PE"): string {
  const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const [y, m, d] = expiry.split("-").map(Number);
  return `${underlying}${String(y).slice(2)}${MON[m - 1]}${String(d).padStart(2, "0")}${strike}${type}`;
}

type LivePos = { tradingsymbol: string; buyPrice: number; currentPrice: number; quantity: number; status: string; direction: string | null };

export function ChartPanel({ token, tradingsymbol, strike, type, expiry, index = "NIFTY", patternZones, startInTechnical = false, onClose }: ChartTarget & { startInTechnical?: boolean; onClose: () => void }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const panelBg = isDark ? "#0f172a" : "#ffffff";
  const border = isDark ? "#1e293b" : "#e2e8f0";
  const divider = isDark ? "#1e293b" : "#f1f5f9";
  const btnBg = isDark ? "#1e293b" : "#f1f5f9";
  const btnClr = isDark ? "#94a3b8" : "#475569";
  const txtPrimary = isDark ? "#e2e8f0" : "#1e293b";
  const txtMuted = isDark ? "#64748b" : "#94a3b8";
  const chartBg = isDark ? "#0f172a" : "#ffffff";
  const chartText = isDark ? "#64748b" : "#475569";
  const chartGrid = isDark ? "#1e293b" : "#f1f5f9";
  const chartBdr = isDark ? "#1e293b" : "#e2e8f0";

  const isCE = type === "CE";
  const clr = isCE ? "#0284c7" : "#dc2626";
  const activeLotSize = index === "SENSEX" ? SENSEX_LOT_SIZE : LOT_SIZE;
  const fmtExpiry = (exp: string) => {
    const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const parts = exp?.split("-");
    return parts?.length === 3 ? `${parseInt(parts[2])} ${MONTHS[parseInt(parts[1]) - 1]}` : exp;
  };
  const chartLabel = `${index} ${fmtExpiry(expiry)} ${strike} ${type}`;

  const [tf, setTf] = useState<TfLabel>(startInTechnical ? "5m" : "1m");
  const [chartType, setCT] = useState<ChartType>(startInTechnical ? "candle" : "area");
  const [simpleMode, setSimpleMode] = useState(!startInTechnical);
  const [simplePeriod, setSimplePeriod] = useState("1D");
  const [todayStats, setTodayStats] = useState<{ open: number; high: number; low: number } | null>(null);
  const [derivedPrevClose, setDerivedPrevClose] = useState<number | null>(null);
  const [indicators, setInd] = useState<Set<Indicator>>(new Set<Indicator>(startInTechnical ? ["VWAP"] : []));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ohlc, setOhlc] = useState<{ o: number; h: number; l: number; c: number; v: number } | null>(null);
  const [wallet, setWallet] = useState<number | null>(null);
  const [orderState, setOS] = useState<{ loading: boolean; result: string | null }>({ loading: false, result: null });
  const [tradeLines, setTL] = useState<{ entry: number; target: number; target2?: number; sl: number; entryTime: string } | null>(null);
  const [exitState, setExitState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [acctLivePos, setAcctLivePos] = useState<LivePos | null>(null);
  const acctQty = useAccountQty(NUM_LOTS);
  const [orderLots, setOL] = useState(NUM_LOTS);
  const orderLotsInitRef = useRef(false);
  useEffect(() => { if (!orderLotsInitRef.current) { orderLotsInitRef.current = true; setOL(acctQty); } }, [acctQty]);
  const [tradeOpen, setTO] = useState(false);
  const [indOpen, setIndOpen] = useState(false);
  const [tfOpen, setTfOpen] = useState(false);
  const [ctOpen, setCtOpen] = useState(false);
  const [shotFlash, setShotFlash] = useState(false);
  const [rsiHeight, setRsiHeight] = useState(80);
  const rsiHeightRef = useRef(80);
  const rsiDragRef = useRef<{ startY: number; startH: number } | null>(null);
  // Separate refs per dropdown — a single shared ref only ever points at the
  // LAST of the three mounted wrapper divs (Indicators, since it renders
  // last), so clicks inside the Duration/Chart Type dropdowns registered as
  // "outside" and closed themselves before the click on an option could land.
  const tfDropRef = useRef<HTMLDivElement>(null);
  const ctDropRef = useRef<HTMLDivElement>(null);
  const indDropRef = useRef<HTMLDivElement>(null);

  const [replayMode, setReplayMode] = useState(false);
  const [replayPicking, setReplayPicking] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayIdx, setReplayIdx] = useState(0);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const replayCandlesRef = useRef<Candle[]>([]);
  const replayIdxRef = useRef(0);
  const replayPlayingRef = useRef(false);
  const replayPickingRef = useRef(false);
  const replayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const chartDivRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<Record<string, any>>({});
  const rawRef = useRef<Candle[]>([]);
  // Pixel rects for the SMC concept(s) that fired this entry — a bounded box
  // in BOTH price and time (unlike the entry/SL/target lines, which are
  // full-width), so it actually shows the order block / FVG / liquidity
  // sweep candle range, not just a price level. Recomputed every animation
  // frame while a chart with pattern data is open, same technique as the
  // price-line sync elsewhere, so it tracks panning/zooming/resizing.
  const [zoneRects, setZoneRects] = useState<{ concept: string; left: number; right: number; top: number; bottom: number }[]>([]);
  const currentRef = useRef<Candle | null>(null);
  const tfMinRef = useRef(1);
  const ctRef = useRef<ChartType>("candle");
  const indRef = useRef<Set<Indicator>>(new Set<Indicator>(startInTechnical ? ["VWAP"] : []));
  const tlDataRef = useRef<typeof tradeLines>(null);
  const tlSeriesRef = useRef<{ ep: any; tp: any; t2: any; sp: any } | null>(null);

  const tfCfg = TF_LIST.find(t => t.label === tf)!;

  // Close dropdowns on outside click
  useEffect(() => {
    if (!indOpen && !tfOpen && !ctOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tfDropRef.current && !tfDropRef.current.contains(t)) setTfOpen(false);
      if (ctDropRef.current && !ctDropRef.current.contains(t)) setCtOpen(false);
      if (indDropRef.current && !indDropRef.current.contains(t)) setIndOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [indOpen, tfOpen, ctOpen]);

  // RSI pane drag-to-resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rsiDragRef.current) return;
      const delta = rsiDragRef.current.startY - e.clientY;
      const newH = Math.max(40, Math.min(300, rsiDragRef.current.startH + delta));
      rsiHeightRef.current = newH; setRsiHeight(newH);
      try { if (seriesRef.current.rsiPane) seriesRef.current.rsiPane.setHeight(newH); seriesRef.current.rsi?.applyOptions({ visible: true }); } catch {}
    };
    const onUp = () => { rsiDragRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  // Compute today/prevClose stats for simple view
  useEffect(() => {
    if (loading || !rawRef.current.length) return;
    const candles = rawRef.current;
    const lastD = new Date(candles[candles.length - 1].time * 1000);
    const lastDayStart = Date.UTC(lastD.getUTCFullYear(), lastD.getUTCMonth(), lastD.getUTCDate()) / 1000;
    const dayCandles = candles.filter(c => c.time >= lastDayStart);
    const prevCandles = candles.filter(c => c.time < lastDayStart);
    if (dayCandles.length) setTodayStats({ open: dayCandles[0].open, high: Math.max(...dayCandles.map(c => c.high)), low: Math.min(...dayCandles.map(c => c.low)) });
    if (prevCandles.length) setDerivedPrevClose(prevCandles[prevCandles.length - 1].close);
  }, [loading]);

  useEffect(() => () => { if (replayTimerRef.current) clearInterval(replayTimerRef.current); }, []);
  useEffect(() => {
    if (!replayPlayingRef.current) return;
    if (replayTimerRef.current) { clearInterval(replayTimerRef.current); replayTimerRef.current = null; }
    const delay = Math.round(400 / replaySpeed);
    replayTimerRef.current = setInterval(() => {
      const next = replayIdxRef.current + 1;
      if (next >= replayCandlesRef.current.length) { clearInterval(replayTimerRef.current!); replayTimerRef.current = null; replayPlayingRef.current = false; setReplayPlaying(false); return; }
      replayIdxRef.current = next; setReplayIdx(next);
      applyReplayData(replayCandlesRef.current.slice(0, next + 1));
    }, delay);
    return () => { if (replayTimerRef.current) { clearInterval(replayTimerRef.current); replayTimerRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaySpeed]);

  // Fetch wallet
  useEffect(() => { fetch("/api/account").then(r => r.json()).then(d => setWallet(d.wallet?.available ?? null)).catch(() => {}); }, []);

  // Poll live position for THIS tradingsymbol every 2s
  useEffect(() => {
    let active = true;
    const tick = () => fetch("/api/account/positions").then(r => r.json()).then(d => {
      if (!active) return;
      const pos = (d.positions ?? []).find((p: any) => p.tradingsymbol === tradingsymbol && p.status === "OPEN");
      setAcctLivePos(pos ?? null);
    }).catch(() => {});
    tick();
    const id = setInterval(tick, 2000);
    return () => { active = false; clearInterval(id); };
  }, [tradingsymbol]);

  // Fetch candles when token/tf changes
  useEffect(() => {
    setLoading(true); setError(null);
    rawRef.current = []; currentRef.current = null;
    // .toISOString() always renders in UTC no matter how the Date was built
    // — using it to read off "today's date" is wrong by a full day for any
    // IST time before 05:30 (UTC+5:30 means that window falls on the
    // PREVIOUS UTC calendar date). toLocaleDateString with an explicit
    // timeZone is the correct way to get the real IST calendar date.
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const mapRows = (d: any): Candle[] => (d.rows ?? []).map((r: any) => ({ time: istToUnix(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }));
    const from = tfCfg.interval === "day" ? dateFromDaysAgo(tfCfg.fromDays) : getExpiryStart(expiry);
    // Options stop appearing on the regular historical-candle endpoint the
    // moment they stop TRADING — 15:30 IST on expiry day itself, not
    // midnight. Comparing calendar dates alone (expiry < today) missed the
    // exact case this was built for: viewing a chart at, say, 23:00 on the
    // SAME calendar day as expiry — the date compare says "not expired yet"
    // (they're equal) while the contract has been closed for hours, so it
    // silently took the normal (empty) path again. Needs the current IST
    // clock time too, not just the date.
    const isExpired = expiry < today || (expiry === today && (nowIST.getHours() > 15 || (nowIST.getHours() === 15 && nowIST.getMinutes() >= 30)));
    const params = isExpired
      ? `expired=true&tradingsymbol=${encodeURIComponent(expiredSymbol(index, expiry, strike, type))}&from=${from}&to=${expiry}&interval=${tfCfg.interval}&skipIndicators=true&index=${index}`
      : `token=${token}&from=${from}&to=${today}&interval=${tfCfg.interval}&skipIndicators=true&index=${index}`;
    fetch(`/api/candles?${params}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); const candles = mapRows(d); rawRef.current = tfCfg.interval === "day" ? candles : filterMarketHours(candles); setLoading(false); })
      .catch((e: any) => { setError(e?.message ?? "Failed to load"); setLoading(false); });
  }, [token, tf, expiry, strike, type, index]);

  // Build/rebuild chart
  useEffect(() => {
    if (!chartDivRef.current || loading || rawRef.current.length === 0) return;
    const aggMin = tfCfg.aggMinutes;
    const candles = aggMin > 1 ? aggregate(rawRef.current, aggMin) : rawRef.current;
    tfMinRef.current = aggMin > 1 ? aggMin : (tfCfg.interval === "60minute" ? 60 : tfCfg.interval === "day" ? 1440 : 1);
    ctRef.current = chartType;

    const closes = candles.map(c => c.close);
    const rsiArr = computeRSI(closes);
    const bbArr = computeBB(closes);
    const vwapArr = computeVWAP(candles);

    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; seriesRef.current = {}; tlSeriesRef.current = null; }

    const chart = createChart(chartDivRef.current, {
      layout: { background: { color: chartBg }, textColor: chartText, fontFamily: "'Space Mono', monospace", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: chartGrid, visible: !simpleMode }, horzLines: { color: chartGrid, visible: !simpleMode } },
      crosshair: { mode: 1 },
      localization: {
        timeFormatter: (ts: number) => {
          const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
          const d = new Date(ts * 1000);
          const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, "0");
          const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
          if (h === 0 && m === "00") return base;
          return `${base} ${h % 12 || 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
        },
        priceFormatter: (p: number) => p.toFixed(2),
      },
      timeScale: {
        timeVisible: true, secondsVisible: false, borderColor: chartBdr,
        tickMarkFormatter: (ts: number, tickType: number) => {
          const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const d = new Date(ts * 1000);
          if (tickType === 0) return String(d.getUTCFullYear());
          if (tickType === 1) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
          if (tickType === 2) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
          const h = d.getUTCHours();
          return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
        },
      },
      rightPriceScale: { borderColor: chartBdr, scaleMargins: { top: 0.06, bottom: simpleMode ? 0 : 0.06 }, minimumWidth: 0 },
      handleScroll: simpleMode ? { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false } : true,
      handleScale: simpleMode ? { mouseWheel: false, pinch: false, axisPressedMouseMove: false, axisDoubleClickReset: false } : true,
      autoSize: true,
    } as any);
    chartRef.current = chart;
    const s = seriesRef.current;
    const ind = indRef.current;

    if (chartType === "candle" || chartType === "ha") {
      s.main = chart.addSeries(CandlestickSeries, { upColor: "#16a34a", downColor: "#dc2626", borderUpColor: "#16a34a", borderDownColor: "#dc2626", wickUpColor: "#16a34a", wickDownColor: "#dc2626" } as any, 0);
    } else if (chartType === "area") {
      s.main = chart.addSeries(AreaSeries, { lineColor: clr, topColor: `${clr}55`, bottomColor: `${clr}05`, lineWidth: 2, lastValueVisible: true, priceLineVisible: false } as any, 0);
    } else {
      s.main = chart.addSeries(LineSeries, { color: clr, lineWidth: 1.5, lastValueVisible: true, priceLineVisible: false } as any, 0);
    }

    const bbBase = { lineWidth: 1, lastValueVisible: false, priceLineVisible: false, visible: ind.has("BB"), autoscaleInfoProvider: () => null };
    s.bbUp = chart.addSeries(LineSeries, { ...bbBase, color: "#16a34a" } as any, 0);
    s.bbMid = chart.addSeries(LineSeries, { ...bbBase, color: "#3b82f6" } as any, 0);
    s.bbDn = chart.addSeries(LineSeries, { ...bbBase, color: "#dc2626" } as any, 0);
    s.vwap = chart.addSeries(LineSeries, { color: "#a855f7", lineWidth: 2, lineStyle: 2, lastValueVisible: ind.has("VWAP"), priceLineVisible: false, visible: ind.has("VWAP") } as any, 0);
    s.vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false } as any, 0);
    try { chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false }); } catch {}
    if (!ind.has("VOL")) s.vol.setData([]);

    s.rsi = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1.5, lastValueVisible: true, priceLineVisible: false, priceFormat: { type: "custom", formatter: (v: number) => v.toFixed(1) }, visible: ind.has("RSI") } as any, 1);
    const allPanes = (chart as any).panes?.() ?? [];
    s.rsiPane = allPanes[1] ?? null;
    if (s.rsiPane) s.rsiPane.setHeight(ind.has("RSI") ? rsiHeightRef.current : 0);
    if (ind.has("RSI") && s.rsi) {
      try {
        s.rsiL70 = s.rsi.createPriceLine({ price: 70, color: "rgba(220,38,38,0.7)", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "70" });
        s.rsiL30 = s.rsi.createPriceLine({ price: 30, color: "rgba(22,163,74,0.7)", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "30" });
      } catch {}
    }

    const t = (c: Candle) => c.time as any;
    if (chartType === "candle") s.main.setData(candles.map(c => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
    else if (chartType === "ha") s.main.setData(toHeikinAshi(candles).map(c => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
    else s.main.setData(candles.map(c => ({ time: t(c), value: c.close })));
    const bbV = candles.map((c, i) => ({ c, bb: bbArr[i] })).filter(x => x.bb.mid != null);
    s.bbUp.setData(bbV.map(x => ({ time: t(x.c), value: x.bb.up! })));
    s.bbMid.setData(bbV.map(x => ({ time: t(x.c), value: x.bb.mid! })));
    s.bbDn.setData(bbV.map(x => ({ time: t(x.c), value: x.bb.dn! })));
    s.vwap.setData(candles.map((c, i) => ({ time: t(c), value: vwapArr[i] })));
    if (ind.has("VOL")) s.vol.setData(candles.map(c => ({ time: t(c), value: c.volume, color: c.close >= c.open ? "rgba(22,163,74,0.4)" : "rgba(220,38,38,0.4)" })));
    const rsiV = candles.map((c, i) => ({ c, rsi: rsiArr[i] })).filter(x => x.rsi != null);
    s.rsi.setData(rsiV.map(x => ({ time: t(x.c), value: x.rsi! })));

    if (simpleMode && candles.length > 0) {
      const lastD = new Date(candles[candles.length - 1].time * 1000);
      const lastDayStart = Date.UTC(lastD.getUTCFullYear(), lastD.getUTCMonth(), lastD.getUTCDate()) / 1000;
      const fi = candles.findIndex(c => c.time >= lastDayStart);
      try { chart.timeScale().applyOptions({ rightOffset: 0 }); } catch {}
      chart.timeScale().setVisibleLogicalRange({ from: fi >= 0 ? fi : 0, to: candles.length - 1 });
    } else if ((tfCfg.interval === "minute" || tfCfg.interval === "60minute") && candles.length > 0) {
      const lastTime = candles[candles.length - 1].time;
      const lastDayStart = Math.floor(lastTime / 86400) * 86400;
      const todayOpen = lastDayStart + 9 * 3600 + 15 * 60;
      const firstIdx = candles.findIndex(c => c.time >= todayOpen);
      const startIdx = firstIdx >= 0 ? firstIdx : candles.length - 1;
      const barsPerDay = aggMin > 1 ? Math.ceil(375 / aggMin) : tfCfg.interval === "60minute" ? 7 : 375;
      chart.timeScale().setVisibleLogicalRange({ from: startIdx > 0 ? startIdx - 0.5 : 0, to: startIdx + barsPerDay + 5 });
    } else {
      chart.timeScale().fitContent();
    }

    const lastCandle = candles[candles.length - 1];
    if (lastCandle) {
      const lastHa = chartType === "ha" ? toHeikinAshi(candles).at(-1) : null;
      const lc = lastHa ?? lastCandle;
      setOhlc({ o: lc.open, h: lc.high, l: lc.low, c: lc.close, v: lastCandle.volume });
    }

    chart.subscribeCrosshairMove((param: any) => {
      if (!param.time || !param.seriesData?.size) {
        const last = rawRef.current[rawRef.current.length - 1];
        if (last) setOhlc({ o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume });
        return;
      }
      const md = param.seriesData.get(s.main);
      const vd = param.seriesData.get(s.vol);
      if (md) setOhlc({ o: md.open ?? md.value ?? 0, h: md.high ?? md.value ?? 0, l: md.low ?? md.value ?? 0, c: md.close ?? md.value ?? 0, v: vd?.value ?? 0 });
      else setOhlc(null);
    });

    if (tlDataRef.current) { try { tlSeriesRef.current = mkTLs(s.main, tlDataRef.current); } catch {} }

    return () => { chart.remove(); chartRef.current = null; seriesRef.current = {}; };
  }, [loading, tf, chartType, isDark]);

  // Live ticks — shared WS the rest of the app already uses
  useEffect(() => { subscribeTokens([token]); }, [token]);
  const liveLtp = useLtp(token);
  useEffect(() => {
    if (liveLtp == null) return;
    const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
    const nowEnc = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), istNow.getUTCHours(), istNow.getUTCMinutes(), 0) / 1000;
    const tfSec = tfMinRef.current * 60;
    const bucket = Math.floor(nowEnc / tfSec) * tfSec;
    let curr = currentRef.current;
    if (!curr || curr.time !== bucket) {
      const prev = curr?.close ?? rawRef.current[rawRef.current.length - 1]?.close ?? liveLtp;
      curr = { time: bucket, open: prev, high: Math.max(prev, liveLtp), low: Math.min(prev, liveLtp), close: liveLtp, volume: 0 };
    } else {
      curr = { ...curr, high: Math.max(curr.high, liveLtp), low: Math.min(curr.low, liveLtp), close: liveLtp };
    }
    currentRef.current = curr;
    const s = seriesRef.current;
    if (!s.main) return;
    try {
      if (ctRef.current === "candle" || ctRef.current === "ha") s.main.update({ time: bucket as any, open: curr.open, high: curr.high, low: curr.low, close: curr.close });
      else s.main.update({ time: bucket as any, value: curr.close });
    } catch {}
  }, [liveLtp]);

  function toggleInd(ind: Indicator) {
    const next = new Set(indRef.current);
    if (next.has(ind)) next.delete(ind); else next.add(ind);
    indRef.current = next; setInd(new Set(next));
    const on = next.has(ind);
    const s = seriesRef.current;
    if (ind === "BB") { s.bbUp?.applyOptions({ visible: on }); s.bbMid?.applyOptions({ visible: on }); s.bbDn?.applyOptions({ visible: on }); }
    if (ind === "VWAP") s.vwap?.applyOptions({ visible: on, lastValueVisible: on });
    if (ind === "VOL") {
      if (on) {
        const aggMin = tfMinRef.current;
        const candles = aggMin > 1 ? aggregate(rawRef.current, aggMin) : rawRef.current;
        s.vol?.setData(candles.map(c => ({ time: c.time as any, value: c.volume, color: c.close >= c.open ? "rgba(22,163,74,0.4)" : "rgba(220,38,38,0.4)" })));
      } else s.vol?.setData([]);
    }
    if (ind === "RSI") {
      s.rsi?.applyOptions({ visible: on });
      try { if (s.rsiPane) s.rsiPane.setHeight(on ? rsiHeightRef.current : 0); } catch {}
      try {
        if (on && s.rsi) {
          s.rsiL70 = s.rsi.createPriceLine({ price: 70, color: "rgba(220,38,38,0.7)", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "70" });
          s.rsiL30 = s.rsi.createPriceLine({ price: 30, color: "rgba(22,163,74,0.7)", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "30" });
        } else if (!on && s.rsi) {
          if (s.rsiL70) { s.rsi.removePriceLine(s.rsiL70); s.rsiL70 = null; }
          if (s.rsiL30) { s.rsi.removePriceLine(s.rsiL30); s.rsiL30 = null; }
        }
      } catch {}
    }
  }

  function handleSimplePeriod(p: string) {
    const newTf = SIMPLE_PERIOD_TF[p] as TfLabel;
    setSimplePeriod(p);
    if (tf !== newTf) setTf(newTf);
  }
  function zoomChart(zoomIn: boolean) {
    const ts = chartRef.current?.timeScale();
    const range = ts?.getVisibleLogicalRange();
    if (!range) return;
    const center = (range.from + range.to) / 2, half = (range.to - range.from) / 2;
    ts.setVisibleLogicalRange({ from: center - half * (zoomIn ? 0.65 : 1.5), to: center + half * (zoomIn ? 0.65 : 1.5) });
  }
  function scrollChart(delta: number) { chartRef.current?.timeScale().scrollToPosition(delta, true); }
  function fitToday() {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const allCandles = replayMode ? replayCandlesRef.current.slice(0, replayIdxRef.current + 1) : rawRef.current;
    if (!allCandles.length) { ts.fitContent(); return; }
    const todayKey = Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) / 1000;
    const firstIdx = allCandles.findIndex(c => c.time >= todayKey);
    if (firstIdx < 0) { ts.fitContent(); return; }
    ts.setVisibleLogicalRange({ from: firstIdx - 0.5, to: allCandles.length - 0.5 });
  }

  function applyReplayData(candles: Candle[]) {
    const t = (c: Candle) => c.time as any;
    const s = seriesRef.current;
    if (!s.main || !chartRef.current) return;
    try {
      const closes = candles.map(c => c.close);
      const bbArr = computeBB(closes, 20, 2), rsiArr = computeRSI(closes, 14), vwapArr = computeVWAP(candles);
      if (ctRef.current === "candle") s.main.setData(candles.map(c => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
      else if (ctRef.current === "ha") s.main.setData(toHeikinAshi(candles).map(c => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
      else s.main.setData(candles.map(c => ({ time: t(c), value: c.close })));
      const bbV = candles.map((c, i) => ({ c, bb: bbArr[i] })).filter(x => x.bb.mid != null);
      s.bbUp?.setData(bbV.map(x => ({ time: t(x.c), value: x.bb.up! })));
      s.bbMid?.setData(bbV.map(x => ({ time: t(x.c), value: x.bb.mid! })));
      s.bbDn?.setData(bbV.map(x => ({ time: t(x.c), value: x.bb.dn! })));
      s.vwap?.setData(candles.map((c, i) => ({ time: t(c), value: vwapArr[i] })));
      if (indRef.current.has("VOL")) s.vol?.setData(candles.map(c => ({ time: t(c), value: c.volume, color: c.close >= c.open ? "rgba(22,163,74,0.4)" : "rgba(220,38,38,0.4)" })));
      const rsiV = candles.map((c, i) => ({ c, rsi: rsiArr[i] })).filter(x => x.rsi != null);
      s.rsi?.setData(rsiV.map(x => ({ time: t(x.c), value: x.rsi! })));
    } catch {}
  }
  function startReplay() {
    const all = rawRef.current;
    if (!all.length || !chartRef.current) return;
    replayCandlesRef.current = tfCfg.aggMinutes > 1 ? aggregate(all, tfCfg.aggMinutes) : all;
    replayIdxRef.current = 0; replayPlayingRef.current = false; replayPickingRef.current = true;
    setReplayMode(true); setReplayPicking(true); setReplayPlaying(false); setReplayIdx(0);
    const fullCandles = replayCandlesRef.current;
    const t = (c: Candle) => c.time as any;
    const s = seriesRef.current;
    try {
      if (ctRef.current === "candle") s.main?.setData(fullCandles.map(c => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
      else if (ctRef.current === "ha") s.main?.setData(toHeikinAshi(fullCandles).map(c => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
      else s.main?.setData(fullCandles.map(c => ({ time: t(c), value: c.close })));
    } catch {}
    const handler = (param: any) => {
      if (!replayPickingRef.current || param.logical == null) return;
      const idx = Math.max(0, Math.min(Math.round(param.logical as number), replayCandlesRef.current.length - 1));
      replayIdxRef.current = idx; replayPickingRef.current = false;
      setReplayPicking(false); setReplayIdx(idx);
      applyReplayData(replayCandlesRef.current.slice(0, idx + 1));
      chartRef.current?.unsubscribeClick(handler);
    };
    chartRef.current.subscribeClick(handler);
  }
  function stopReplay() {
    if (replayTimerRef.current) { clearInterval(replayTimerRef.current); replayTimerRef.current = null; }
    replayPlayingRef.current = false; replayPickingRef.current = false;
    setReplayMode(false); setReplayPicking(false); setReplayPlaying(false); setReplayIdx(0); replayIdxRef.current = 0;
    const candles = tfCfg.aggMinutes > 1 ? aggregate(rawRef.current, tfCfg.aggMinutes) : rawRef.current;
    applyReplayData(candles);
    chartRef.current?.timeScale().fitContent();
  }
  function toggleReplayPlay() {
    if (replayPlayingRef.current) {
      clearInterval(replayTimerRef.current!); replayTimerRef.current = null;
      replayPlayingRef.current = false; setReplayPlaying(false);
    } else {
      replayPlayingRef.current = true; setReplayPlaying(true);
      const delay = Math.round(400 / replaySpeed);
      replayTimerRef.current = setInterval(() => {
        const next = replayIdxRef.current + 1;
        if (next >= replayCandlesRef.current.length) { clearInterval(replayTimerRef.current!); replayTimerRef.current = null; replayPlayingRef.current = false; setReplayPlaying(false); return; }
        replayIdxRef.current = next; setReplayIdx(next);
        applyReplayData(replayCandlesRef.current.slice(0, next + 1));
      }, delay);
    }
  }
  function stepReplay(delta: number) {
    if (replayPlayingRef.current) return;
    const next = Math.max(0, Math.min(replayCandlesRef.current.length - 1, replayIdxRef.current + delta));
    replayIdxRef.current = next; setReplayIdx(next);
    applyReplayData(replayCandlesRef.current.slice(0, next + 1));
  }

  function removeTLs(series: any) {
    if (!tlSeriesRef.current) return;
    try { series.removePriceLine(tlSeriesRef.current.ep); } catch {}
    try { series.removePriceLine(tlSeriesRef.current.tp); } catch {}
    try { if (tlSeriesRef.current.t2) series.removePriceLine(tlSeriesRef.current.t2); } catch {}
    try { series.removePriceLine(tlSeriesRef.current.sp); } catch {}
    tlSeriesRef.current = null;
  }
  function mkTLs(series: any, tl: NonNullable<typeof tradeLines>) {
    return {
      ep: series.createPriceLine({ price: tl.entry, color: "#38bdf8", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: `Entry ₹${tl.entry.toFixed(2)}${tl.entryTime ? ` (${tl.entryTime})` : ""}` }),
      tp: series.createPriceLine({ price: tl.target, color: "#22c55e", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: `T1 ₹${tl.target.toFixed(2)}` }),
      t2: tl.target2 != null ? series.createPriceLine({ price: tl.target2, color: "#15803d", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: `T2 ₹${tl.target2.toFixed(2)}` }) : null,
      sp: series.createPriceLine({ price: tl.sl, color: "#e11d48", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: `SL ₹${tl.sl.toFixed(2)}` }),
    };
  }
  function captureScreenshot() {
    try {
      const canvas = chartRef.current?.takeScreenshot?.();
      if (!canvas) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `${tradingsymbol}_${tf}_${stamp}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setShotFlash(true); setTimeout(() => setShotFlash(false), 1500);
    } catch {}
  }

  async function placeOrder(action: "BUY" | "SELL") {
    setOS({ loading: true, result: null });
    try {
      const qty = orderLots * activeLotSize;
      const entry = liveLtp ?? rawRef.current[rawRef.current.length - 1]?.close ?? 0;
      const r = await fetch("/api/account/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tradingsymbol, security_id: token, transaction_type: action, quantity: qty, limit_price: entry }) }).then(r => r.json());
      if (r.error) throw new Error(r.error);
      const rr = calcRR(entry);
      const now = new Date();
      const tl = { entry, target: rr.target1, target2: rr.target2, sl: rr.sl, entryTime: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` };
      tlDataRef.current = tl; setTL(tl);
      setOS({ loading: false, result: `✓ ${action} @ ₹${entry.toFixed(2)}` });
      const s = seriesRef.current;
      if (s.main) { removeTLs(s.main); try { tlSeriesRef.current = mkTLs(s.main, tl); } catch {} }
    } catch (e: any) {
      setOS({ loading: false, result: `✗ ${e.message ?? "Order failed"}` });
    }
  }
  async function handleImmediateExit() {
    if (!acctLivePos || exitState === "loading") return;
    setExitState("loading");
    try {
      const price = liveLtp ?? acctLivePos.currentPrice ?? acctLivePos.buyPrice;
      const r = await fetch("/api/account/exit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ security_id: token, tradingsymbol: acctLivePos.tradingsymbol, quantity: acctLivePos.quantity, limit_price: price }) }).then(r => r.json());
      if (r.error) throw new Error(r.error);
      setExitState("done"); setAcctLivePos(null); setTL(null);
    } catch { setExitState("error"); }
  }

  // Draw live-position price lines once chart is ready
  useEffect(() => {
    if (loading || !acctLivePos) return;
    const s = seriesRef.current;
    if (!s.main) return;
    const rr = calcRR(acctLivePos.buyPrice);
    const tl = { entry: acctLivePos.buyPrice, target: rr.target1, target2: rr.target2, sl: rr.sl, entryTime: "" };
    tlDataRef.current = tl; setTL(tl);
    removeTLs(s.main);
    try { tlSeriesRef.current = mkTLs(s.main, tl); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctLivePos, loading]);

  // Keep the SMC pattern-zone rectangle(s) in sync with the chart's price
  // and time scales — recomputed every frame while patternZones is set.
  useEffect(() => {
    if (!patternZones?.length) { setZoneRects([]); return; }
    let raf = 0;
    const tick = () => {
      const series = seriesRef.current.main;
      const chart = chartRef.current;
      if (series && chart) {
        const ts = chart.timeScale();
        const rects = patternZones.map(z => {
          const left = ts.timeToCoordinate(z.fromTime);
          const right = ts.timeToCoordinate(z.toTime);
          const top = series.priceToCoordinate(z.top);
          const bottom = series.priceToCoordinate(z.bottom);
          return left != null && right != null && top != null && bottom != null
            ? { concept: z.concept, left, right, top, bottom } : null;
        }).filter((r): r is NonNullable<typeof r> => r != null);
        setZoneRects(rects);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [patternZones]);

  // Simple view computed
  const currentPrice = liveLtp ?? rawRef.current[rawRef.current.length - 1]?.close ?? 0;
  const changeVal = derivedPrevClose && derivedPrevClose > 0 ? currentPrice - derivedPrevClose : 0;
  const changeAbs = Math.abs(changeVal);
  const changePct = derivedPrevClose && derivedPrevClose > 0 ? Math.abs(changeVal / derivedPrevClose * 100) : 0;
  const simpleIsUp = changeVal >= 0;
  const simpleChgClr = simpleIsUp ? "#16a34a" : "#e11d48";
  const fmtPrice = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const simpleBadgeBg = isCE ? (isDark ? "#0c2a3f" : "#e0f2fe") : (isDark ? "#3b0764" : "#fae8ff");
  const simpleBadgeClr = isCE ? (isDark ? "#38bdf8" : "#0284c7") : (isDark ? "#e879f9" : "#a21caf");

  const liveOrLast = liveLtp ?? rawRef.current[rawRef.current.length - 1]?.close ?? 0;
  const approxBuy = liveOrLast * orderLots * activeLotSize;
  const canBuy = wallet === null || wallet >= approxBuy;
  const fmtWallet = wallet !== null ? `₹${wallet.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—";
  const approxClr = !canBuy ? "#e11d48" : txtPrimary;

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden" style={{ background: panelBg, zIndex: 100 }}>
      {/* Full-mode header */}
      {!simpleMode && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${border}`, background: isDark ? "#0d1424" : "#f8fafc" }}>
          <button onClick={onClose} className="flex h-7 flex-shrink-0 items-center gap-1 rounded px-2 transition-colors hover:opacity-80" style={{ background: btnBg, color: txtMuted }}>
            <IconChevronLeft size={13} /><span className="hidden text-[9px] font-bold sm:inline" style={MONO}>Back</span>
          </button>
          <div className="hidden flex-shrink-0 items-center gap-1.5 lg:flex">
            <span className="flex h-7 items-center rounded px-2.5 text-[9px] font-black" style={{ ...MONO, color: isCE ? "#38bdf8" : "#f472b6", background: isCE ? "#38bdf815" : "#f472b615", border: `1px solid ${isCE ? "#38bdf840" : "#f472b640"}` }}>{chartLabel}</span>
            <button onClick={() => setTO(v => !v)} className="h-7 cursor-pointer rounded px-2.5 text-[9px] font-black transition-all" style={{ ...MONO, background: tradeOpen ? "#e11d48" : "#e11d4820", color: tradeOpen ? "#fff" : "#e11d48", border: "1px solid #e11d4840" }}>Sell</button>
            <button onClick={() => setTO(v => !v)} className="h-7 cursor-pointer rounded px-2.5 text-[9px] font-black transition-all" style={{ ...MONO, background: tradeOpen ? "#16a34a" : "#16a34a20", color: tradeOpen ? "#fff" : "#16a34a", border: "1px solid #16a34a40" }}>Buy</button>
          </div>
          <div className="flex-1" />
          <div className="relative flex-shrink-0" ref={tfDropRef}>
            <button onClick={() => setTfOpen(v => !v)} className="h-7 w-[68px] cursor-pointer rounded px-2 text-[9px] font-bold" style={{ ...MONO, background: btnBg, color: txtPrimary, border: `1px solid ${border}` }}>{tf}</button>
            {tfOpen && (
              <div className="absolute right-0 top-8 z-[200] max-h-64 overflow-y-auto rounded-lg shadow-xl" style={{ background: panelBg, border: `1px solid ${border}` }}>
                {TF_LIST.map(({ label }) => (
                  <button key={label} onClick={() => { setTf(label); setTfOpen(false); }} className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-[9px] font-bold" style={{ ...MONO, color: tf === label ? "var(--accent)" : txtPrimary, background: tf === label ? "var(--accent-soft)" : "transparent" }}>{label}</button>
                ))}
              </div>
            )}
          </div>
          <div className="relative flex-shrink-0" ref={ctDropRef}>
            <button onClick={() => setCtOpen(v => !v)} className="h-7 w-[90px] cursor-pointer rounded px-2 text-[9px] font-bold" style={{ ...MONO, background: btnBg, color: txtPrimary, border: `1px solid ${border}` }}>
              {chartType === "candle" ? "Candle" : chartType === "ha" ? "Heikin Ashi" : chartType === "line" ? "Line" : "Area"}
            </button>
            {ctOpen && (
              <div className="absolute right-0 top-8 z-[200] overflow-hidden rounded-lg shadow-xl" style={{ background: panelBg, border: `1px solid ${border}` }}>
                {([["candle", "Candle"], ["ha", "Heikin Ashi"], ["line", "Line"], ["area", "Area"]] as [ChartType, string][]).map(([v, label]) => (
                  <button key={v} onClick={() => { setCT(v); setCtOpen(false); }} className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-[9px] font-bold" style={{ ...MONO, color: chartType === v ? "var(--accent)" : txtPrimary, background: chartType === v ? "var(--accent-soft)" : "transparent" }}>{label}</button>
                ))}
              </div>
            )}
          </div>
          <div className="relative flex-shrink-0" ref={indDropRef}>
            <button onClick={() => setIndOpen(v => !v)} className="flex h-7 cursor-pointer items-center gap-1 rounded px-2 text-[9px] font-bold transition-all"
              style={{ ...MONO, background: indicators.size > 0 ? (isDark ? "#1e3a5f" : "#dbeafe") : btnBg, color: indicators.size > 0 ? (isDark ? "#60a5fa" : "#1d4ed8") : txtMuted, border: `1px solid ${indicators.size > 0 ? (isDark ? "#3b82f660" : "#93c5fd") : border}` }}>
              Indicators
              {indicators.size > 0 && <span className="rounded-full px-1 text-[8px] font-black" style={{ background: isDark ? "#3b82f6" : "#2563eb", color: "#fff" }}>{indicators.size}</span>}
            </button>
            {indOpen && (
              <div className="absolute right-0 top-8 z-[200] min-w-[110px] overflow-hidden rounded-lg shadow-xl" style={{ background: panelBg, border: `1px solid ${border}` }}>
                {(["RSI", "BB", "VOL", "VWAP"] as Indicator[]).map((ind, i) => (
                  <button key={ind} onClick={() => toggleInd(ind)} className="flex w-full items-center gap-2 px-3 py-2 text-[9px] font-bold transition-colors hover:opacity-80"
                    style={{ ...MONO, borderTop: i > 0 ? `1px solid ${border}` : "none", background: indicators.has(ind) ? (isDark ? "#1e3a5f40" : "#dbeafe80") : "transparent", color: indicators.has(ind) ? (isDark ? "#60a5fa" : "#1d4ed8") : txtMuted }}>
                    <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded" style={{ background: indicators.has(ind) ? (isDark ? "#3b82f6" : "#2563eb") : "transparent", border: `1.5px solid ${indicators.has(ind) ? (isDark ? "#3b82f6" : "#2563eb") : border}` }}>
                      {indicators.has(ind) && <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><polyline points="1.5,4 3,5.5 6.5,2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    </span>
                    {ind}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={captureScreenshot} title="Capture chart screenshot" className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:opacity-70" style={{ background: shotFlash ? "#16a34a" : btnBg, color: shotFlash ? "#fff" : txtMuted }}>
            {shotFlash ? <IconCheck size={13} /> : <IconCamera size={13} />}
          </button>
          <button onClick={onClose} className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:opacity-70" style={{ background: btnBg, color: txtMuted }}><IconX size={13} /></button>
        </div>
      )}

      {/* Chart area */}
      <div className="relative flex-1 overflow-hidden">
        {simpleMode && (
          <div className="absolute left-0 right-0 top-0 z-20 px-4 pb-2 pt-3">
            <div className="mb-1.5 flex items-center gap-2">
              <button onClick={onClose} className="flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 transition-all hover:opacity-90 active:scale-95" style={{ background: isDark ? "#1e2a3a" : "#e2e8f0", color: txtPrimary, border: `1px solid ${border}` }}>
                <IconChevronLeft size={13} /><span className="text-[9px] font-bold" style={MONO}>Back</span>
              </button>
            </div>
            <div className="mb-0.5 flex items-center gap-2">
              <span className="truncate text-[20px] font-black leading-tight" style={{ ...MONO, color: txtPrimary }}>{chartLabel}</span>
              <span className="flex-shrink-0 rounded px-2 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: simpleBadgeBg, color: simpleBadgeClr }}>{type}</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-[16px] font-black leading-none" style={{ ...MONO, color: txtPrimary }}>{currentPrice > 0 ? fmtPrice(currentPrice) : "—"}</span>
              <span className="pb-0.5 text-[11px] font-bold" style={{ ...MONO, color: simpleChgClr }}>{simpleIsUp ? "▲" : "▼"} {changeAbs.toFixed(2)} ({simpleIsUp ? "+" : ""}{changePct.toFixed(2)}%)</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {([["Strike", strike > 0 ? strike.toLocaleString("en-IN") : "—", simpleBadgeClr], ["Low", todayStats?.low != null ? fmtPrice(todayStats.low) : "—", "#e11d48"], ["High", todayStats?.high != null ? fmtPrice(todayStats.high) : "—", "#16a34a"], ["Expiry", expiry || "—", txtMuted]] as [string, string, string][]).map(([label, val, c], i) => (
                <div key={label} className="flex items-center gap-1">
                  {i > 0 && <span style={{ color: txtMuted, opacity: 0.3, fontSize: 8 }}>|</span>}
                  <span className="text-[8px]" style={{ ...MONO, color: txtMuted }}>{label}</span>
                  <span className="text-[9px] font-black" style={{ ...MONO, color: c }}>{val}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {simpleMode && (
          <div className="absolute z-20" style={{ bottom: 65, right: 65 }}>
            <button onClick={() => { setCT("candle"); setTf("5m"); indRef.current = new Set<Indicator>(["VWAP"]); setInd(new Set(indRef.current)); setSimpleMode(false); }} title="Tech Chart"
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95" style={{ background: isDark ? "#1e3a5fdd" : "#2563ebdd", color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,0.25)" }}>
              <IconChartBar size={18} />
            </button>
          </div>
        )}

        {!simpleMode && !loading && !error && ohlc && (
          <div className="absolute left-2 top-2 z-20 flex items-center gap-2 rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ ...MONO, background: isDark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.8)", backdropFilter: "blur(4px)" }}>
            <span style={{ color: txtMuted }}>O<span style={{ color: txtPrimary }}> {ohlc.o.toFixed(2)}</span></span>
            <span style={{ color: txtMuted }}>H<span style={{ color: "#16a34a" }}> {ohlc.h.toFixed(2)}</span></span>
            <span style={{ color: txtMuted }}>L<span style={{ color: "#dc2626" }}> {ohlc.l.toFixed(2)}</span></span>
            <span style={{ color: txtMuted }}>C<span style={{ color: txtPrimary }}> {ohlc.c.toFixed(2)}</span></span>
          </div>
        )}

        {!loading && !error && acctLivePos && (() => {
          const rr = calcRR(acctLivePos.buyPrice);
          const cp = liveLtp ?? acctLivePos.currentPrice ?? 0;
          const pnlPts = cp - acctLivePos.buyPrice;
          const pnlVal = pnlPts * acctLivePos.quantity;
          const pnlClr = pnlVal >= 0 ? "#22c55e" : "#e11d48";
          const lockedPts = Math.max(0, Math.min(pnlPts, rr.target1 - acctLivePos.buyPrice));
          const fmtPnl = (v: number) => `${v >= 0 ? "+" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const exitLbl = exitState === "loading" ? "Exiting…" : exitState === "done" ? "Exited ✓" : exitState === "error" ? "Retry Exit" : "⚡ Exit Now";
          return (
            <div className="absolute right-2 top-2 z-40 overflow-hidden rounded-xl" style={{ background: isDark ? "rgba(8,11,15,0.92)" : "rgba(255,255,255,0.95)", backdropFilter: "blur(8px)", border: `1px solid ${border}`, minWidth: 176 }}>
              <div className="flex items-center justify-between px-2.5 py-1.5" style={{ background: isDark ? "#0f172a" : "#f1f5f9", borderBottom: `1px solid ${border}` }}>
                <span className="text-[8px] font-black tracking-widest" style={{ ...MONO, color: "#38bdf8" }}>LIVE POSITION</span>
                <span className="rounded-full px-1.5 py-0.5 text-[7px] font-bold" style={{ background: "#16a34a20", color: "#16a34a", border: "1px solid #16a34a40" }}>{acctLivePos.status}</span>
              </div>
              <div className="flex flex-col items-center px-2.5 py-1.5" style={{ borderBottom: `1px solid ${border}` }}>
                <span className="mb-0.5 text-[7px] font-bold tracking-widest" style={{ ...MONO, color: txtMuted }}>UNREALISED P&L</span>
                <span className="text-[15px] font-black leading-none" style={{ ...MONO, color: pnlClr }}>{fmtPnl(pnlVal)}</span>
                <span className="mt-0.5 text-[8px]" style={{ ...MONO, color: pnlClr }}>{pnlPts >= 0 ? "+" : ""}{pnlPts.toFixed(2)} pts · {acctLivePos.quantity} qty</span>
              </div>
              <div className="grid grid-cols-2 gap-px p-px" style={{ background: border }}>
                {([["ENTRY", acctLivePos.buyPrice.toFixed(2), "#38bdf8"], ["T1", rr.target1.toFixed(2), "#22c55e"], ["T2", rr.target2.toFixed(2), "#15803d"], ["SL", rr.sl.toFixed(2), "#e11d48"]] as [string, string, string][]).map(([label, val, c]) => (
                  <div key={label} className="flex flex-col items-center py-1.5" style={{ background: isDark ? "#080b0f" : "#f8fafc" }}>
                    <span className="text-[7px] font-bold tracking-widest" style={{ ...MONO, color: txtMuted }}>{label}</span>
                    <span className="text-[9px] font-black" style={{ ...MONO, color: c }}>₹{val}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between px-2.5 py-1.5" style={{ borderTop: `1px solid ${border}` }}>
                <span className="text-[7px] font-bold tracking-widest" style={{ ...MONO, color: txtMuted }}>LOCKED PTS</span>
                <span className="text-[8px] font-black" style={{ ...MONO, color: lockedPts > 0 ? "#22c55e" : txtMuted }}>{lockedPts >= 0 ? "+" : ""}{lockedPts.toFixed(2)}</span>
              </div>
              <div className="px-2 pb-2">
                <button disabled={exitState === "loading" || exitState === "done"} onClick={handleImmediateExit} className="w-full cursor-pointer rounded-lg py-1.5 text-[8px] font-black tracking-wide transition-all active:scale-95"
                  style={{ ...MONO, background: exitState === "done" ? "#16a34a" : "#e11d48", color: "#fff", opacity: exitState === "loading" || exitState === "done" ? 0.7 : 1 }}>{exitLbl}</button>
              </div>
            </div>
          );
        })()}

        {!simpleMode && !loading && !error && (
          <div className="absolute left-2 z-20 flex flex-col items-start gap-1 lg:hidden" style={{ bottom: "100px" }}>
            <span className="flex h-7 items-center rounded px-2.5 text-[9px] font-black" style={{ ...MONO, color: isCE ? "#38bdf8" : "#f472b6", background: isCE ? "#38bdf815" : "#f472b615", border: `1px solid ${isCE ? "#38bdf840" : "#f472b640"}` }}>{chartLabel}</span>
            <div className="flex gap-1.5">
              <button onClick={() => setTO(v => !v)} className="cursor-pointer rounded px-2.5 py-1 text-[9px] font-black transition-all" style={{ ...MONO, background: tradeOpen ? "#e11d48" : "#e11d4820", color: tradeOpen ? "#fff" : "#e11d48", border: "1px solid #e11d4840" }}>Sell</button>
              <button onClick={() => setTO(v => !v)} className="cursor-pointer rounded px-2.5 py-1 text-[9px] font-black transition-all" style={{ ...MONO, background: tradeOpen ? "#16a34a" : "#16a34a20", color: tradeOpen ? "#fff" : "#16a34a", border: "1px solid #16a34a40" }}>Buy</button>
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: panelBg }}>
            <div className="h-7 w-7 animate-spin rounded-full border-2" style={{ borderColor: border, borderTopColor: clr }} />
            <span className="text-[10px]" style={{ ...MONO, color: txtMuted }}>Loading {chartLabel} chart…</span>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ background: panelBg }}>
            <p className="text-[11px]" style={{ ...MONO, color: "#e11d48" }}>{error}</p>
            <button onClick={() => { setError(null); setLoading(true); }} className="cursor-pointer rounded px-3 py-1 text-[9px] font-bold" style={{ ...MONO, background: btnBg, color: txtMuted }}>Retry</button>
          </div>
        )}

        {!simpleMode && replayPicking && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <div className="rounded-lg px-4 py-2 text-center text-[11px] font-bold" style={{ ...MONO, background: "rgba(245,158,11,0.92)", color: "#000", boxShadow: "0 4px 20px rgba(0,0,0,0.4)" }}>Click any candle to start replay from that point</div>
          </div>
        )}

        {!simpleMode && !loading && !error && (
          <div className="absolute left-2 z-20 flex flex-wrap items-center gap-1" style={{ bottom: "70px" }}>
            <button onClick={() => scrollChart(-15)} title="Scroll left" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-60 hover:opacity-100" style={{ background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)", color: txtPrimary, border: `1px solid ${border}` }}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M5 1L2 4l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
            <button onClick={() => zoomChart(true)} title="Zoom in" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[11px] font-bold opacity-60 hover:opacity-100" style={{ background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)", color: txtPrimary, border: `1px solid ${border}`, ...MONO }}>+</button>
            <button onClick={() => zoomChart(false)} title="Zoom out" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[11px] font-bold opacity-60 hover:opacity-100" style={{ background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)", color: txtPrimary, border: `1px solid ${border}`, ...MONO }}>−</button>
            <button onClick={() => scrollChart(15)} title="Scroll right" className="flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-60 hover:opacity-100" style={{ background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)", color: txtPrimary, border: `1px solid ${border}` }}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M3 1l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
            <button onClick={fitToday} title="Fit to today" className="flex h-6 items-center justify-center rounded px-1.5 text-[9px] font-bold opacity-60 hover:opacity-100" style={{ background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)", color: txtPrimary, border: `1px solid ${border}`, ...MONO }}>1D</button>
            {!replayMode ? (
              <button onClick={startReplay} title="Replay" className="flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-[9px] font-bold opacity-70 hover:opacity-100" style={{ background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)", color: "#f59e0b", border: "1px solid #f59e0b50", ...MONO }}>
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><polygon points="1,0 8,4 1,8" fill="currentColor" /></svg>Replay
              </button>
            ) : replayPicking ? (
              <button onClick={stopReplay} className="flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-[9px] font-bold" style={{ background: "#f59e0b", color: "#000", ...MONO }}>Cancel</button>
            ) : (
              <div className="flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: isDark ? "rgba(15,23,42,0.92)" : "rgba(255,255,255,0.92)", border: "1px solid #f59e0b60" }}>
                <button onClick={() => stepReplay(-1)} disabled={replayPlaying} title="Step back" className="flex h-5 w-5 cursor-pointer items-center justify-center rounded opacity-70 hover:opacity-100 disabled:opacity-30" style={{ color: "#f59e0b" }}>
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M7 1L3 4l4 3V1z" fill="currentColor" /><rect x="0" y="1" width="1.5" height="6" rx="0.5" fill="currentColor" /></svg>
                </button>
                <button onClick={toggleReplayPlay} title={replayPlaying ? "Pause" : "Play"} className="flex h-5 w-5 cursor-pointer items-center justify-center rounded" style={{ color: "#f59e0b" }}>
                  {replayPlaying ? <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><rect x="0" y="0" width="3" height="8" rx="0.5" fill="currentColor" /><rect x="5" y="0" width="3" height="8" rx="0.5" fill="currentColor" /></svg> : <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><polygon points="0,0 8,4 0,8" fill="currentColor" /></svg>}
                </button>
                <button onClick={() => stepReplay(1)} disabled={replayPlaying} title="Step forward" className="flex h-5 w-5 cursor-pointer items-center justify-center rounded opacity-70 hover:opacity-100 disabled:opacity-30" style={{ color: "#f59e0b" }}>
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1l4 3-4 3V1z" fill="currentColor" /><rect x="6.5" y="1" width="1.5" height="6" rx="0.5" fill="currentColor" /></svg>
                </button>
                <button onClick={() => setReplaySpeed(s => s === 1 ? 2 : s === 2 ? 4 : 1)} className="cursor-pointer px-1 text-[8px] font-bold" style={{ ...MONO, color: "#f59e0b" }}>{replaySpeed}x</button>
                <span className="text-[8px] font-bold" style={{ ...MONO, color: "#f59e0b" }}>{replayIdx + 1}/{replayCandlesRef.current.length}</span>
                <button onClick={stopReplay} title="Stop" className="flex h-5 w-5 cursor-pointer items-center justify-center rounded opacity-70 hover:opacity-100" style={{ color: "#e11d48" }}>
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><rect x="0" y="0" width="8" height="8" rx="1" fill="currentColor" /></svg>
                </button>
              </div>
            )}
          </div>
        )}

        {!simpleMode && indicators.has("RSI") && !loading && !error && (
          <div className="absolute left-0 right-0 z-30 flex cursor-ns-resize select-none items-center justify-center" style={{ bottom: rsiHeight - 3, height: 8 }}
            onMouseDown={e => { e.preventDefault(); rsiDragRef.current = { startY: e.clientY, startH: rsiHeightRef.current }; }}>
            <div className="h-[3px] w-12 rounded-full" style={{ background: isDark ? "#334155" : "#cbd5e1" }} />
          </div>
        )}

        <div ref={chartDivRef} className="absolute inset-0" />

        {zoneRects.map((r, i) => {
          const color = { LiqGrab: "#f59e0b", FVG: "#a855f7", OrdBlock: "#0ea5e9", Breaker: "#ec4899", SMTrap: "#16a34a" }[r.concept] ?? "#94a3b8";
          const left = Math.min(r.left, r.right), width = Math.max(2, Math.abs(r.right - r.left));
          const top = Math.min(r.top, r.bottom), height = Math.max(2, Math.abs(r.bottom - r.top));
          return (
            <div key={i} className="pointer-events-none absolute z-10" style={{ left, width, top, height, background: `${color}22`, border: `1px solid ${color}80` }}>
              <span className="absolute -top-4 left-0 whitespace-nowrap rounded px-1 text-[8px] font-bold" style={{ ...MONO, background: color, color: "#fff" }}>{r.concept}</span>
            </div>
          );
        })}
      </div>

      {simpleMode && (
        <div className="flex flex-shrink-0 items-center gap-1 px-3 py-2" style={{ borderTop: `1px solid ${border}`, background: isDark ? "#080b0f" : "#f1f5f9" }}>
          {["1D", "1W", "1M", "3M", "6M", "1Y", "5Y"].map(p => (
            <button key={p} onClick={() => handleSimplePeriod(p)} className="flex-1 cursor-pointer rounded py-1 text-[9px] font-black transition-all active:scale-95" style={{ ...MONO, background: simplePeriod === p ? "#16a34a" : "transparent", color: simplePeriod === p ? "#fff" : txtMuted }}>{p}</button>
          ))}
        </div>
      )}

      {tradeOpen && (
        <div className="absolute bottom-0 left-0 right-0 z-30" style={{ borderTop: `1px solid ${border}`, background: panelBg }}>
          <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: `1px solid ${divider}` }}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[11px] font-bold" style={{ ...MONO, color: txtPrimary }}>{chartLabel}</span>
              <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold" style={{ ...MONO, background: isCE ? "#0284c720" : "#e11d4820", color: isCE ? "#0284c7" : "#e11d48" }}>{type}</span>
              {liveOrLast > 0 && <span className="flex-shrink-0 text-[13px] font-black" style={{ ...MONO, color: txtPrimary }}>₹{liveOrLast.toFixed(2)}</span>}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {orderState.result && <span className="text-[9px] font-bold" style={{ ...MONO, color: orderState.result.startsWith("✓") ? "#16a34a" : "#e11d48" }}>{orderState.result}</span>}
              <button onClick={() => setTO(false)} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full transition-colors hover:opacity-70" style={{ background: btnBg, color: txtMuted }}><IconX size={11} /></button>
            </div>
          </div>
          <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: `1px solid ${divider}` }}>
            <div className="flex flex-col items-start gap-0.5">
              <span className="text-[8px] uppercase" style={{ ...MONO, color: txtMuted }}>Available</span>
              <span className="text-[12px] font-bold" style={{ ...MONO, color: wallet !== null && !canBuy ? "#e11d48" : "#16a34a" }}>{fmtWallet}</span>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[8px] uppercase" style={{ ...MONO, color: txtMuted }}>Approx Req</span>
              <span className="text-[12px] font-bold" style={{ ...MONO, color: approxClr }}>₹{approxBuy.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 px-4 py-2.5" style={{ borderBottom: `1px solid ${divider}` }}>
            <span className="text-[9px] uppercase" style={{ ...MONO, color: txtMuted }}>Lots</span>
            <button onClick={() => setOL(v => Math.max(1, v - 1))} className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[14px] font-bold" style={{ background: btnBg, color: btnClr }}>−</button>
            <span className="w-6 text-center text-[14px] font-bold" style={{ ...MONO, color: txtPrimary }}>{orderLots}</span>
            <button onClick={() => setOL(v => v + 1)} className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[14px] font-bold" style={{ background: btnBg, color: btnClr }}>+</button>
            <span className="ml-auto text-[9px]" style={{ ...MONO, color: txtMuted }}>{orderLots} × {activeLotSize} = {orderLots * activeLotSize} qty</span>
          </div>
          {!canBuy && wallet !== null && (
            <div className="mx-4 mb-2 rounded-lg px-3 py-1.5 text-center text-[9px] font-bold" style={{ ...MONO, background: "#e11d4815", color: "#e11d48", border: "1px solid #e11d4830" }}>Insufficient funds · Need ₹{(approxBuy - wallet).toLocaleString("en-IN", { maximumFractionDigits: 0 })} more</div>
          )}
          <div className="grid grid-cols-2 gap-2 px-4 pb-3 pt-2">
            <button disabled={orderState.loading || !canBuy} onClick={() => placeOrder("SELL")} className="cursor-pointer rounded-lg py-1.5 text-[10px] font-black tracking-[0.5px] transition-opacity" style={{ ...MONO, background: "#e11d48", color: "#fff", opacity: orderState.loading || !canBuy ? 0.4 : 1 }}>{orderState.loading ? "..." : "↙ Sell @ Mkt"}</button>
            <button disabled={orderState.loading || !canBuy} onClick={() => placeOrder("BUY")} className="cursor-pointer rounded-lg py-1.5 text-[10px] font-black tracking-[0.5px] transition-opacity" style={{ ...MONO, background: "#16a34a", color: "#fff", opacity: orderState.loading || !canBuy ? 0.4 : 1 }}>{orderState.loading ? "..." : "↗ Buy @ Mkt"}</button>
          </div>
          {tradeLines && (
            <div className="flex flex-wrap items-center gap-3 px-4 pb-2.5">
              <div className="flex items-center gap-1"><div className="w-4 border-t" style={{ borderColor: "#38bdf8" }} /><span className="text-[8px] font-bold" style={{ ...MONO, color: "#38bdf8" }}>Entry ₹{tradeLines.entry.toFixed(2)}</span></div>
              <div className="flex items-center gap-1"><div className="w-4 border-t" style={{ borderColor: "#22c55e" }} /><span className="text-[8px] font-bold" style={{ ...MONO, color: "#22c55e" }}>T1 ₹{tradeLines.target.toFixed(2)}</span></div>
              {tradeLines.target2 != null && <div className="flex items-center gap-1"><div className="w-4 border-t" style={{ borderColor: "#15803d" }} /><span className="text-[8px] font-bold" style={{ ...MONO, color: "#15803d" }}>T2 ₹{tradeLines.target2.toFixed(2)}</span></div>}
              <div className="flex items-center gap-1"><div className="w-4 border-t" style={{ borderColor: "#e11d48" }} /><span className="text-[8px] font-bold" style={{ ...MONO, color: "#e11d48" }}>SL ₹{tradeLines.sl.toFixed(2)}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
