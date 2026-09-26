// ─── Chart indicators ───────────────────────────────────────────────────────────
// Ported unchanged from backend/src/routes/optionChain.js (calcEMA/calcBB/
// calcMACD) — pure numeric functions, no broker dependency. calcRollingRSI
// already lives in candleCsv.ts; these three power the KiteChartPanel-
// equivalent chart's EMA/Bollinger Band/MACD overlays.
export function calcEMA(closes: number[], period: number): number[] {
  if (!closes.length) return [];
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) out.push(+(out[i - 1] * (1 - k) + closes[i] * k).toFixed(2));
  return out;
}

export type BBPoint = { mid: number | null; up: number | null; dn: number | null };
export function calcBB(closes: number[], period = 20, mult = 2): BBPoint[] {
  return closes.map((_, i) => {
    if (i < period - 1) return { mid: null, up: null, dn: null };
    const sl = closes.slice(i - period + 1, i + 1);
    const mid = sl.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
    return { mid: +mid.toFixed(2), up: +(mid + mult * sd).toFixed(2), dn: +(mid - mult * sd).toFixed(2) };
  });
}

export type MACDPoint = { macd: number; sig: number; hist: number };
export function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9): MACDPoint[] {
  const ef = calcEMA(closes, fast);
  const es = calcEMA(closes, slow);
  const ml = ef.map((v, i) => +(v - es[i]).toFixed(2));
  const sl = calcEMA(ml, signal);
  return ml.map((v, i) => ({ macd: v, sig: +sl[i].toFixed(2), hist: +(v - sl[i]).toFixed(2) }));
}
