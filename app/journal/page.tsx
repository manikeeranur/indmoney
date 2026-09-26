"use client";

// ─── Trading journal ────────────────────────────────────────────────────────────
// Full port of frontend/components/TradingJournalContent.tsx: month/year/
// all-time view switcher, donut + bar charts, calendar/month-grid/year-cards,
// and the trades table section (month/direction/result/max-points filters,
// column-visibility toggles, pagination, mobile-card + desktop-table layouts,
// footer stats). Same /api/results + /api/results/summary endpoints, same
// live "lots per entry" via useAccountQty so the ₹ P&L shown here never
// drifts from what auto-trade actually orders.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";
import { LOT_SIZE, NUM_LOTS } from "@/lib/strategies/constants";
import { useHolidaysMap } from "@/lib/holidays";
import { useAccountQty } from "@/lib/useAccountQty";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";

const MONO = { fontFamily: "'Space Mono', monospace" } as const;
const BEBAS = { fontFamily: "'Bebas Neue', sans-serif" } as const;
const ACCENT = "#7c3aed";

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DAY_NAMES = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

type DaySummary = { date: string; totalPnL: number; trades: number; wins: number };
type ViewType = "month" | "year" | "overall";

type BarEntry = { key: string; label: string; lot: number; trades: number; wins: number; tipLine2?: string };

function pnlColor(n: number) { return n >= 0 ? "#16a34a" : "#e11d48"; }

function fmtAmt(n: number) {
  const abs = Math.abs(n);
  const s = n >= 0 ? "+" : "−";
  if (abs >= 100000) return `${s}₹${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${s}₹${(abs / 1000).toFixed(1)}K`;
  return `${s}₹${abs.toFixed(0)}`;
}

function fmtIndianFull(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  let grouped: string;
  if (int.length <= 3) grouped = int;
  else {
    const last3 = int.slice(-3);
    const rest = int.slice(0, int.length - 3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }
  return `${sign}₹${grouped}.${dec}`;
}

function buildCalendar(year: number, month: number): (number | null)[] {
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// ─── Donut chart ──────────────────────────────────────────────────────────────

function polar(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(angle - Math.PI / 2), y: cy + r * Math.sin(angle - Math.PI / 2) };
}
function arcPath(cx: number, cy: number, R: number, ri: number, a1: number, a2: number) {
  const o1 = polar(cx, cy, R, a1); const o2 = polar(cx, cy, R, a2);
  const i1 = polar(cx, cy, ri, a2); const i2 = polar(cx, cy, ri, a1);
  const lg = a2 - a1 > Math.PI ? 1 : 0;
  return `M${o1.x},${o1.y} A${R},${R},0,${lg},1,${o2.x},${o2.y} L${i1.x},${i1.y} A${ri},${ri},0,${lg},0,${i2.x},${i2.y}Z`;
}

function DonutChart({ profit, loss, isDark, label = "Total P&L" }: { profit: number; loss: number; isDark: boolean; label?: string }) {
  const cx = 100, cy = 100, R = 82, ri = 50;
  const net = profit + loss;
  const total = profit + Math.abs(loss);
  const muted = isDark ? "#4a6080" : "#94a3b8";
  const bg = isDark ? "#0d1420" : "#f8fafc";

  if (total < 0.01) {
    return (
      <div className="flex items-center justify-center" style={{ height: 200 }}>
        <span style={{ ...MONO, color: muted, fontSize: 10 }}>No trades</span>
      </div>
    );
  }
  const profitFrac = profit / total;
  const GAP = 0.05;
  const onlyProfit = Math.abs(loss) < 0.01;
  const onlyLoss = profit < 0.01;
  const pPct = total > 0 ? ((profit / total) * 100).toFixed(0) : "0";
  const lPct = total > 0 ? ((Math.abs(loss) / total) * 100).toFixed(0) : "0";

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <svg viewBox="0 0 200 200" style={{ width: "min(190px, 100%)", height: "auto", display: "block" }}>
        {onlyProfit && <><circle cx={cx} cy={cy} r={R} fill="#16a34a" /><circle cx={cx} cy={cy} r={ri} fill={bg} /></>}
        {onlyLoss && <><circle cx={cx} cy={cy} r={R} fill="#e11d48" /><circle cx={cx} cy={cy} r={ri} fill={bg} /></>}
        {!onlyProfit && !onlyLoss && <>
          {profit > 0 && <path d={arcPath(cx, cy, R, ri, GAP / 2, profitFrac * 2 * Math.PI - GAP / 2)} fill="#16a34a" />}
          {Math.abs(loss) > 0 && <path d={arcPath(cx, cy, R, ri, profitFrac * 2 * Math.PI + GAP / 2, 2 * Math.PI - GAP / 2)} fill="#e11d48" />}
        </>}
        <text x={cx} y={cy - 11} textAnchor="middle" fontSize="8" fontWeight="700" fontFamily="'Space Mono',monospace" fill={muted} letterSpacing="1.5">{label.toUpperCase()}</text>
        <text x={cx} y={cy + 11} textAnchor="middle" fontSize="16" fontWeight="bold" fontFamily="'Bebas Neue',sans-serif" fill={pnlColor(net)}>{fmtIndianFull(net)}</text>
      </svg>
      <div className="flex gap-5 justify-center w-full flex-wrap">
        {profit > 0 && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: "#16a34a" }} />
            <div>
              <div className="text-[7px] font-bold tracking-[1px]" style={{ ...MONO, color: muted }}>PROFIT · {pPct}%</div>
              <div className="text-[10px] font-bold" style={{ ...MONO, color: "#16a34a" }}>{fmtIndianFull(profit)}</div>
            </div>
          </div>
        )}
        {Math.abs(loss) > 0 && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: "#e11d48" }} />
            <div>
              <div className="text-[7px] font-bold tracking-[1px]" style={{ ...MONO, color: muted }}>LOSS · {lPct}%</div>
              <div className="text-[10px] font-bold" style={{ ...MONO, color: "#e11d48" }}>{fmtIndianFull(loss)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Bar chart ────────────────────────────────────────────────────────────────

function BarChart({ data, isDark }: { data: BarEntry[]; isDark: boolean }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const muted = isDark ? "#64748b" : "#94a3b8";

  if (!data.length) {
    return (
      <div className="flex items-center justify-center w-full" style={{ height: 240 }}>
        <span style={{ ...MONO, color: muted, fontSize: 10 }}>No trades</span>
      </div>
    );
  }

  const maxAbs = Math.max(...data.map(d => Math.abs(d.lot)), 1);
  const BAR_W = 46, GAP = 12, PAD_L = 10, PAD_R = 10;
  const HALF_H = 90, PAD_TOP = 56, PAD_BOT = 48;
  const ZERO_Y = PAD_TOP + HALF_H;
  const SVG_W = PAD_L + data.length * (BAR_W + GAP) - GAP + PAD_R;
  const SVG_H = PAD_TOP + HALF_H * 2 + PAD_BOT;
  const TIP_W = 142, TIP_H = 46;

  return (
    <div style={{ overflowX: "auto", width: "100%" }}>
      <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} width={Math.max(SVG_W, 300)} height={SVG_H} style={{ display: "block", minWidth: 300 }}>
        <line x1={0} y1={ZERO_Y} x2={SVG_W} y2={ZERO_Y} stroke={isDark ? "#2a3a4a" : "#cbd5e1"} strokeWidth="1" />
        {data.map((d, i) => {
          const x = PAD_L + i * (BAR_W + GAP);
          const barH = Math.max((Math.abs(d.lot) / maxAbs) * HALF_H - 2, 2);
          const isP = d.lot >= 0;
          const clr = isP ? "#16a34a" : "#e11d48";
          const barY = isP ? ZERO_Y - barH : ZERO_Y;
          const lbl = fmtAmt(d.lot);
          const lblY = isP ? Math.max(barY - 5, 11) : Math.min(barY + barH + 13, SVG_H - PAD_BOT + 6);
          const isHov = hoveredIdx === i;
          return (
            <g key={d.key} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} style={{ cursor: "default" }}>
              {isHov && <rect x={x - 3} y={PAD_TOP - 4} width={BAR_W + 6} height={HALF_H * 2 + 8} rx={4} fill={clr} opacity={0.07} />}
              <rect x={x} y={barY} width={BAR_W} height={barH} fill={clr} rx={3} opacity={isHov ? 1 : 0.85} />
              <text x={x + BAR_W / 2} y={lblY} textAnchor="middle" fontSize="9" fontWeight="bold" fontFamily="'Space Mono',monospace" fill={clr}>{lbl}</text>
              <text x={x + BAR_W / 2} y={ZERO_Y + HALF_H + 17} textAnchor="middle" fontSize="9" fontWeight="600" fontFamily="'Space Mono',monospace" fill={muted}>{d.label}</text>
              <text x={x + BAR_W / 2} y={ZERO_Y + HALF_H + 31} textAnchor="middle" fontSize="7" fontFamily="'Space Mono',monospace" fill={isDark ? "#4a6080" : "#b0bec5"}>{d.trades}T</text>
            </g>
          );
        })}
        {hoveredIdx !== null && (() => {
          const d = data[hoveredIdx];
          const isP = d.lot >= 0;
          const clr = isP ? "#16a34a" : "#e11d48";
          const bx = PAD_L + hoveredIdx * (BAR_W + GAP);
          const barH = Math.max((Math.abs(d.lot) / maxAbs) * HALF_H - 2, 2);
          const barY = isP ? ZERO_Y - barH : ZERO_Y;
          const tx = Math.min(Math.max(bx + BAR_W / 2 - TIP_W / 2, 2), SVG_W - TIP_W - 2);
          const ty = isP ? barY - TIP_H - 10 : barY + barH + 10;
          const losses = d.trades - d.wins;
          return (
            <g pointerEvents="none">
              <rect x={tx} y={ty} width={TIP_W} height={TIP_H} rx={5} fill={isDark ? "#0f1923" : "#fff"} stroke={clr} strokeWidth="1.2" style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.25))" }} />
              <text x={tx + TIP_W / 2} y={ty + 13} textAnchor="middle" fontSize="10" fontWeight="bold" fontFamily="'Space Mono',monospace" fill={clr}>{fmtIndianFull(d.lot)}</text>
              {d.tipLine2 && <text x={tx + TIP_W / 2} y={ty + 26} textAnchor="middle" fontSize="8" fontFamily="'Space Mono',monospace" fill={isDark ? "#64748b" : "#94a3b8"}>{d.tipLine2}</text>}
              <text x={tx + TIP_W / 2} y={ty + (d.tipLine2 ? 39 : 30)} textAnchor="middle" fontSize="8" fontFamily="'Space Mono',monospace" fill={isDark ? "#4a6080" : "#94a3b8"}>{d.trades}T · {d.wins}W · {losses}L</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

function StatsRow({ cols, isDark, border }: { cols: { label: string; val: string; color: string }[]; isDark: boolean; border: string }) {
  return (
    <div className="grid border-t" style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)`, gap: "1px", background: border }}>
      {cols.map(({ label, val, color: c }) => (
        <div key={label} className="px-3 py-2.5" style={{ background: isDark ? "#0a0f16" : "#fff" }}>
          <div className="text-[7px] tracking-[1.5px] uppercase mb-1" style={{ ...MONO, color: isDark ? "#4a6080" : "#64748b" }}>{label}</div>
          <div className="text-[14px] font-bold leading-tight" style={{ ...MONO, color: c }}>{val}</div>
        </div>
      ))}
    </div>
  );
}

function ChartsPanel({ profit, loss, barData, donutLabel, donutFooter, barFooter, isDark, border, barHeader }: {
  profit: number; loss: number; barData: BarEntry[]; donutLabel?: string;
  donutFooter: { label: string; val: string; color: string }[];
  barFooter: { label: string; val: string; color: string }[];
  barHeader?: string; isDark: boolean; border: string;
}) {
  const cardBg = isDark ? "#0d1420" : "#f8fafc";
  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="flex-1 min-w-0 rounded-xl border flex flex-col overflow-hidden" style={{ borderColor: border, background: cardBg }}>
        <div className="px-4 py-2.5 border-b" style={{ borderColor: border }}>
          <span className="text-[9px] font-bold tracking-[1.5px]" style={{ ...MONO, color: isDark ? "#94a3b8" : "#64748b" }}>PROFIT vs LOSS</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4"><DonutChart profit={profit} loss={loss} isDark={isDark} label={donutLabel} /></div>
        {donutFooter.length > 0 && <StatsRow cols={donutFooter} isDark={isDark} border={border} />}
      </div>
      <div className="flex-1 min-w-0 rounded-xl border flex flex-col overflow-hidden" style={{ borderColor: border, background: cardBg }}>
        <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: border }}>
          <span className="text-[9px] font-bold tracking-[1.5px]" style={{ ...MONO, color: isDark ? "#94a3b8" : "#64748b" }}>{barHeader ?? "DATE-WISE P&L"}</span>
        </div>
        <div className="flex-1 p-3 overflow-x-auto flex items-center"><BarChart data={barData} isDark={isDark} /></div>
        {barFooter.length > 0 && <StatsRow cols={barFooter} isDark={isDark} border={border} />}
      </div>
    </div>
  );
}

// ─── Trades table helpers ────────────────────────────────────────────────────

type Row = Record<string, string>;
const STATUS_COLOR: Record<string, string> = { TARGET: "#22c55e", TIME_PROFIT: "#22c55e", SL: "#ef4444", TIME_EXIT: "#ef4444", EOD: "#94a3b8", ACTIVE: "#60a5fa" };
function dirColor(d: string) { return d === "CE" ? "#0284c7" : "#e11d48"; }
function fmtTime(t: string) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const hr = h % 12 || 12;
  return `${String(hr).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
// INDstocks' real F&O charge structure (verified against GET /margin and
// https://api-docs.indstocks.com/margin_calculation/ — same rates
// lib/runtime/accountService.ts's estimateCharges() uses for the Account
// tab): ₹10 flat brokerage per order (₹20 round-trip), STT 0.1% sell-side
// only, exchange 0.03503%, SEBI ₹10/crore, stamp duty 0.003% buy-side only,
// GST 18% on brokerage+exchange only. NOT Zerodha's ₹20/order + 0.0625% STT.
function calcCharges(entry: number, exit: number, qty: number): number {
  const to = (entry + exit) * qty;
  const br = 20; // ₹10 × 2 orders (entry + exit)
  const exc = to * 0.0003503;
  const sebi = to * 0.0000001;
  const stt = exit * qty * 0.001; // sell-side only
  const stamp = entry * qty * 0.00003; // buy-side only
  const gst = (br + exc) * 0.18;
  return br + stt + exc + sebi + gst + stamp;
}

type DirFilter = "ALL" | "CE" | "PE";
type ResultFilter = "ALL" | "T1" | "T2" | "PROFIT" | "LOSS";
type MaxPtsFilter = "ALL" | "5" | "10" | "15" | "20" | "25" | "30";
const MAX_PTS_OPTIONS: MaxPtsFilter[] = ["ALL", "5", "10", "15", "20", "25", "30"];

const COL_DEFS = [
  { key: "date", label: "DATE", w: "70px" },
  { key: "time", label: "TIME", w: "120px" },
  { key: "concepts", label: "CONCEPTS", w: "1fr" },
  { key: "strike", label: "STRIKE", w: "78px" },
  { key: "entry", label: "ENTRY", w: "60px" },
  { key: "sl", label: "SL", w: "58px" },
  { key: "t1", label: "T1", w: "68px" },
  { key: "t2", label: "T2", w: "68px" },
  { key: "result", label: "RESULT", w: "128px" },
  { key: "maxpts", label: "MAX PTS", w: "72px" },
  { key: "charges", label: "CHARGES", w: "76px" },
  { key: "pnl", label: "P&L", w: "128px" },
] as const;
type ColKey = typeof COL_DEFS[number]["key"];

function fmtDateCell(d: string) {
  const [y, m, day] = d.split("-");
  return { top: `${parseInt(day)} ${MONTH_SHORT[parseInt(m) - 1]}`, bot: y };
}

function JournalTradesSection({ isDark, border, color, muted, strategy }: {
  isDark: boolean; border: string; color: string; muted: string; strategy: "smc" | "vwap930";
}) {
  const [tradeDates, setTradeDates] = useState<string[]>([]);
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [monthFilter, setMonthF] = useState("ALL");
  const [dirFilter, setDirF] = useState<DirFilter>("ALL");
  const [resFilter, setResF] = useState<ResultFilter>("ALL");
  const [page, setPage] = useState(1);
  const [openDrop, setOpenDrop] = useState<"month" | "type" | "result" | "maxpts" | "cols" | null>(null);
  const [maxPtsFilter, setMaxPtsF] = useState<MaxPtsFilter>("ALL");
  const [visCols, setVisCols] = useState<Set<ColKey>>(new Set(COL_DEFS.map(c => c.key)));
  const [pageSize, setPageSz] = useState(10);
  const filterRef = useRef<HTMLDivElement>(null);
  const acctQty = useAccountQty(NUM_LOTS);
  const LOT_QTY = LOT_SIZE * acctQty;

  const dynTCOLS = "30px " + COL_DEFS.filter(c => visCols.has(c.key)).map(c => c.w).join(" ");
  const cardBg = isDark ? "#0d1420" : "#f8fafc";
  const rowEven = isDark ? "#0a0f16" : "#fff";
  const rowOdd = isDark ? "#0d1420" : "#fafafa";

  useEffect(() => {
    setLoading(true);
    fetch(`/api/results?strategy=${strategy}`)
      .then(r => r.json())
      .then(d => {
        const live = (d.live ?? []) as string[];
        setTradeDates(live);
        if (!live.length) { setLoading(false); setAllRows([]); return; }
        setProgress({ done: 0, total: live.length });
        let done = 0;
        Promise.all(
          live.map(date =>
            fetch(`/api/results?type=live&date=${date}&strategy=${strategy}`)
              .then(r => r.json())
              .then(data => ({ date, rows: (data.rows ?? []) as Row[] }))
              .catch(() => ({ date, rows: [] as Row[] }))
              .finally(() => setProgress(p => ({ ...p, done: ++done })))
          )
        ).then(results => {
          const combined: Row[] = [];
          for (const { date, rows } of results) for (const row of rows) combined.push({ ...row, _date: date });
          combined.sort((a, b) => {
            const dc = b._date.localeCompare(a._date);
            return dc !== 0 ? dc : (a.EntryTime ?? "").localeCompare(b.EntryTime ?? "");
          });
          setAllRows(combined);
        }).finally(() => setLoading(false));
      })
      .catch(() => setLoading(false));
  }, [strategy]);

  const months = useMemo(() => {
    const ms = [...new Set(tradeDates.map(d => d.slice(0, 7)))].sort().reverse();
    return ["ALL", ...ms];
  }, [tradeDates]);

  const filtered = useMemo(() => allRows.filter(r => {
    if (monthFilter !== "ALL" && !r._date?.startsWith(monthFilter)) return false;
    if (dirFilter !== "ALL" && r.Direction !== dirFilter) return false;
    if (resFilter === "T1" && r.T1Hit !== "Y") return false;
    if (resFilter === "T2" && r.Status !== "TARGET") return false;
    if (resFilter === "PROFIT" && (parseFloat(r.PnL) || 0) < 0) return false;
    if (resFilter === "LOSS" && (parseFloat(r.PnL) || 0) >= 0) return false;
    if (maxPtsFilter !== "ALL" && (parseFloat(r.MaxPoints) || 0) < parseFloat(maxPtsFilter)) return false;
    return true;
  }), [allRows, monthFilter, dirFilter, resFilter, maxPtsFilter]);

  const wins = filtered.filter(r => r.Status === "TARGET" || r.Status === "TIME_PROFIT" || (r.Status === "TIME_EXIT" && (parseFloat(r.PnL) || 0) >= 0)).length;
  const losses = filtered.filter(r => r.Status === "SL" || (r.Status === "TIME_EXIT" && (parseFloat(r.PnL) || 0) < 0)).length;
  const eod = filtered.filter(r => r.Status === "EOD").length;
  const closed = wins + losses;
  const wr = closed > 0 ? ((wins / closed) * 100).toFixed(1) : null;
  const totPnL = filtered.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
  const lotPnL = totPnL * LOT_QTY;
  const wrClr = wr && Number(wr) >= 70 ? "#16a34a" : "#e11d48";

  const totCharges = useMemo(() => filtered.reduce((s, r) => {
    const e = parseFloat(r.Entry) || 0;
    const p = parseFloat(r.PnL) || 0;
    return s + calcCharges(e, e + p, LOT_QTY);
  }, 0), [filtered, LOT_QTY]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  useEffect(() => { setPage(1); }, [monthFilter, dirFilter, resFilter, maxPtsFilter, pageSize]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[9px] font-bold tracking-[2px]" style={{ ...MONO, color: ACCENT }}>▶ LIVE</span>
        <span className="text-[9px] font-bold tracking-[1.5px]" style={{ ...MONO, color: muted }}>
          ALL TRADES {!loading && allRows.length > 0 && `· ${allRows.length} total`}
        </span>
      </div>

      {(() => {
        const monthActive = monthFilter !== "ALL";
        const typeActive = dirFilter !== "ALL";
        const resActive = resFilter !== "ALL";
        const maxPtsActive = maxPtsFilter !== "ALL";
        const colsActive = visCols.size < COL_DEFS.length;
        const anyActive = monthActive || typeActive || resActive || maxPtsActive || colsActive;

        const mkBtn = (id: typeof openDrop, label: string, active: boolean) => (
          <button onClick={() => setOpenDrop(prev => prev === id ? null : id)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg border cursor-pointer transition-colors"
            style={{ ...MONO, background: openDrop === id ? `${ACCENT}15` : (isDark ? "#0f1923" : "#f1f5f9"), borderColor: active ? ACCENT : border, color: active ? ACCENT : muted }}>
            <IconAdjustmentsHorizontal size={12} color={active ? ACCENT : muted} />
            <span className="text-[7px] font-bold">{label}{active ? " ●" : ""}</span>
          </button>
        );

        const dropBase: React.CSSProperties = {
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50,
          minWidth: 220, background: isDark ? "#0d1420" : "#fff",
          border: `1px solid ${border}`, borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.24)", padding: 12,
        };

        return (
          <div ref={filterRef} className="flex flex-wrap items-center gap-2 mb-2">
            <div className="relative">
              {mkBtn("month", monthActive ? `MONTH: ${monthFilter}` : "MONTH", monthActive)}
              {openDrop === "month" && (
                <div style={dropBase}>
                  <div className="text-[7px] font-bold tracking-[1.5px] mb-2" style={{ ...MONO, color: muted }}>SELECT MONTH</div>
                  <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                    {months.map(m => (
                      <button key={m} onClick={() => { setMonthF(m); setOpenDrop(null); }}
                        className="text-left px-2 py-1.5 rounded-sm text-[8px] font-bold cursor-pointer transition-colors"
                        style={{ ...MONO, background: monthFilter === m ? `${ACCENT}18` : "transparent", color: monthFilter === m ? ACCENT : color, borderLeft: monthFilter === m ? `2px solid ${ACCENT}` : "2px solid transparent" }}>
                        {m === "ALL" ? "All months" : m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              {mkBtn("type", typeActive ? `TYPE: ${dirFilter}` : "TYPE", typeActive)}
              {openDrop === "type" && (
                <div style={dropBase}>
                  <div className="text-[7px] font-bold tracking-[1.5px] mb-2" style={{ ...MONO, color: muted }}>OPTION TYPE</div>
                  <div className="flex rounded-sm overflow-hidden border" style={{ borderColor: border }}>
                    {(["ALL", "CE", "PE"] as DirFilter[]).map(f => (
                      <button key={f} onClick={() => { setDirF(f); setOpenDrop(null); }}
                        className="flex-1 py-1.5 text-[8px] font-bold cursor-pointer transition-colors"
                        style={{ ...MONO, background: dirFilter === f ? (f === "CE" ? "#0284c7" : f === "PE" ? "#e11d48" : ACCENT) : "transparent", color: dirFilter === f ? "#fff" : muted }}>
                        {f === "ALL" ? "All" : f}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              {mkBtn("result", resActive ? `RESULT: ${resFilter === "T1" ? "T1 HIT" : resFilter === "T2" ? "T2 HIT" : resFilter}` : "RESULT", resActive)}
              {openDrop === "result" && (
                <div style={dropBase}>
                  <div className="text-[7px] font-bold tracking-[1.5px] mb-2" style={{ ...MONO, color: muted }}>RESULT FILTER</div>
                  <div className="flex flex-wrap gap-1">
                    {(["ALL", "T1", "T2", "PROFIT", "LOSS"] as ResultFilter[]).map(f => {
                      const fc = f === "PROFIT" ? "#16a34a" : f === "LOSS" ? "#e11d48" : f === "T1" ? "#d97706" : f === "T2" ? "#15803d" : ACCENT;
                      const active = resFilter === f;
                      return (
                        <button key={f} onClick={() => { setResF(f); setOpenDrop(null); }}
                          className="px-2.5 py-1 text-[8px] font-bold rounded-sm cursor-pointer border transition-colors"
                          style={{ ...MONO, background: active ? `${fc}18` : "transparent", borderColor: active ? fc : border, color: active ? fc : muted }}>
                          {f === "T1" ? "T1 HIT" : f === "T2" ? "T2 HIT" : f}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              {mkBtn("maxpts", maxPtsActive ? `MAX PTS ≥${maxPtsFilter}` : "MAX PTS", maxPtsActive)}
              {openDrop === "maxpts" && (
                <div style={dropBase}>
                  <div className="text-[7px] font-bold tracking-[1.5px] mb-2" style={{ ...MONO, color: muted }}>MIN MAX POINTS</div>
                  <div className="flex flex-wrap gap-1">
                    {MAX_PTS_OPTIONS.map(f => {
                      const active = maxPtsFilter === f;
                      return (
                        <button key={f} onClick={() => { setMaxPtsF(f); setOpenDrop(null); }}
                          className="px-2.5 py-1 text-[8px] font-bold rounded-sm cursor-pointer border transition-colors"
                          style={{ ...MONO, background: active ? `${ACCENT}18` : "transparent", borderColor: active ? ACCENT : border, color: active ? ACCENT : muted }}>
                          {f === "ALL" ? "All" : `≥ ${f}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              {mkBtn("cols", colsActive ? `COLS (${visCols.size}/${COL_DEFS.length})` : "COLUMNS", colsActive)}
              {openDrop === "cols" && (
                <div style={{ ...dropBase, minWidth: 260 }}>
                  <div className="text-[7px] font-bold tracking-[1.5px] mb-2" style={{ ...MONO, color: muted }}>VISIBLE COLUMNS</div>
                  <div className="flex flex-wrap gap-1">
                    {COL_DEFS.map(col => {
                      const vis = visCols.has(col.key);
                      return (
                        <button key={col.key}
                          onClick={() => setVisCols(prev => {
                            const next = new Set(prev);
                            if (vis && next.size > 1) next.delete(col.key); else next.add(col.key);
                            return next;
                          })}
                          className="px-2 py-1 text-[7px] font-bold rounded-sm cursor-pointer border transition-colors"
                          style={{ ...MONO, background: vis ? `${ACCENT}18` : "transparent", borderColor: vis ? ACCENT : border, color: vis ? ACCENT : muted }}>
                          {vis ? "✓ " : ""}{col.label}
                        </button>
                      );
                    })}
                  </div>
                  {colsActive && (
                    <button onClick={() => setVisCols(new Set(COL_DEFS.map(c => c.key)))}
                      className="mt-2 w-full text-[7px] font-bold py-1 rounded-sm border cursor-pointer"
                      style={{ ...MONO, borderColor: ACCENT, color: ACCENT, background: `${ACCENT}10` }}>
                      Show all columns
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border" style={{ background: isDark ? "#0f1923" : "#f1f5f9", borderColor: border }}>
              <span className="text-[7px] font-bold" style={{ ...MONO, color: muted }}>ROWS</span>
              <div className="flex gap-0.5">
                {[5, 10, 15, 20].map(n => (
                  <button key={n} onClick={() => { setPageSz(n); setPage(1); }}
                    className="w-6 h-5 text-[7px] font-bold rounded-sm cursor-pointer transition-colors"
                    style={{ ...MONO, background: pageSize === n ? ACCENT : "transparent", color: pageSize === n ? "#fff" : muted }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {anyActive && (
              <button onClick={() => { setMonthF("ALL"); setDirF("ALL"); setResF("ALL"); setMaxPtsF("ALL"); setVisCols(new Set(COL_DEFS.map(c => c.key))); setOpenDrop(null); }}
                className="text-[7px] font-bold px-2 py-1.5 rounded-lg border cursor-pointer"
                style={{ ...MONO, borderColor: "#e11d48", color: "#e11d48", background: isDark ? "#2d0505" : "#fff5f5" }}>
                ✕ Clear all
              </button>
            )}

            {wr !== null && (
              <div className="ml-auto flex items-center gap-3 flex-shrink-0">
                <span className="text-[8px] font-bold px-2 py-1 rounded-sm border"
                  style={{ ...MONO, background: isDark ? (Number(wr) >= 70 ? "#052e16" : "#2d0505") : (Number(wr) >= 70 ? "#f0fdf4" : "#fff5f5"), borderColor: Number(wr) >= 70 ? "#166534" : "#991b1b", color: wrClr }}>
                  {wr}% · <span style={{ color: "#16a34a" }}>{wins}W</span> / <span style={{ color: "#e11d48" }}>{losses}L</span>{eod > 0 ? ` · ${eod}E` : ""}
                </span>
                <span className="text-[15px] font-bold" style={{ ...BEBAS, color: pnlColor(lotPnL) }}>{fmtIndianFull(lotPnL)}</span>
              </div>
            )}
          </div>
        );
      })()}

      {loading && (
        <div className="py-10 flex flex-col items-center gap-2">
          <div className="text-[10px]" style={{ ...MONO, color: muted }}>Loading trades… {progress.total > 0 ? `${progress.done} / ${progress.total} dates` : ""}</div>
          {progress.total > 0 && (
            <div className="w-48 h-1 rounded-full overflow-hidden" style={{ background: isDark ? "#1e2a3a" : "#e2e8f0" }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${(progress.done / progress.total) * 100}%`, background: ACCENT }} />
            </div>
          )}
        </div>
      )}

      {!loading && allRows.length === 0 && <div className="py-10 text-center text-[10px]" style={{ ...MONO, color: muted }}>No live trades found</div>}
      {!loading && allRows.length > 0 && filtered.length === 0 && <div className="py-8 text-center text-[10px]" style={{ ...MONO, color: muted }}>No trades match the selected filters</div>}

      {!loading && filtered.length > 0 && (
        <div className="md:hidden space-y-3">
          {filtered.map((r, i) => {
            const pnl = parseFloat(r.PnL) || 0;
            const lPnl = pnl * LOT_QTY;
            const dc = dirColor(r.Direction);
            const isTimedExit = r.Status === "TIME_EXIT";
            const isWin = r.Status === "TARGET" || r.Status === "TIME_PROFIT" || (isTimedExit && pnl >= 0);
            const isLoss = r.Status === "SL" || (isTimedExit && pnl < 0);
            const isEod = r.Status === "EOD";
            const sc = isTimedExit ? (pnl >= 0 ? "#22c55e" : "#ef4444") : STATUS_COLOR[r.Status] ?? "#94a3b8";
            const t1Hit = r.T1Hit === "Y";
            const t2Hit = r.Status === "TARGET";
            const stIcon = r.Status === "TARGET" ? "🎯" : r.Status === "SL" ? "🛑" : r.Status === "EOD" ? "🕐" : r.Status === "TIME_PROFIT" || isTimedExit ? "⏱" : "⏳";
            const stLbl = r.Status === "TIME_PROFIT" ? "60M PROFIT" : isTimedExit ? "75M EXIT" : r.Status;
            const dateLbl = r._date ? (() => { const dc2 = fmtDateCell(r._date); return `${dc2.top} ${dc2.bot}`; })() : "";
            return (
              <div key={i} className="rounded-xl overflow-hidden"
                style={{ background: cardBg, border: `1px solid ${isWin ? "#22c55e33" : isLoss ? "#ef444433" : border}`, borderLeft: `3px solid ${isWin ? "#22c55e" : isLoss ? "#e11d48" : dc}` }}>
                <div className="px-3 py-3 flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-xl flex flex-col items-center justify-center flex-shrink-0" style={{ background: `${dc}18`, border: `1.5px solid ${dc}40` }}>
                      <span className="text-[7px] font-bold" style={{ ...MONO, color: muted }}>NI</span>
                      <span className="text-[12px] font-bold" style={{ ...BEBAS, color: dc }}>{r.Direction}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-bold" style={{ ...BEBAS, color }}>NIFTY {r.Strike} {r.Direction === "CE" ? "Call" : "Put"}</div>
                      <div className="text-[8px] mt-0.5" style={{ ...MONO, color: muted }}>{fmtTime(r.EntryTime)}{r.ExitTime ? ` → ${fmtTime(r.ExitTime)}` : " → ACTIVE"}</div>
                      <div className="text-[8px] font-bold mt-0.5" style={{ ...MONO, color: ACCENT }}>{dateLbl}</div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <span className="text-[7px] font-bold px-2 py-0.5 rounded-sm"
                      style={{ ...MONO, background: isWin ? (isDark ? "#052e16" : "#dcfce7") : isLoss ? (isDark ? "#2d0505" : "#fee2e2") : (isDark ? "#1c1500" : "#fef9c3"), color: isWin ? "#16a34a" : isLoss ? "#e11d48" : "#b45309", border: `1px solid ${isWin ? "#16a34a55" : isLoss ? "#e11d4855" : "#b4530955"}` }}>
                      {isWin ? "● WIN" : isLoss ? "● LOSS" : isEod ? "● EOD" : "● OPEN"}
                    </span>
                    <span className="text-[8px] font-bold px-2 py-0.5 rounded-full" style={{ ...MONO, background: `${sc}18`, color: sc, border: `1px solid ${sc}40` }}>{stIcon} {stLbl}</span>
                    <div className="flex gap-1">
                      {([["T1", t1Hit, "#d97706"], ["T2", t2Hit, "#15803d"]] as [string, boolean, string][]).map(([lbl, hit, clr]) => (
                        <span key={lbl} className="text-[7px] px-1.5 py-0.5 rounded-sm font-bold"
                          style={{ ...MONO, background: hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: hit ? clr : muted }}>
                          {lbl}{hit ? "✓" : "✗"}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="px-3 py-1.5 flex items-center gap-3 border-t" style={{ background: isDark ? "#080b0f" : "#fff", borderColor: border }}>
                  <span className="text-[9px] font-bold" style={{ ...MONO, color: "#d97706" }}>T1 ₹{r.Target1 ?? "—"}{t1Hit ? " ✓" : ""}</span>
                  <span className="text-[9px] font-bold" style={{ ...MONO, color: "#16a34a" }}>T2 ₹{r.Target2 ?? "—"}{t2Hit ? " ✓" : ""}</span>
                  {r.MaxPoints && parseFloat(r.MaxPoints) > 0 && <span className="text-[9px] font-bold" style={{ ...MONO, color: ACCENT }}>MAX +{r.MaxPoints}</span>}
                </div>
                <div className="grid grid-cols-3 border-t" style={{ gap: "1px", background: border }}>
                  {[
                    { label: "ENTRY", val: `₹${r.Entry}`, color: dc },
                    { label: "SL", val: `₹${r.SL}`, color: "#e11d48" },
                    { label: "LOT P&L", val: fmtIndianFull(lPnl), color: pnlColor(lPnl) },
                  ].map(({ label, val, color: c }) => (
                    <div key={label} className="px-3 py-2" style={{ background: cardBg }}>
                      <div className="text-[7px] mb-0.5" style={{ ...MONO, color: muted }}>{label}</div>
                      <div className="text-[11px] font-bold tabular-nums" style={{ ...MONO, color: c }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="hidden md:block rounded-xl border overflow-hidden" style={{ borderColor: border }}>
          <div className="overflow-auto" style={{ maxHeight: 540 }}>
            <div style={{ minWidth: 960 }}>
              <div className="grid border-b-2 sticky top-0 z-10" style={{ gridTemplateColumns: dynTCOLS, borderColor: isDark ? "#1e2a3a" : "#cbd5e1", background: isDark ? "#080d14" : "#f0f4f8" }}>
                <div className="px-2 py-2 text-[8px] font-bold tracking-[1.5px]" style={{ ...MONO, color: muted }}>#</div>
                {COL_DEFS.filter(c => visCols.has(c.key)).map(col => (
                  <div key={col.key} className="px-2 py-2 text-[8px] font-bold tracking-[1.5px] whitespace-nowrap" style={{ ...MONO, color: muted }}>
                    {col.key === "pnl" ? `P&L (${LOT_QTY}×)` : col.label}
                  </div>
                ))}
              </div>

              {pageRows.map((r, i) => {
                const absIdx = (page - 1) * pageSize + i + 1;
                const pnl = parseFloat(r.PnL) || 0;
                const lPnl = pnl * LOT_QTY;
                const pnlPct = parseFloat(r.PnLPct) || 0;
                const isTimedExit2 = r.Status === "TIME_EXIT";
                const isWin = r.Status === "TARGET" || r.Status === "TIME_PROFIT" || (isTimedExit2 && pnl >= 0);
                const isLoss = r.Status === "SL" || (isTimedExit2 && pnl < 0);
                const isEod = r.Status === "EOD";
                const dc = dirColor(r.Direction);
                const stClr = isWin ? "#16a34a" : isLoss ? "#e11d48" : isEod ? "#b45309" : "#0284c7";
                const t1Hit = r.T1Hit === "Y";
                const t2Hit = r.Status === "TARGET";
                const entry = parseFloat(r.Entry) || 0;
                const chg = calcCharges(entry, entry + pnl, LOT_QTY);
                const rowBg = i % 2 === 0 ? rowEven : rowOdd;
                const dc2 = r._date ? fmtDateCell(r._date) : null;

                return (
                  <div key={i} className="grid border-b items-center" style={{ gridTemplateColumns: dynTCOLS, background: rowBg, borderColor: isDark ? "#0f1923" : "#f1f5f9", minHeight: 36 }}>
                    <div className="px-2 text-[9px] tabular-nums" style={{ ...MONO, color: muted }}>{absIdx}</div>
                    {visCols.has("date") && (
                      <div className="px-2 text-[9px] font-bold whitespace-nowrap" style={{ ...MONO, color }}>{dc2 ? `${dc2.top} '${dc2.bot.slice(2)}` : "—"}</div>
                    )}
                    {visCols.has("time") && (
                      <div className="px-2 text-[9px] whitespace-nowrap" style={{ ...MONO, color }}>
                        <span className="font-bold">{fmtTime(r.EntryTime)}</span>
                        <span style={{ color: muted }}> → {fmtTime(r.ExitTime)}</span>
                      </div>
                    )}
                    {visCols.has("concepts") && (
                      <div className="px-2 flex items-center gap-1 overflow-hidden">
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-sm flex-shrink-0" style={{ ...MONO, background: `${dc}18`, color: dc, border: `1px solid ${dc}30` }}>{r.Direction}</span>
                        {r.Concepts && r.Concepts.split(",").slice(0, 2).map((c: string) => (
                          <span key={c} className="text-[7px] px-1 py-0.5 rounded-sm font-bold truncate flex-shrink-0" style={{ ...MONO, background: isDark ? "#1e2a3a" : "#f1f5f9", color: muted }}>{c.trim()}</span>
                        ))}
                      </div>
                    )}
                    {visCols.has("strike") && (
                      <div className="px-2 text-[9px] font-bold whitespace-nowrap tabular-nums" style={{ ...MONO, color: dc }}>{r.Strike} {r.Direction}</div>
                    )}
                    {visCols.has("entry") && <div className="px-2 text-[10px] font-bold tabular-nums" style={{ ...MONO, color: dc }}>₹{r.Entry}</div>}
                    {visCols.has("sl") && <div className="px-2 text-[10px] font-bold tabular-nums" style={{ ...MONO, color: "#e11d48" }}>₹{r.SL}</div>}
                    {visCols.has("t1") && (
                      <div className="px-2 flex items-center gap-1">
                        <span className="text-[10px] font-bold tabular-nums" style={{ ...MONO, color: "#d97706" }}>₹{r.Target1}</span>
                        <span className="text-[7px] font-bold px-1 py-0.5 rounded-sm flex-shrink-0" style={{ ...MONO, background: t1Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t1Hit ? "#15803d" : muted }}>{t1Hit ? "✓" : "✗"}</span>
                      </div>
                    )}
                    {visCols.has("t2") && (
                      <div className="px-2 flex items-center gap-1">
                        <span className="text-[10px] font-bold tabular-nums" style={{ ...MONO, color: "#16a34a" }}>₹{r.Target2}</span>
                        <span className="text-[7px] font-bold px-1 py-0.5 rounded-sm flex-shrink-0" style={{ ...MONO, background: t2Hit ? (isDark ? "#052e16" : "#dcfce7") : (isDark ? "#0f1923" : "#f1f5f9"), color: t2Hit ? "#15803d" : muted }}>{t2Hit ? "✓" : "✗"}</span>
                      </div>
                    )}
                    {visCols.has("result") && (
                      <div className="px-2 flex items-center gap-1 overflow-hidden">
                        <span className="text-[7px] font-bold px-1.5 py-0.5 rounded-sm flex-shrink-0"
                          style={{ ...MONO, background: isWin ? (isDark ? "#052e16" : "#dcfce7") : isLoss ? (isDark ? "#2d0505" : "#fee2e2") : (isDark ? "#1c1500" : "#fef9c3"), color: isWin ? "#16a34a" : isLoss ? "#e11d48" : "#b45309", border: `1px solid ${isWin ? "#16a34a44" : isLoss ? "#e11d4844" : "#b4530944"}` }}>
                          {isWin ? "WIN" : isLoss ? "LOSS" : isEod ? "EOD" : "OPEN"}
                        </span>
                        <span className="text-[9px] flex-shrink-0">{r.Status === "TARGET" ? "🎯" : r.Status === "SL" ? "🛑" : isEod ? "🕐" : r.Status === "TIME_PROFIT" || r.Status === "TIME_EXIT" ? "⏱" : "⏳"}</span>
                        <span className="text-[8px] font-bold truncate" style={{ ...MONO, color: stClr }}>{r.Status === "TIME_PROFIT" ? "60M PROFIT" : r.Status === "TIME_EXIT" ? "75M EXIT" : r.Status}</span>
                      </div>
                    )}
                    {visCols.has("maxpts") && (
                      <div className="px-2 text-[10px] font-bold tabular-nums whitespace-nowrap" style={{ ...MONO, color: ACCENT }}>{r.MaxPoints && parseFloat(r.MaxPoints) > 0 ? `+${r.MaxPoints}` : "—"}</div>
                    )}
                    {visCols.has("charges") && (
                      <div className="px-2 text-[10px] font-bold tabular-nums whitespace-nowrap" style={{ ...MONO, color: "#b45309" }}>{fmtIndianFull(-chg)}</div>
                    )}
                    {visCols.has("pnl") && (
                      <div className="px-2 flex items-baseline gap-1 overflow-hidden">
                        <span className="text-[10px] font-bold tabular-nums whitespace-nowrap" style={{ ...MONO, color: pnlColor(lPnl) }}>{fmtIndianFull(lPnl)}</span>
                        <span className="text-[8px] tabular-nums" style={{ ...MONO, color: pnlColor(lPnl) }}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between px-4 py-2.5 border-t" style={{ borderColor: border, background: isDark ? "#080b0f" : "#fff" }}>
            <span className="text-[8px]" style={{ ...MONO, color: muted }}>
              {filtered.length === 0 ? "0 trades" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)} of ${filtered.length} trades`}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(1)} disabled={page === 1} className="w-6 h-6 flex items-center justify-center rounded text-[10px] font-bold cursor-pointer disabled:opacity-30" style={{ ...MONO, background: isDark ? "#0f1923" : "#f1f5f9", color }}>«</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="w-6 h-6 flex items-center justify-center rounded text-[11px] font-bold cursor-pointer disabled:opacity-30" style={{ ...MONO, background: isDark ? "#0f1923" : "#f1f5f9", color }}>‹</button>
              {Array.from({ length: totalPages }, (_, idx) => idx + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                .reduce<(number | "…")[]>((acc, p, i, arr) => {
                  if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("…");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) => p === "…"
                  ? <span key={`e${i}`} className="text-[9px] px-1" style={{ ...MONO, color: muted }}>…</span>
                  : <button key={p} onClick={() => setPage(p as number)} className="w-6 h-6 flex items-center justify-center rounded text-[9px] font-bold cursor-pointer" style={{ ...MONO, background: page === p ? ACCENT : (isDark ? "#0f1923" : "#f1f5f9"), color: page === p ? "#fff" : color }}>{p}</button>
                )}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="w-6 h-6 flex items-center justify-center rounded text-[11px] font-bold cursor-pointer disabled:opacity-30" style={{ ...MONO, background: isDark ? "#0f1923" : "#f1f5f9", color }}>›</button>
              <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="w-6 h-6 flex items-center justify-center rounded text-[10px] font-bold cursor-pointer disabled:opacity-30" style={{ ...MONO, background: isDark ? "#0f1923" : "#f1f5f9", color }}>»</button>
            </div>
            <span className="text-[8px]" style={{ ...MONO, color: muted }}>Page {page} / {totalPages}</span>
          </div>

          <div className="border-t" style={{ borderColor: border }}>
            <div className="grid grid-cols-4 sm:grid-cols-7" style={{ gap: "1px", background: border }}>
              {[
                { label: "TRADES", val: `${filtered.length}`, color: isDark ? "#94a3b8" : "#475569" },
                { label: "WIN / TARGET", val: `${wins}`, color: "#16a34a" },
                { label: "LOSS / SL", val: `${losses}`, color: "#e11d48" },
                { label: "EOD", val: `${eod}`, color: "#b45309" },
                { label: "WIN RATE", val: wr ? `${wr}%` : "—", color: wrClr },
                { label: `LOT P&L (${LOT_QTY}×)`, val: fmtIndianFull(lotPnL), color: pnlColor(lotPnL) },
                { label: "TOTAL CHARGES", val: fmtIndianFull(-totCharges), color: "#b45309" },
              ].map(({ label, val, color: c }) => (
                <div key={label} className="px-3 py-2.5" style={{ background: isDark ? "#0a0f16" : "#fff" }}>
                  <div className="text-[7px] tracking-[1.5px] mb-1" style={{ ...MONO, color: muted }}>{label}</div>
                  <div className="text-[13px] font-bold leading-tight" style={{ ...MONO, color: c }}>{val}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main journal page ──────────────────────────────────────────────────────

export default function JournalPage() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const acctQty = useAccountQty(NUM_LOTS);
  const LOT_QTY = LOT_SIZE * acctQty;

  const [viewType, setViewType] = useState<ViewType>("month");
  const [strategy, setStrategy] = useState<"smc" | "vwap930">("smc");
  const holidaysMap = useHolidaysMap();
  const [summary, setSummary] = useState<DaySummary[]>([]);
  const [summaryMap, setSummaryMap] = useState<Record<string, DaySummary>>({});
  const [calMonth, setCalMonth] = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() + 1 }; });
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());

  const bg = isDark ? "#080b0f" : "#fff";
  const color = isDark ? "#e2e8f0" : "#1e293b";
  const border = isDark ? "#1e2a3a" : "#e2e8f0";
  const muted = isDark ? "#4a6080" : "#94a3b8";

  useEffect(() => {
    fetch(`/api/results/summary?type=live&strategy=${strategy}`)
      .then(r => r.json())
      .then(d => {
        const arr: DaySummary[] = d.summary ?? [];
        setSummary(arr);
        const m: Record<string, DaySummary> = {};
        for (const s of arr) m[s.date] = s;
        setSummaryMap(m);
      })
      .catch(() => {});
  }, [strategy]);

  const monthSummary = useMemo(() => {
    const prefix = `${calMonth.year}-${String(calMonth.month).padStart(2, "0")}`;
    return summary.filter(s => s.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date));
  }, [summary, calMonth]);

  const monthStats = useMemo(() => {
    const totalPnL = monthSummary.reduce((s, d) => s + d.totalPnL * LOT_QTY, 0);
    const trades = monthSummary.reduce((s, d) => s + d.trades, 0);
    const wins = monthSummary.reduce((s, d) => s + d.wins, 0);
    const profit = monthSummary.filter(d => d.totalPnL >= 0).reduce((s, d) => s + d.totalPnL * LOT_QTY, 0);
    const loss = monthSummary.filter(d => d.totalPnL < 0).reduce((s, d) => s + d.totalPnL * LOT_QTY, 0);
    return { totalPnL, trades, wins, profit, loss, days: monthSummary.length };
  }, [monthSummary, LOT_QTY]);

  const monthBarData: BarEntry[] = useMemo(() => monthSummary.map(d => {
    const day = parseInt(d.date.slice(8), 10);
    const mon = MONTH_SHORT[parseInt(d.date.slice(5, 7), 10) - 1];
    const yr = d.date.slice(0, 4);
    return { key: d.date, label: `${day} ${mon}`, lot: d.totalPnL * LOT_QTY, trades: d.trades, wins: d.wins, tipLine2: `${day} ${mon} ${yr}` };
  }), [monthSummary, LOT_QTY]);

  const yearMonthGrid = useMemo(() => Array.from({ length: 12 }, (_, idx) => {
    const prefix = `${calYear}-${String(idx + 1).padStart(2, "0")}`;
    const days = summary.filter(s => s.date.startsWith(prefix));
    const lot = days.reduce((s, d) => s + d.totalPnL * LOT_QTY, 0);
    const trades = days.reduce((s, d) => s + d.trades, 0);
    const wins = days.reduce((s, d) => s + d.wins, 0);
    return { monthIdx: idx, lot, trades, wins, hasData: trades > 0 };
  }), [summary, calYear, LOT_QTY]);

  const yearBarData: BarEntry[] = useMemo(() => yearMonthGrid.filter(d => d.hasData).map(d => ({
    key: `${calYear}-${d.monthIdx}`, label: MONTH_SHORT[d.monthIdx], lot: d.lot, trades: d.trades, wins: d.wins, tipLine2: `${MONTH_NAMES[d.monthIdx]} ${calYear}`,
  })), [yearMonthGrid, calYear]);

  const yearStats = useMemo(() => {
    const active = yearMonthGrid.filter(d => d.hasData);
    const totalPnL = active.reduce((s, d) => s + d.lot, 0);
    const trades = active.reduce((s, d) => s + d.trades, 0);
    const wins = active.reduce((s, d) => s + d.wins, 0);
    const profit = active.filter(d => d.lot >= 0).reduce((s, d) => s + d.lot, 0);
    const loss = active.filter(d => d.lot < 0).reduce((s, d) => s + d.lot, 0);
    return { totalPnL, trades, wins, profit, loss, months: active.length };
  }, [yearMonthGrid]);

  const overallYearData: BarEntry[] = useMemo(() => {
    const years = [...new Set(summary.map(s => s.date.slice(0, 4)))].sort();
    return years.map(yr => {
      const days = summary.filter(s => s.date.startsWith(yr));
      const lot = days.reduce((s, d) => s + d.totalPnL * LOT_QTY, 0);
      const trades = days.reduce((s, d) => s + d.trades, 0);
      const wins = days.reduce((s, d) => s + d.wins, 0);
      return { key: yr, label: yr, lot, trades, wins, tipLine2: yr };
    });
  }, [summary, LOT_QTY]);

  const overallStats = useMemo(() => {
    const totalPnL = overallYearData.reduce((s, d) => s + d.lot, 0);
    const trades = overallYearData.reduce((s, d) => s + d.trades, 0);
    const wins = overallYearData.reduce((s, d) => s + d.wins, 0);
    const profit = overallYearData.filter(d => d.lot >= 0).reduce((s, d) => s + d.lot, 0);
    const loss = overallYearData.filter(d => d.lot < 0).reduce((s, d) => s + d.lot, 0);
    return { totalPnL, trades, wins, profit, loss };
  }, [overallYearData]);

  const winRateFmt = (wins: number, trades: number) => trades > 0 ? `${((wins / trades) * 100).toFixed(0)}%` : "—";
  const winRateColor = (wins: number, trades: number) => trades > 0 && wins / trades >= 0.7 ? "#16a34a" : "#e11d48";

  return (
    <div className="h-full overflow-auto" style={{ background: bg, color }}>
      <div className="px-3 sm:px-5 pb-8 flex flex-col gap-5">

        <div className="flex items-center gap-2 pt-4">
          {(["month", "year", "overall"] as ViewType[]).map(v => (
            <button key={v} onClick={() => setViewType(v)}
              className="px-3 py-1.5 text-[9px] font-bold tracking-[1.5px] rounded-sm border cursor-pointer transition-colors uppercase"
              style={{ ...MONO, background: viewType === v ? ACCENT : (isDark ? "#0f1923" : "#f8fafc"), borderColor: viewType === v ? ACCENT : (isDark ? "#2a3a4a" : "#cbd5e1"), color: viewType === v ? "#fff" : (isDark ? "#4a6080" : "#64748b") }}>
              {v === "overall" ? "ALL TIME" : v}
            </button>
          ))}

          <div className="flex border rounded-sm overflow-hidden flex-shrink-0" style={{ borderColor: isDark ? "#2a3a4a" : "#cbd5e1" }}>
            {(["smc", "vwap930"] as const).map(s => (
              <button key={s} onClick={() => setStrategy(s)}
                className="px-2 sm:px-3 py-1.5 text-[9px] font-bold tracking-[1px] cursor-pointer transition-colors whitespace-nowrap"
                style={{ ...MONO, background: strategy === s ? "#0d9488" : "transparent", color: strategy === s ? "#fff" : (isDark ? "#4a6080" : "#64748b") }}>
                {s === "smc" ? "SMC" : "VWAP 9:30"}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {viewType === "month" && <>
              <button onClick={() => setCalMonth(m => { const d = new Date(m.year, m.month - 2, 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })}
                className="w-7 h-7 flex items-center justify-center rounded cursor-pointer font-bold" style={{ background: isDark ? "#0f1923" : "#f1f5f9", color }}>‹</button>
              <span className="text-[11px] font-bold tracking-[1.5px]" style={{ ...MONO, color, minWidth: 120, textAlign: "center" }}>{MONTH_SHORT[calMonth.month - 1]} {calMonth.year}</span>
              <button onClick={() => setCalMonth(m => { const d = new Date(m.year, m.month, 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })}
                className="w-7 h-7 flex items-center justify-center rounded cursor-pointer font-bold" style={{ background: isDark ? "#0f1923" : "#f1f5f9", color }}>›</button>
            </>}
            {viewType === "year" && <>
              <button onClick={() => setCalYear(y => y - 1)} className="w-7 h-7 flex items-center justify-center rounded cursor-pointer font-bold" style={{ background: isDark ? "#0f1923" : "#f1f5f9", color }}>‹</button>
              <span className="text-[11px] font-bold tracking-[1.5px]" style={{ ...MONO, color, minWidth: 60, textAlign: "center" }}>{calYear}</span>
              <button onClick={() => setCalYear(y => y + 1)} className="w-7 h-7 flex items-center justify-center rounded cursor-pointer font-bold" style={{ background: isDark ? "#0f1923" : "#f1f5f9", color }}>›</button>
            </>}
            {viewType === "overall" && (
              <span className="text-[9px] font-bold tracking-[2px] px-2 py-1 rounded-sm" style={{ ...MONO, color: ACCENT, background: `${ACCENT}18`, border: `1px solid ${ACCENT}40` }}>▶ LIVE · ALL TIME</span>
            )}
          </div>
        </div>

        {viewType === "month" && <>
          <ChartsPanel
            profit={monthStats.profit} loss={monthStats.loss} barData={monthBarData} isDark={isDark} border={border}
            donutFooter={monthStats.days > 0 ? [
              { label: "PROFIT DAYS", val: `${monthSummary.filter(d => d.totalPnL >= 0).length}`, color: "#16a34a" },
              { label: "LOSS DAYS", val: `${monthSummary.filter(d => d.totalPnL < 0).length}`, color: "#e11d48" },
            ] : []}
            barFooter={monthStats.days > 0 ? [
              { label: "TRADE DAYS", val: `${monthStats.days}`, color: isDark ? "#94a3b8" : "#475569" },
              { label: "WIN RATE", val: winRateFmt(monthStats.wins, monthStats.trades), color: winRateColor(monthStats.wins, monthStats.trades) },
              { label: "NET P&L", val: fmtIndianFull(monthStats.totalPnL), color: pnlColor(monthStats.totalPnL) },
            ] : []}
          />

          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[9px] font-bold tracking-[2px]" style={{ ...MONO, color: ACCENT }}>▶ LIVE</span>
              <span className="text-[9px] font-bold tracking-[1.5px]" style={{ ...MONO, color: muted }}>CALENDAR</span>
            </div>
            <div className="rounded-lg border overflow-hidden" style={{ borderColor: border }}>
              <div className="grid grid-cols-7 gap-px p-1" style={{ background: isDark ? "#1a2332" : "#e2e8f0" }}>
                {DAY_NAMES.map(d => (
                  <div key={d} className="text-center text-[8px] md:text-[11px] font-bold tracking-[1.5px] py-1.5" style={{ ...MONO, color: isDark ? "#94a3b8" : "#475569", background: isDark ? "#1a2332" : "#e2e8f0" }}>{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1 p-1" style={{ background: isDark ? "#080b0f" : "#fff" }}>
                {buildCalendar(calMonth.year, calMonth.month).map((day, i) => {
                  if (!day) return <div key={i} className="min-h-[56px] sm:min-h-[72px]" />;
                  const dateStr = `${calMonth.year}-${String(calMonth.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const data = summaryMap[dateStr];
                  const lotPnl = data ? data.totalPnL * LOT_QTY : null;
                  const hasData = !!data;
                  const isToday = dateStr === new Date().toISOString().slice(0, 10);
                  const holiday = holidaysMap[dateStr];
                  const isHoliday = !!holiday && !hasData;
                  const cellBg = hasData ? (lotPnl! >= 0 ? "rgba(22,163,74,0.10)" : "rgba(225,29,72,0.10)") : isHoliday ? "rgba(251,191,36,0.35)" : "rgba(100,116,139,0.07)";
                  const cellBc = isToday ? ACCENT : hasData ? (lotPnl! >= 0 ? "rgba(22,163,74,0.6)" : "rgba(225,29,72,0.6)") : isHoliday ? "rgba(251,191,36,0.6)" : "rgba(100,116,139,0.2)";
                  return (
                    <div key={i} className="rounded-lg p-1.5 sm:p-2 min-h-[56px] sm:min-h-[72px] flex flex-col" style={{ background: cellBg, border: `${isToday ? "2px" : "1px"} solid ${cellBc}` }}>
                      <span className="text-[10px] md:text-[12px] font-bold" style={{ ...MONO, color: isToday ? ACCENT : (isDark ? "#cbd5e1" : "#334155") }}>{day}</span>
                      {isHoliday && <span className="text-[9px] font-bold leading-tight mt-0.5 break-words" style={{ ...MONO, color: "#b45309" }}>{holiday}</span>}
                      {hasData && lotPnl !== null && <>
                        <span className="text-[8px] md:text-[9px] font-bold mt-auto leading-tight break-all" style={{ ...MONO, color: lotPnl >= 0 ? "#16a34a" : "#e11d48" }}>{fmtIndianFull(lotPnl)}</span>
                        <span className="text-[7px] font-bold mt-0.5 flex gap-1 flex-wrap" style={MONO}>
                          <span style={{ color: isDark ? "#94a3b8" : "#475569" }}>{data.trades}T</span>
                          <span style={{ color: "#16a34a" }}>{data.wins}W</span>
                          <span style={{ color: "#e11d48" }}>{data.trades - data.wins}L</span>
                        </span>
                      </>}
                    </div>
                  );
                })}
              </div>
            </div>
            {monthStats.days > 0 ? (
              <div className="mt-3 rounded-xl overflow-hidden border" style={{ borderColor: border, background: isDark ? "#0d1420" : "#f8fafc" }}>
                <StatsRow isDark={isDark} border={border} cols={[
                  { label: "TRADE DAYS", val: `${monthStats.days}`, color: isDark ? "#94a3b8" : "#475569" },
                  { label: "WIN / LOSS", val: `${monthStats.wins}W · ${monthStats.trades - monthStats.wins}L`, color: winRateColor(monthStats.wins, monthStats.trades) },
                  { label: "WIN RATE", val: winRateFmt(monthStats.wins, monthStats.trades), color: winRateColor(monthStats.wins, monthStats.trades) },
                  { label: "MONTH P&L", val: fmtIndianFull(monthStats.totalPnL), color: pnlColor(monthStats.totalPnL) },
                ]} />
              </div>
            ) : (
              <div className="mt-4 text-center text-[10px]" style={{ ...MONO, color: muted }}>No live data for {MONTH_NAMES[calMonth.month - 1]} {calMonth.year}</div>
            )}
          </div>
        </>}

        {viewType === "year" && <>
          <ChartsPanel
            profit={yearStats.profit} loss={yearStats.loss} barData={yearBarData} barHeader="MONTH-WISE P&L" isDark={isDark} border={border}
            donutFooter={yearStats.months > 0 ? [
              { label: "PROFIT MONTHS", val: `${yearMonthGrid.filter(d => d.hasData && d.lot >= 0).length}`, color: "#16a34a" },
              { label: "LOSS MONTHS", val: `${yearMonthGrid.filter(d => d.hasData && d.lot < 0).length}`, color: "#e11d48" },
            ] : []}
            barFooter={yearStats.months > 0 ? [
              { label: "ACTIVE MONTHS", val: `${yearStats.months}`, color: isDark ? "#94a3b8" : "#475569" },
              { label: "WIN RATE", val: winRateFmt(yearStats.wins, yearStats.trades), color: winRateColor(yearStats.wins, yearStats.trades) },
              { label: "YEAR P&L", val: fmtIndianFull(yearStats.totalPnL), color: pnlColor(yearStats.totalPnL) },
            ] : []}
          />

          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[9px] font-bold tracking-[2px]" style={{ ...MONO, color: ACCENT }}>▶ LIVE</span>
              <span className="text-[9px] font-bold tracking-[1.5px]" style={{ ...MONO, color: muted }}>MONTHLY BREAKDOWN · {calYear}</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {yearMonthGrid.map(({ monthIdx, lot, trades, wins, hasData }) => {
                const cellBg = hasData ? (lot >= 0 ? "rgba(22,163,74,0.10)" : "rgba(225,29,72,0.10)") : "rgba(100,116,139,0.07)";
                const cellBc = hasData ? (lot >= 0 ? "rgba(22,163,74,0.5)" : "rgba(225,29,72,0.5)") : "rgba(100,116,139,0.2)";
                return (
                  <div key={monthIdx} className="rounded-lg p-3 flex flex-col gap-0.5" style={{ background: cellBg, border: `1px solid ${cellBc}` }}>
                    <span className="text-[13px] font-bold" style={{ ...BEBAS, color: isDark ? "#cbd5e1" : "#334155" }}>{MONTH_NAMES[monthIdx]}</span>
                    {hasData ? <>
                      <span className="text-[9px] font-bold leading-tight break-all" style={{ ...MONO, color: lot >= 0 ? "#16a34a" : "#e11d48" }}>{fmtIndianFull(lot)}</span>
                      <span className="text-[7px] font-bold mt-0.5 flex gap-1 flex-wrap" style={MONO}>
                        <span style={{ color: isDark ? "#94a3b8" : "#475569" }}>{trades}T</span>
                        <span style={{ color: "#16a34a" }}>{wins}W</span>
                        <span style={{ color: "#e11d48" }}>{trades - wins}L</span>
                        <span style={{ color: winRateColor(wins, trades) }}>{((wins / trades) * 100).toFixed(0)}%</span>
                      </span>
                    </> : (
                      <span className="text-[9px] mt-1" style={{ ...MONO, color: muted }}>— no data</span>
                    )}
                  </div>
                );
              })}
            </div>
            {yearStats.months > 0 && (
              <div className="mt-3 rounded-xl overflow-hidden border" style={{ borderColor: border, background: isDark ? "#0d1420" : "#f8fafc" }}>
                <StatsRow isDark={isDark} border={border} cols={[
                  { label: "ACTIVE MONTHS", val: `${yearStats.months}`, color: isDark ? "#94a3b8" : "#475569" },
                  { label: "WIN / LOSS", val: `${yearStats.wins}W · ${yearStats.trades - yearStats.wins}L`, color: winRateColor(yearStats.wins, yearStats.trades) },
                  { label: "WIN RATE", val: winRateFmt(yearStats.wins, yearStats.trades), color: winRateColor(yearStats.wins, yearStats.trades) },
                  { label: "YEAR P&L", val: fmtIndianFull(yearStats.totalPnL), color: pnlColor(yearStats.totalPnL) },
                ]} />
              </div>
            )}
            {yearStats.months === 0 && <div className="mt-4 text-center text-[10px]" style={{ ...MONO, color: muted }}>No live data for {calYear}</div>}
          </div>
        </>}

        {viewType === "overall" && <>
          <ChartsPanel
            profit={overallStats.profit} loss={overallStats.loss} barData={overallYearData} barHeader="YEAR-WISE P&L" isDark={isDark} border={border} donutLabel="All-Time P&L"
            donutFooter={overallYearData.length > 0 ? [
              { label: "PROFIT YEARS", val: `${overallYearData.filter(d => d.lot >= 0).length}`, color: "#16a34a" },
              { label: "LOSS YEARS", val: `${overallYearData.filter(d => d.lot < 0).length}`, color: "#e11d48" },
            ] : []}
            barFooter={overallYearData.length > 0 ? [
              { label: "TOTAL YEARS", val: `${overallYearData.length}`, color: isDark ? "#94a3b8" : "#475569" },
              { label: "WIN RATE", val: winRateFmt(overallStats.wins, overallStats.trades), color: winRateColor(overallStats.wins, overallStats.trades) },
              { label: "ALL-TIME P&L", val: fmtIndianFull(overallStats.totalPnL), color: pnlColor(overallStats.totalPnL) },
            ] : []}
          />

          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[9px] font-bold tracking-[2px]" style={{ ...MONO, color: ACCENT }}>▶ LIVE</span>
              <span className="text-[9px] font-bold tracking-[1.5px]" style={{ ...MONO, color: muted }}>YEARLY BREAKDOWN</span>
            </div>
            {overallYearData.length > 0 ? <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {overallYearData.map(d => {
                  const cellBg = d.lot >= 0 ? "rgba(22,163,74,0.10)" : "rgba(225,29,72,0.10)";
                  const cellBc = d.lot >= 0 ? "rgba(22,163,74,0.5)" : "rgba(225,29,72,0.5)";
                  const losses = d.trades - d.wins;
                  return (
                    <div key={d.key} className="rounded-xl p-4 flex flex-col gap-1" style={{ background: cellBg, border: `1px solid ${cellBc}` }}>
                      <span className="text-[28px] font-bold leading-none" style={{ ...BEBAS, color: isDark ? "#e2e8f0" : "#1e293b" }}>{d.label}</span>
                      <span className="text-[11px] font-bold mt-1" style={{ ...MONO, color: pnlColor(d.lot) }}>{fmtIndianFull(d.lot)}</span>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {[
                          { label: "TRADES", val: `${d.trades}`, color: isDark ? "#94a3b8" : "#475569" },
                          { label: "WIN", val: `${d.wins}`, color: "#16a34a" },
                          { label: "LOSS", val: `${losses}`, color: "#e11d48" },
                          { label: "WR", val: winRateFmt(d.wins, d.trades), color: winRateColor(d.wins, d.trades) },
                        ].map(({ label, val, color: c }) => (
                          <div key={label} className="flex flex-col">
                            <span className="text-[6px] tracking-[1px]" style={{ ...MONO, color: muted }}>{label}</span>
                            <span className="text-[12px] font-bold" style={{ ...MONO, color: c }}>{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 rounded-xl overflow-hidden border" style={{ borderColor: border, background: isDark ? "#0d1420" : "#f8fafc" }}>
                <StatsRow isDark={isDark} border={border} cols={[
                  { label: "TOTAL YEARS", val: `${overallYearData.length}`, color: isDark ? "#94a3b8" : "#475569" },
                  { label: "WIN / LOSS", val: `${overallStats.wins}W · ${overallStats.trades - overallStats.wins}L`, color: winRateColor(overallStats.wins, overallStats.trades) },
                  { label: "WIN RATE", val: winRateFmt(overallStats.wins, overallStats.trades), color: winRateColor(overallStats.wins, overallStats.trades) },
                  { label: "ALL-TIME P&L", val: fmtIndianFull(overallStats.totalPnL), color: pnlColor(overallStats.totalPnL) },
                ]} />
              </div>
            </> : (
              <div className="mt-4 text-center text-[10px]" style={{ ...MONO, color: muted }}>No live data found</div>
            )}
          </div>
        </>}

        <JournalTradesSection isDark={isDark} border={border} color={color} muted={muted} strategy={strategy} />

      </div>
    </div>
  );
}
