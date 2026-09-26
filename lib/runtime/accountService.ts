// ─── Account service ────────────────────────────────────────────────────────────
// Ported from backend/src/routes/account.js, rebuilt on INDstocks' order-book
// (verified fields: id, txn_type, traded_qty, traded_price, status — see
// lib/broker/orders.ts) instead of Kite's separate trades/orders endpoints.
//
// CHARGES are no longer a guess. `GET /margin` returns the BROKER'S OWN
// computed charges for a given order (stt, exchange charges, stamp duty, SEBI
// turnover, brokerage, GST) — verified live, itemized exactly like Kite's
// contract note. buildAccountData() calls it once per executed order and sums
// the real figures; estimateCharges()'s NSE rate-schedule math only remains as
// a last-resort fallback if /margin itself is unreachable.
import { getOrderBook, getPositions, getFunds, getMargin, type OrderBookRow } from "@/lib/broker/orders";
import { getPositionsList as autoTradeSmcPositions } from "./autoTrade";
import DailyPnL from "@/lib/db/models/DailyPnL";
import { isConnected } from "@/lib/db/connect";

const FNO_SEGMENT = "DERIVATIVE";

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function toISTTime(ts?: string | number | null): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  } catch { return null; }
}

export type Charges = { brokerage: number; stt: number; exchange: number; sebi: number; gst: number; stampDuty: number; total: number };

/** Real per-order charges via GET /margin — one call per executed order,
 *  summed field-for-field. Returns null (not a partial result) if any call
 *  fails, so the caller falls back to the estimate rather than silently
 *  mixing real and guessed numbers into one total. */
async function realCharges(orders: OrderBookRow[]): Promise<Charges | null> {
  const executed = orders.filter(o => /success/i.test(o.status) && o.traded_qty > 0);
  if (!executed.length) return null;

  let brokerage = 0, stt = 0, exchange = 0, sebi = 0, gst = 0, stampDuty = 0;
  try {
    for (const o of executed) {
      const m = await getMargin({
        securityId: o.security_id ?? "", txnType: o.txn_type as "BUY" | "SELL",
        quantity: o.traded_qty, price: Number(o.traded_price || 0),
      });
      brokerage += m.charges.brokerage; stt += m.charges.stt; exchange += m.charges.exchangeCharges;
      sebi += m.charges.sebiTurnoverCharges; gst += m.charges.gst; stampDuty += m.charges.stampDuty;
    }
  } catch (err: any) {
    console.warn("[Account] GET /margin failed — falling back to the rate-schedule estimate:", err.message);
    return null;
  }
  const total = brokerage + stt + exchange + sebi + gst + stampDuty;
  return {
    brokerage: +brokerage.toFixed(2), stt: +stt.toFixed(2), exchange: +exchange.toFixed(2),
    sebi: +sebi.toFixed(2), gst: +gst.toFixed(2), stampDuty: +stampDuty.toFixed(2), total: +total.toFixed(2),
  };
}

/** Fallback only, used when /margin is unreachable: NSE F&O OPTIONS rate
 *  schedule applied to executed order turnover (STT 0.1% sell-side premium
 *  turnover; exchange txn ~0.03503%; SEBI ₹10/crore; stamp duty 0.003%
 *  buy-side; GST 18% on brokerage+exchange; brokerage flat ₹10/order). */
function estimateCharges(orders: OrderBookRow[]): Charges {
  const executed = orders.filter(o => /success/i.test(o.status));
  let brokerage = 0, stt = 0, exchange = 0, sebi = 0, stampDuty = 0;

  for (const o of executed) {
    const qty = Number(o.traded_qty || 0);
    const price = Number(o.traded_price || 0);
    const turnover = qty * price;
    brokerage += 10; // ₹10 flat per executed order
    exchange  += turnover * 0.0003503;
    sebi      += turnover * 0.0000001;
    if (o.txn_type === "SELL") stt += turnover * 0.001;
    if (o.txn_type === "BUY")  stampDuty += turnover * 0.00003;
  }
  const gst = (brokerage + exchange) * 0.18;
  const total = brokerage + stt + exchange + sebi + gst + stampDuty;
  return {
    brokerage: +brokerage.toFixed(2), stt: +stt.toFixed(2), exchange: +exchange.toFixed(2),
    sebi: +sebi.toFixed(2), gst: +gst.toFixed(2), stampDuty: +stampDuty.toFixed(2), total: +total.toFixed(2),
  };
}

export type AccountPosition = {
  tradingsymbol: string; token: number | null; direction: string | null; strike: number | null;
  quantity: number; buyPrice: number; sellPrice: number; currentPrice: number;
  pnl: number; status: "OPEN" | "CLOSED"; entryTime: string | null; exitTime: string | null;
  durationSecs: number | null;
};

/** FIFO-matches BUY/SELL fills per symbol from the order book — the same
 *  approach as the Kite app's buildPositionsFromData, just against
 *  INDstocks' own field names (id/txn_type/traded_qty/traded_price).
 *  Grouped by security_id (the numeric token — stable across an order's
 *  life), with the real human-readable symbol resolved from the live
 *  positions feed's own `symbol` field for display and the SL/TP/Lock
 *  localStorage key; security_id itself is never shown to the user. */
function buildPositionsFromOrders(orders: OrderBookRow[], livePositions: Awaited<ReturnType<typeof getPositions>>): AccountPosition[] {
  const executed = orders.filter(o => /success/i.test(o.status) && o.traded_qty > 0);
  const bySymbol = new Map<string, { buys: OrderBookRow[]; sells: OrderBookRow[] }>();
  for (const o of executed) {
    const sym = o.security_id ?? "unknown";
    const bucket = bySymbol.get(sym) ?? { buys: [], sells: [] };
    (o.txn_type === "BUY" ? bucket.buys : bucket.sells).push(o);
    bySymbol.set(sym, bucket);
  }

  const smcPositions = autoTradeSmcPositions("smc");
  const positions: AccountPosition[] = [];

  for (const [sym, { buys, sells }] of bySymbol) {
    // `sym` is security_id (the numeric token, as a string) — match against
    // the OTHER security_id/token fields, never against a human symbol string
    // (comparing the two never matches, which silently zeroed out currentPrice
    // and dropped direction/strike for every position).
    const live = livePositions.find(p => p.security_id === sym);
    const at = smcPositions.find(p => String(p.token) === sym);
    const tradingsymbol = live?.symbol ?? at?.tradingsymbol ?? buys[0]?.name ?? sym;
    const direction = at?.direction ?? (tradingsymbol.endsWith("CE") ? "CE" : tradingsymbol.endsWith("PE") ? "PE" : null);
    const token = Number(sym) || null;

    buys.forEach((buy, i) => {
      const sell = sells[i];
      const isOpen = !sell;
      const currentPrice = live?.avg_price ?? 0;
      const buyPrice = Number(buy.traded_price || 0);
      const sellPrice = sell ? Number(sell.traded_price || 0) : 0;
      const qty = Number(buy.traded_qty || 0);
      const pnl = isOpen ? +((currentPrice - buyPrice) * qty).toFixed(2) : +((sellPrice - buyPrice) * qty).toFixed(2);
      const entryMs = buy.created_at ? new Date(buy.created_at).getTime() : NaN;
      const exitMs = sell?.updated_at ? new Date(sell.updated_at).getTime() : NaN;
      const durationSecs = !Number.isNaN(entryMs)
        ? Math.max(0, Math.round(((isOpen ? Date.now() : exitMs) - entryMs) / 1000))
        : null;

      positions.push({
        tradingsymbol, token, direction, strike: at?.strike ?? null,
        quantity: qty, buyPrice: +buyPrice.toFixed(2), sellPrice: +sellPrice.toFixed(2), currentPrice: +currentPrice.toFixed(2),
        pnl, status: isOpen ? "OPEN" : "CLOSED",
        entryTime: toISTTime(buy.created_at), exitTime: sell ? toISTTime(sell.updated_at) : null,
        durationSecs,
      });
    });
  }
  return positions;
}

export async function buildAccountData() {
  const [funds, livePositions, orders] = await Promise.all([
    getFunds().catch(() => ({ availableBalance: 0, startOfDayBalance: 0, realisedPnL: 0, unrealisedPnL: 0, bySegment: { optionBuy: 0, optionSell: 0, future: 0, eqMis: 0, eqCnc: 0 }, brokerage: 0, fnoCharges: 0, eqCharges: 0, fundsAdded: 0, fundsWithdrawn: 0 })),
    getPositions().catch(() => []),
    getOrderBook().catch(() => []),
  ]);

  const fnoOrders = orders.filter(o => true); // order-book has no segment field in the sample — kept unfiltered

  // Prefer real, itemized per-order charges from GET /margin. If that's
  // unreachable, fall back to /funds' own accrued total (still real, just not
  // itemized), and only then to the rate-schedule estimate.
  const charges = (await realCharges(fnoOrders).catch(() => null)) ?? (() => {
    const estimated = estimateCharges(fnoOrders);
    const brokerReportedTotal = funds.brokerage + funds.fnoCharges;
    return brokerReportedTotal > 0
      ? { ...estimated, brokerage: +funds.brokerage.toFixed(2), total: +brokerReportedTotal.toFixed(2) }
      : estimated;
  })();
  const positions = buildPositionsFromOrders(fnoOrders, livePositions);

  const realisedPnL = livePositions.reduce((s, p) => s + (p.realized_profit ?? 0), 0);
  const unrealisedPnL = positions.filter(p => p.status === "OPEN").reduce((s, p) => s + p.pnl, 0);
  const pnl = { realised: +realisedPnL.toFixed(2), unrealised: +unrealisedPnL.toFixed(2), total: +(realisedPnL + unrealisedPnL).toFixed(2) };

  const closedPos = positions.filter(p => p.status === "CLOSED");
  const winners = closedPos.filter(p => p.pnl > 0).length;
  const losers = closedPos.filter(p => p.pnl < 0).length;
  const stats = {
    totalTrades: closedPos.length, openTrades: positions.filter(p => p.status === "OPEN").length,
    winners, losers, winRate: closedPos.length ? +(winners / closedPos.length * 100).toFixed(1) : 0,
    avgPnl: closedPos.length ? +(closedPos.reduce((s, p) => s + p.pnl, 0) / closedPos.length).toFixed(2) : 0,
  };

  const orderBook = orders.map(o => ({
    order_id: o.id, tradingsymbol: o.name || o.security_id, transaction_type: o.txn_type,
    quantity: o.traded_qty || o.requested_qty, price: Number(o.traded_price || o.requested_price || 0),
    order_type: o.order_type, status: o.status, status_message: o.extra_info || null,
  }));

  const usedMargin = funds.bySegment.optionBuy + funds.bySegment.optionSell + funds.bySegment.future + funds.bySegment.eqMis + funds.bySegment.eqCnc;
  const wallet = {
    available: +funds.availableBalance.toFixed(2), used: +usedMargin.toFixed(2), net: +funds.startOfDayBalance.toFixed(2),
    deposit: +funds.fundsAdded.toFixed(2), withdrawal: +funds.fundsWithdrawn.toFixed(2),
  };

  return { wallet, charges, pnl, positions, stats, orderBook };
}

export async function saveSnapshot(date: string, positions: AccountPosition[], charges: Charges, pnl: { realised: number; unrealised: number; total: number }) {
  if (!isConnected()) return;
  try {
    await DailyPnL.findOneAndUpdate({ date }, { date, positions, charges, pnl, savedAt: new Date() }, { upsert: true, new: true });
  } catch (err: any) {
    console.warn("[Account] Snapshot save failed:", err.message);
  }
}

export async function eodSnapshot() {
  try {
    const data = await buildAccountData();
    await saveSnapshot(todayIST(), data.positions, data.charges, data.pnl);
    console.log("[Account] EOD snapshot saved for", todayIST());
  } catch (err: any) {
    console.warn("[Account] EOD snapshot failed:", err.message);
  }
}
