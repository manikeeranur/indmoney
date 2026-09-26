// ─── Candle CSV formatting ─────────────────────────────────────────────────────
// Ported from backend/src/utils/candleCsv.js — the shared formatter that keeps
// the OHLC tab's download and the EOD Telegram report byte-identical.
import type { Candle } from "@/lib/broker/types";

export function fmtIST(d: string | Date): string {
  const ist = new Date((d instanceof Date ? d : new Date(d)).getTime() + 5.5 * 60 * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mi = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()} ${hh}:${mi}`;
}

export function calcRollingRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < 2) return out;
  let sumGain = 0, sumLoss = 0, ag = 0, al = 0, warmedUp = false;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = Math.max(d, 0), loss = Math.max(-d, 0);
    if (!warmedUp) {
      sumGain += gain; sumLoss += loss;
      const count = i;
      const simAG = sumGain / count, simAL = sumLoss / count;
      out[i] = simAL === 0 ? 100 : +(100 - 100 / (1 + simAG / simAL)).toFixed(2);
      if (count >= period) { ag = sumGain / period; al = sumLoss / period; warmedUp = true; }
    } else {
      ag = (ag * (period - 1) + gain) / period;
      al = (al * (period - 1) + loss) / period;
      out[i] = al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2);
    }
  }
  return out;
}

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

export function optionSymbol(expiry: string, strike: number, type: string, index = "NIFTY"): string {
  const exp = new Date(expiry);
  const ddmmmyy = `${String(exp.getUTCDate()).padStart(2, "0")}${MONTHS[exp.getUTCMonth()]}${String(exp.getUTCFullYear()).slice(-2)}`;
  return `${index}${ddmmmyy}${strike}${type}`;
}

export function ohlcFilename(date: string, symbol: string): string {
  return `${date}_${symbol}.csv`;
}

/** Same columns as the OHLC tab's own CSV download: Date,Open,High,Low,Close,
 *  Volume,OI,RSI(14). Note: INDstocks historical candles carry no OI, so that
 *  column is empty here — captured live via the price WS in "quote" mode
 *  instead (see lib/telegram/eodOhlcReport.ts). */
export function buildOhlcCsv(candles: Candle[]): string {
  const rsi = calcRollingRSI(candles.map(c => c.close), 14);
  const header = "Date,Open,High,Low,Close,Volume,OI,RSI(14)\n";
  const body = candles
    .map((c, i) => `${fmtIST(c.date)},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.oi ?? ""},${rsi[i] ?? ""}`)
    .join("\n");
  return header + body;
}
