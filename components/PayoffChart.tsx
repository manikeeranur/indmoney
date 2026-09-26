"use client";

// ─── Payoff diagram ─────────────────────────────────────────────────────────
// New feature, not a port: frontend/app/options/page.tsx's drawPayoffChart +
// PayoffPanel (~4724-5083, single-leg P&L-at-expiry canvas) are dead code in
// the original — defined but never rendered from any button or tab, unlike
// the basket/strategy panel's live text stats (max profit/breakeven/max
// loss), which already exist here in OptionChain.tsx. Built anyway as a
// genuinely new, theme-aware addition (the original's canvas was hardcoded
// white-only) since the visualization is useful on its own merits — same
// intrinsic-value-at-expiry math, zone tints, strike/breakeven/spot markers
// and stats bar as the original, just reachable this time via a button on
// each chain row.
import { useEffect, useRef } from "react";
import { useTheme } from "@/lib/theme";

export type PayoffTarget = { strike: number; type: "CE" | "PE"; ltp: number; lotSize: number };

function drawPayoffChart(canvas: HTMLCanvasElement, strike: number, type: "CE" | "PE", spot: number, entry: number, lotSize: number, isDark: boolean, indexLabel: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W < 20 || H < 20) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const bg = isDark ? "#0f172a" : "#ffffff";
  const grid = isDark ? "#1e293b" : "#f1f5f9";
  const axisText = isDark ? "#64748b" : "#94a3b8";
  const border = isDark ? "#1e293b" : "#e2e8f0";
  const zeroLine = isDark ? "#334155" : "#cbd5e1";

  const P = { t: 44, r: 76, b: 56, l: 76 };
  const cw = W - P.l - P.r, ch = H - P.t - P.b;

  const halfRange = Math.max(spot * 0.105, 1500);
  const minP = spot - halfRange, maxP = spot + halfRange;

  const N = 500;
  const pts: { px: number; pnl: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const price = minP + (i / N) * (maxP - minP);
    const intr = type === "CE" ? Math.max(0, price - strike) : Math.max(0, strike - price);
    pts.push({ px: price, pnl: (intr - entry) * lotSize });
  }

  const maxPnL = Math.max(...pts.map(d => d.pnl));
  const minPnL = Math.min(...pts.map(d => d.pnl));
  const pnlSpan = maxPnL - minPnL || 1;
  const yLo = minPnL - pnlSpan * 0.15, yHi = maxPnL + pnlSpan * 0.15;

  const toX = (p: number) => P.l + ((p - minP) / (maxP - minP)) * cw;
  const toY = (pnl: number) => P.t + (1 - (pnl - yLo) / (yHi - yLo)) * ch;
  const zeroY = toY(0);

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const zClip = Math.max(P.t, Math.min(P.t + ch, zeroY));
  ctx.fillStyle = isDark ? "rgba(22,163,74,0.08)" : "rgba(22,163,74,0.04)";
  ctx.fillRect(P.l, P.t, cw, zClip - P.t);
  ctx.fillStyle = isDark ? "rgba(225,29,72,0.08)" : "rgba(225,29,72,0.04)";
  ctx.fillRect(P.l, zClip, cw, P.t + ch - zClip);

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const x = P.l + (i / 8) * cw;
    ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, P.t + ch); ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = P.t + (i / 5) * ch;
    ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + cw, y); ctx.stroke();
  }

  ctx.fillStyle = axisText;
  ctx.font = "9px 'Space Mono', monospace";
  ctx.textAlign = "center";
  for (let i = 0; i <= 8; i++) {
    const p = minP + (i / 8) * (maxP - minP);
    ctx.fillText(Math.round(p).toLocaleString("en-IN"), P.l + (i / 8) * cw, P.t + ch + 20);
  }

  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const pnl = yLo + (i / 5) * (yHi - yLo);
    const y = toY(pnl);
    const abs = Math.abs(pnl);
    const lbl = abs >= 100000 ? `${(pnl / 1000).toFixed(0)}k` : abs >= 1000 ? `${(pnl / 1000).toFixed(1)}k` : pnl.toFixed(0);
    ctx.fillStyle = pnl > 50 ? "#16a34a" : pnl < -50 ? "#e11d48" : axisText;
    ctx.fillText(lbl, P.l - 8, y + 3.5);
  }

  ctx.strokeStyle = zeroLine;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(P.l, zeroY); ctx.lineTo(P.l + cw, zeroY); ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(toX(pts[0].px), zeroY);
  pts.forEach(d => ctx.lineTo(toX(d.px), d.pnl > 0 ? toY(d.pnl) : zeroY));
  ctx.lineTo(toX(pts[pts.length - 1].px), zeroY);
  ctx.closePath();
  ctx.fillStyle = "rgba(22,163,74,0.20)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(toX(pts[0].px), zeroY);
  pts.forEach(d => ctx.lineTo(toX(d.px), d.pnl < 0 ? toY(d.pnl) : zeroY));
  ctx.lineTo(toX(pts[pts.length - 1].px), zeroY);
  ctx.closePath();
  ctx.fillStyle = "rgba(225,29,72,0.15)";
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = type === "CE" ? "#0284c7" : "#dc2626";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((d, i) => { if (i === 0) ctx.moveTo(toX(d.px), toY(d.pnl)); else ctx.lineTo(toX(d.px), toY(d.pnl)); });
  ctx.stroke();

  function vline(px: number, color: string, dash: number[], lw: number, topTag: string, val: string) {
    const x = toX(px);
    if (x < P.l - 1 || x > P.l + cw + 1) return;
    ctx!.save();
    ctx!.setLineDash(dash);
    ctx!.strokeStyle = color;
    ctx!.lineWidth = lw;
    ctx!.beginPath(); ctx!.moveTo(x, P.t); ctx!.lineTo(x, P.t + ch); ctx!.stroke();
    ctx!.restore();
    ctx!.fillStyle = color;
    ctx!.textAlign = "center";
    ctx!.font = "bold 7px 'Space Mono', monospace";
    ctx!.fillText(topTag, x, P.t - 22);
    ctx!.font = "8px 'Space Mono', monospace";
    ctx!.fillText(val, x, P.t - 11);
  }
  vline(strike, isDark ? "#475569" : "#94a3b8", [3, 3], 1, "STRIKE", strike.toLocaleString("en-IN"));
  if (entry > 0) {
    const be = type === "CE" ? strike + entry : strike - entry;
    vline(be, "#16a34a", [6, 3], 1.5, "BREAKEVEN", Math.round(be).toLocaleString("en-IN"));
  }
  vline(spot, "#f97316", [6, 3], 2, "SPOT", Math.round(spot).toLocaleString("en-IN"));

  const sX = toX(spot);
  if (sX >= P.l && sX <= P.l + cw) {
    const intr = type === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    const curPnL = (intr - entry) * lotSize;
    const dotY = toY(curPnL);
    ctx.beginPath();
    ctx.arc(sX, dotY, 6, 0, Math.PI * 2);
    ctx.fillStyle = curPnL >= 0 ? "#16a34a" : "#e11d48";
    ctx.fill();
    ctx.strokeStyle = bg;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    const lbl = `${curPnL >= 0 ? "+" : ""}₹${Math.abs(Math.round(curPnL)).toLocaleString("en-IN")}`;
    ctx.fillStyle = curPnL >= 0 ? "#16a34a" : "#e11d48";
    ctx.font = "bold 11px 'Space Mono', monospace";
    ctx.textAlign = sX > W * 0.6 ? "right" : "left";
    ctx.fillText(lbl, sX + (sX > W * 0.6 ? -12 : 12), dotY - 10);
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(P.l, P.t, cw, ch);

  ctx.save();
  ctx.translate(13, P.t + ch / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = axisText;
  ctx.font = "8px 'Space Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText("P&L AT EXPIRY  (₹)", 0, 0);
  ctx.restore();
  ctx.fillStyle = axisText;
  ctx.font = "8px 'Space Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${indexLabel} AT EXPIRY`, P.l + cw / 2, H - 10);
}

export function PayoffChart({ target, spot, indexLabel, onClose }: { target: PayoffTarget; spot: number; indexLabel: string; onClose: () => void }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const cvRef = useRef<HTMLCanvasElement>(null);
  const entry = target.ltp;
  const tc = target.type === "CE" ? "#0284c7" : "#e11d48";

  useEffect(() => {
    const canvas = cvRef.current;
    if (!canvas) return;
    const redraw = () => drawPayoffChart(canvas, target.strike, target.type, spot, entry, target.lotSize, isDark, indexLabel);
    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);
    redraw();
    return () => ro.disconnect();
  }, [target.strike, target.type, target.lotSize, spot, entry, isDark, indexLabel]);

  const be = target.type === "CE" ? target.strike + entry : target.strike - entry;
  const maxLoss = entry * target.lotSize;
  const intr = target.type === "CE" ? Math.max(0, spot - target.strike) : Math.max(0, target.strike - spot);
  const curPnL = (intr - entry) * target.lotSize;

  const stats = [
    { label: "STRIKE", val: target.strike.toLocaleString("en-IN"), color: "var(--text-muted)" },
    { label: "PREMIUM", val: entry > 0 ? `₹${entry.toFixed(2)}` : "—", color: tc },
    { label: "BREAKEVEN", val: entry > 0 ? Math.round(be).toLocaleString("en-IN") : "—", color: "#16a34a" },
    { label: "MAX LOSS", val: entry > 0 ? `₹${maxLoss.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—", color: "#e11d48" },
    { label: "MAX PROFIT", val: target.type === "CE" ? "Unlimited" : `₹${(target.strike * target.lotSize).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "#16a34a" },
    { label: "CUR P&L", val: entry > 0 ? `${curPnL >= 0 ? "+" : ""}₹${Math.abs(Math.round(curPnL)).toLocaleString("en-IN")}` : "—", color: curPnL >= 0 ? "#16a34a" : "#e11d48" },
  ];
  const legend = [
    { color: "#f97316", label: "Current Spot" },
    { color: "#16a34a", label: "Breakeven" },
    { color: isDark ? "#475569" : "#94a3b8", label: "Strike" },
    { color: "rgba(22,163,74,0.5)", label: "Profit Zone" },
    { color: "rgba(225,29,72,0.5)", label: "Loss Zone" },
  ];

  return (
    <div className="absolute inset-0 z-50 flex flex-col" style={{ background: "var(--bg-elevated)" }}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <button onClick={onClose} className="text-lg text-faint hover:opacity-70">✕</button>
        <span className="text-sm font-semibold text-fg">{indexLabel} {target.strike} {target.type === "CE" ? "Call" : "Put"} — Payoff at Expiry</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <canvas ref={cvRef} className="absolute inset-0 h-full w-full" />
      </div>

      <div className="grid flex-shrink-0 grid-cols-3 divide-x border-t sm:grid-cols-6" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
        {stats.map(({ label, val, color }) => (
          <div key={label} className="px-3 py-2.5 text-center" style={{ borderColor: "var(--border)" }}>
            <div className="mb-1 text-[7px] uppercase tracking-[1.5px]" style={{ fontFamily: "'Space Mono', monospace", color: "var(--text-faint)" }}>{label}</div>
            <div className="text-[12px] font-bold leading-tight" style={{ fontFamily: "'Space Mono', monospace", color }}>{val}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center justify-center gap-3 border-t py-1.5 sm:gap-5" style={{ borderColor: "var(--border)" }}>
        {legend.map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="h-[2px] w-5 rounded-full" style={{ background: color }} />
            <span className="text-[8px]" style={{ fontFamily: "'Space Mono', monospace", color: "var(--text-faint)" }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
