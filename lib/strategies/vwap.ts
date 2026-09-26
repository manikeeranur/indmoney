// ─── VWAP (Volume Weighted Average Price) ────────────────────────────────────
// Ported unchanged from backend/src/utils/vwap.js — pure candle math, no
// broker dependency, so nothing here needed to change for INDstocks.
import type { Candle } from "@/lib/broker/types";

/** Cumulative typical-price × volume, reset at the start of the candle series
 *  (call with the current session's candles only — e.g. from 09:15 onwards).
 *  Returns an array the same length as `candles`, one VWAP value per candle. */
export function calcVWAP(candles: Candle[]): number[] {
  let cumPV = 0, cumVol = 0;
  return candles.map((c) => {
    const typical = (c.high + c.low + c.close) / 3;
    const vol     = c.volume || 0;
    cumPV  += typical * vol;
    cumVol += vol;
    return +(cumVol > 0 ? cumPV / cumVol : typical).toFixed(2);
  });
}

/** VWAP of the last candle in the series. */
export function latestVWAP(candles: Candle[]): number | null {
  const series = calcVWAP(candles);
  return series.length ? series[series.length - 1] : null;
}

/** Groups candles in sequence (index-based, not clock-based), so callers must
 *  pass candles starting from the session open (e.g. 09:15) for the buckets to
 *  land on real N-min boundaries. Only emits FULLY completed groups — a
 *  trailing partial group is dropped, never padded. */
export function aggregateCandles(candles: Candle[], size: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + size <= candles.length; i += size) {
    const chunk = candles.slice(i, i + size);
    out.push({
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(c => c.high)),
      low:    Math.min(...chunk.map(c => c.low)),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
      date:   chunk[chunk.length - 1].date,
    });
  }
  return out;
}

/** GREEN (closed above where it opened) AND body bigger than combined wicks —
 *  filters out dojis/indecision candles even when the close lands above VWAP. */
export function isStrongGreenCandle(candle: Candle): boolean {
  const body = candle.close - candle.open;
  if (body <= 0) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return body > upperWick + lowerWick;
}
