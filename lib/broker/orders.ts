// ─── INDstocks order placement ────────────────────────────────────────────────
// The Kite app placed two independent orders per entry — a MARKET BUY, then a
// separate SL-M SELL — with a real window between them where a fill existed
// with no protective stop. INDstocks' smart order carries both the stop-loss
// AND the target as child legs of ONE call, so entry and protection land
// together. That is a deliberate improvement, not a like-for-like port.
//
// The other structural difference: INDstocks has NO true MARKET order — an
// order_type: "MARKET" request is converted to a LIMIT at the current live
// price server-side, so a fill is not guaranteed the way a Kite MARKET order
// was. lib/runtime/autoTrade.ts builds the re-price-on-timeout loop this
// makes necessary; this file only wraps the raw REST calls.
import { request } from "./client";
import { getAccessToken } from "./auth";
import https from "node:https";
import { EXCHANGE, PRODUCT, SEGMENT } from "@/lib/strategies/constants";

export type TxnType = "BUY" | "SELL";

export type SmartOrderParams = {
  txnType: TxnType;
  securityId: string;
  qty: number;
  limitPrice: number;
  /** Stop-loss child leg. */
  slTriggerPrice: number;
  slLimitPrice: number;
  /** Target child leg — optional; SMC and VWAP930 both software-monitor the
   *  target too, but placing it broker-side is strictly safer than not. */
  tgtTriggerPrice?: number;
  tgtLimitPrice?: number;
  remarks?: string;
};

export type SmartOrderResult = {
  orderId: string;
  orderStatus: string;
  childOrderId?: string;
  childOrderStatus?: string;
};

export async function placeSmartOrder(p: SmartOrderParams): Promise<SmartOrderResult> {
  const body: Record<string, unknown> = {
    txn_type: p.txnType,
    exchange: EXCHANGE,
    segment: SEGMENT,
    product: PRODUCT,
    order_type: "LIMIT",
    validity: "DAY",
    security_id: p.securityId,
    qty: p.qty,
    limit_price: p.limitPrice,
    sl_trigger_price: p.slTriggerPrice,
    sl_limit_price: p.slLimitPrice,
    algo_id: "99999",
  };
  if (p.tgtTriggerPrice != null) body.tgt_trigger_price = p.tgtTriggerPrice;
  if (p.tgtLimitPrice   != null) body.tgt_limit_price   = p.tgtLimitPrice;
  if (p.remarks) body.remarks = p.remarks.slice(0, 100);

  const data = await request<{ order_data: Array<{ order_id: string; order_status: string; child_order_details?: { order_id: string; order_status: string } }> }>(
    "/smart/order", { method: "POST", body, category: "order" },
  );
  const row = data.order_data?.[0];
  if (!row) throw new Error("INDstocks smart order returned no order data");
  return {
    orderId: row.order_id,
    orderStatus: row.order_status,
    childOrderId: row.child_order_details?.order_id,
    childOrderStatus: row.child_order_details?.order_status,
  };
}

/** A plain LIMIT order with no SL/target legs — used for the exit sell, which
 *  has no stop or target of its own. */
export async function placeOrder(p: { txnType: TxnType; securityId: string; qty: number; limitPrice: number; remarks?: string }): Promise<string> {
  const body: Record<string, unknown> = {
    txn_type: p.txnType,
    exchange: EXCHANGE,
    segment: SEGMENT,
    product: PRODUCT,
    order_type: "LIMIT",
    limit_price: p.limitPrice,
    validity: "DAY",
    security_id: p.securityId,
    qty: p.qty,
    algo_id: "99999",
  };
  if (p.remarks) body.remarks = p.remarks.slice(0, 100);
  const data = await request<{ order_id: string; order_status: string }>(
    "/order", { method: "POST", body, category: "order" },
  );
  return data.order_id;
}

export type SmartOrderModifyPatch = {
  qty?: number;
  limitPrice?: number;
  /** Confirmed against /smart_orders docs: the parent OR a child's own GTT-
   *  prefixed order_id both accept these — "modify or cancel a smart order...
   *  operate on each order separately using its own order_id". This is what
   *  lets moveSLToBreakeven() move the stop by calling this on the CHILD id. */
  slTriggerPrice?: number;
  slLimitPrice?: number;
  tgtTriggerPrice?: number;
  tgtLimitPrice?: number;
};

export async function modifySmartOrder(orderId: string, patch: SmartOrderModifyPatch): Promise<void> {
  const body: Record<string, unknown> = { order_id: orderId, segment: SEGMENT };
  if (patch.qty            != null) body.qty              = patch.qty;
  if (patch.limitPrice      != null) body.limit_price      = patch.limitPrice;
  if (patch.slTriggerPrice  != null) body.sl_trigger_price = patch.slTriggerPrice;
  if (patch.slLimitPrice    != null) body.sl_limit_price   = patch.slLimitPrice;
  if (patch.tgtTriggerPrice != null) body.tgt_trigger_price = patch.tgtTriggerPrice;
  if (patch.tgtLimitPrice   != null) body.tgt_limit_price   = patch.tgtLimitPrice;
  await request("/smart/order/modify", { method: "POST", category: "order", body });
}

export async function cancelSmartOrder(orderId: string): Promise<void> {
  await request("/smart/order/cancel", { method: "POST", category: "order", body: { order_id: orderId, segment: SEGMENT } });
}

export async function cancelOrder(orderId: string): Promise<void> {
  await request("/order/cancel", { method: "POST", category: "order", body: { order_id: orderId, segment: SEGMENT } });
}

// Field names verified against /normal_orders' own sample response — the
// order's id comes back as `id`, not `order_id`, and quantities are
// `traded_qty` / `requested_qty`, not `filled_qty` / `qty`.
export type OrderBookRow = {
  id: string;
  security_id?: string;
  name?: string;
  txn_type: string;
  order_type: string;
  status: string;
  requested_qty: number;
  traded_qty: number;
  requested_price?: string | number;
  traded_price?: string | number;
  created_at?: string;
  updated_at?: string;
  extra_info?: string;
};

/** A fully filled order's status; PARTIALLY FILLED variants are NOT terminal
 *  successes for our purposes — the strategies size for the whole lot.
 *  Full status vocabulary verified against api-docs.indstocks.com/normal_orders/:
 *  QUEUED, O-PENDING, SL-PENDING, PROCESSING, INITIATED, MODIFIED, PENDING,
 *  PARTIALLY FILLED (all non-terminal); SUCCESS (terminal fill); CANCELLED,
 *  ABORTED, EXPIRED, FAILED, PARTIALLY FILLED - CANCELLED, PARTIALLY FILLED -
 *  EXPIRED (terminal dead — note the last two carry a real partial traded_qty
 *  that isOrderDead()'s caller currently discards; see autoTrade.ts's own
 *  "FLAG FOR LIVE VERIFICATION" note on this exact edge case). */
const TERMINAL_SUCCESS = /^success$/i;
const TERMINAL_FAILURE = /^(cancelled|failed|expired|aborted|partially filled - (cancelled|expired))$/i;

export function isOrderFilled(row: Pick<OrderBookRow, "status" | "traded_qty">, expectedQty: number): boolean {
  return TERMINAL_SUCCESS.test(row.status) && row.traded_qty >= expectedQty;
}

export function isOrderDead(row: Pick<OrderBookRow, "status">): boolean {
  return TERMINAL_FAILURE.test(row.status);
}

export async function getOrderBook(): Promise<OrderBookRow[]> {
  const data = await request<{ orders?: OrderBookRow[] } | OrderBookRow[]>("/order-book", { category: "nonTrading" });
  return Array.isArray(data) ? data : (data.orders ?? []);
}

export type PositionRow = {
  security_id: string;
  symbol: string;
  segment: string;
  product: string;
  exchange: string;
  net_qty: number;
  avg_price: number;
  realized_profit?: number;
};

export async function getPositions(): Promise<PositionRow[]> {
  const data = await request<{ positions?: PositionRow[] } | PositionRow[]>(
    "/portfolio/positions", { category: "nonTrading", query: { segment: "derivative", product: "intraday" } },
  );
  return Array.isArray(data) ? data : (data.positions ?? []);
}

export type Funds = {
  /** Free cash that could be withdrawn right now. */
  availableBalance: number;
  /** Start-of-day balance, before today's trading. */
  startOfDayBalance: number;
  realisedPnL: number;
  unrealisedPnL: number;
  /** Margin currently held per segment, straight from the broker. */
  bySegment: { optionBuy: number; optionSell: number; future: number; eqMis: number; eqCnc: number };
  /** Charges the broker itself has ALREADY ACCRUED for the day — this is a
   *  real reported figure, not an estimate, and is preferred over
   *  accountService.ts's self-computed estimateCharges() total whenever it is
   *  available. */
  brokerage: number;
  fnoCharges: number;
  eqCharges: number;
  /** Funds added/withdrawn TODAY — present in the verified live response
   *  (funds_added/funds_withdrawn) but missed on the first pass, which crashed
   *  the account page's Wallet card (it renders these unconditionally,
   *  matching AccountTab.tsx). */
  fundsAdded: number;
  fundsWithdrawn: number;
};

/** GET /funds — verified live against the real account response AND against
 *  the docs' own field table (api-docs.indstocks.com/Users/), which agree
 *  exactly: sod_balance, withdrawal_balance, detailed_avl_balance.{option_buy,
 *  option_sell,future,eq_mis,eq_cnc,eq_mtf,comm_option_buy}, realized_pnl,
 *  unrealized_pnl, brokerage, eq_charges, fno_charges. (The earlier guessed
 *  field names — available_balance/utilised_amount/net — do not exist.)
 *  Falls back to zeros (never throws) so the account tab still renders if the
 *  shape ever drifts. */
export async function getFunds(): Promise<Funds> {
  const data = await request<any>("/funds", { category: "nonTrading" });
  const d = data?.data ?? data ?? {};
  const seg = d.detailed_avl_balance ?? {};
  return {
    availableBalance: Number(d.withdrawal_balance ?? 0),
    startOfDayBalance: Number(d.sod_balance ?? 0),
    realisedPnL: Number(d.realized_pnl ?? 0),
    unrealisedPnL: Number(d.unrealized_pnl ?? 0),
    bySegment: {
      optionBuy: Number(seg.option_buy ?? 0), optionSell: Number(seg.option_sell ?? 0),
      future: Number(seg.future ?? 0), eqMis: Number(seg.eq_mis ?? 0), eqCnc: Number(seg.eq_cnc ?? 0),
    },
    brokerage: Number(d.brokerage ?? 0),
    fnoCharges: Number(d.fno_charges ?? 0),
    eqCharges: Number(d.eq_charges ?? 0),
    fundsAdded: Number(d.funds_added ?? 0),
    fundsWithdrawn: Number(d.funds_withdrawn ?? 0),
  };
}


// ─── Margin / charges calculator ───────────────────────────────────────────────
export type MarginCharges = {
  stt: number; exchangeCharges: number; stampDuty: number; sebiTurnoverCharges: number;
  brokerage: number; gst: number; ipftCharges: number; total: number;
};
export type MarginResult = {
  totalMargin: number; spanMargin: number; hedgeBenefit: number; exposureMargin: number;
  availableBalance: number; varMargin: number; insufficientBalance: number; deliveryMargin: number;
  brokerage: number; charges: MarginCharges;
};

/** GET /margin — the ONE INDstocks endpoint whose real behaviour contradicts
 *  its own docs table: the docs list segment/exchange/securityID/etc as query
 *  parameters, but the live API rejects that with "Request Unmarshal Failed"
 *  and only accepts them as a JSON body on the GET request itself (confirmed
 *  live with curl -X GET -d '...', which succeeds). Node's native fetch()
 *  refuses a body on GET per the Fetch spec ("Request with GET/HEAD method
 *  cannot have body"), also confirmed directly — so this one call goes
 *  through raw https.request() instead of lib/broker/client.ts's request().
 *
 *  Gives the BROKER'S OWN computed charges (stt, exchange_charges, stamp_duty,
 *  sebi_turn_over_charges, brokerage, gst, IPFTCharges, total_charges), not an
 *  estimate — the closest INDstocks equivalent to Kite's
 *  getvirtualContractNote, and accountService.ts prefers it over its own
 *  rate-schedule estimate whenever it succeeds. */
export async function getMargin(p: {
  securityId: string; txnType: TxnType; quantity: number; price: number; product?: string; segment?: string; exchange?: string;
}): Promise<MarginResult> {
  const data = await getMarginRaw({
    segment: p.segment ?? SEGMENT,
    exchange: p.exchange ?? EXCHANGE,
    securityID: p.securityId,
    txnType: p.txnType,
    quantity: String(p.quantity),
    price: String(p.price),
    product: p.product ?? PRODUCT,
  });
  const c = data.charges ?? {};
  return {
    totalMargin: Number(data.total_margin ?? 0), spanMargin: Number(data.span_margin ?? 0),
    hedgeBenefit: Number(data.hedge_benefit ?? 0), exposureMargin: Number(data.exposure_margin ?? 0),
    availableBalance: Number(data.available_balance ?? 0), varMargin: Number(data.var_margin ?? 0),
    insufficientBalance: Number(data.insufficient_balance ?? 0), deliveryMargin: Number(data.delivery_margin ?? 0),
    brokerage: Number(data.brokerage ?? 0),
    charges: {
      stt: Number(c.stt ?? 0), exchangeCharges: Number(c.exchange_charges ?? 0), stampDuty: Number(c.stamp_duty ?? 0),
      sebiTurnoverCharges: Number(c.sebi_turn_over_charges ?? 0), brokerage: Number(c.brokerage ?? 0),
      gst: Number(c.gst ?? 0), ipftCharges: Number(c.IPFTCharges ?? 0), total: Number(c.total_charges ?? 0),
    },
  };
}


/** Raw GET-with-JSON-body request for /margin, since neither fetch() nor
 *  request() can express this. Not rate-limited through client.ts's shared
 *  queue — /margin is called at most once per manual account load, nowhere
 *  near the 15/s non-trading limit. */
function getMarginRaw(body: Record<string, string>): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const token = await getAccessToken();
    const payload = JSON.stringify(body);
    const req = https.request(
      "https://api.indstocks.com/margin",
      { method: "GET", headers: { Authorization: token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (json.status !== "success") return reject(new Error(`GET /margin failed: ${json.message ?? raw}`));
            resolve(json.data ?? {});
          } catch (e: any) {
            reject(new Error(`GET /margin: invalid JSON response — ${e.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Holdings (equity, cash segment) ───────────────────────────────────────────
export type HoldingRow = {
  security_id: string; symbol: string; isin: string;
  total_qty: number; used_qty: number; avg_price: number;
  t1_qty: number; t1_avg_price: number; dp_qty: number; dp_avg_price: number;
};

/** GET /portfolio/holdings — verified against docs: no query params, just the
 *  auth header. Equity/cash holdings; this app trades NIFTY options only, so
 *  this will normally come back empty, but the account tab should still show
 *  it rather than silently omit a whole asset class. */
export async function getHoldings(): Promise<HoldingRow[]> {
  const data = await request<{ holdings?: HoldingRow[] } | HoldingRow[]>("/portfolio/holdings", { category: "nonTrading" });
  return Array.isArray(data) ? data : (data.holdings ?? []);
}
