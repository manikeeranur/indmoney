// ─── Broker-neutral shapes ────────────────────────────────────────────────────
// Everything outside lib/broker/ speaks THESE types, never INDstocks' wire
// format. That is what keeps the strategy code (ported from the Kite app
// unchanged) free of broker coupling — and what would make a third broker a
// new adapter rather than a rewrite.

/** One OHLC candle. Matches the shape the ported strategies already consume. */
export type Candle = {
  /** Candle open time. IST. */
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Not available from INDstocks historical candles — see oiSnapshot. */
  oi?: number | null;
};

export type OptionType = "CE" | "PE";

/** One option leg. `token` is INDstocks' security_id, kept numeric for parity
 *  with the Kite app's instrument_token so ported code needs no changes. */
export type Leg = {
  token: number;
  tradingsymbol: string;
  strike: number;
  type: OptionType;
  ltp: number;
  prevLtp: number;
  ltpChange: number;
  oi: number;
  oiChange: number;
  volume: number;
  /** From the broker now, not solved locally. */
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bid: number;
  ask: number;
  lotSize: number;
};

export type ChainRow = {
  strike: number;
  isATM: boolean;
  ce: Leg;
  pe: Leg;
  ceOIBar: number;
  peOIBar: number;
};

export type OptionChain = {
  spot: number;
  expiry: string;
  daysToExpiry: number;
  rows: ChainRow[];
  atm: number;
  pcr: number;
  pcrOI: number;
  maxPain: number;
  totalCEOI: number;
  totalPEOI: number;
  atmIV: number;
  updatedAt: string;
};

/** Live price tick. Field names deliberately mirror the Kite tick shape the
 *  existing tick-exit path and frontend already consume. */
export type Tick = {
  instrument_token: number;
  last_price: number;
  volume_traded?: number;
  oi?: number;
};

export type Instrument = {
  token: number;
  /** "NIFTY-Sep2026-23400-PE" */
  tradingsymbol: string;
  /** Underlying, e.g. "NIFTY" — parsed from tradingsymbol, see instruments.ts */
  name: string;
  /** Exchange display label, e.g. "NIFTY 29 SEP 23400 PE" */
  label: string;
  strike: number | null;
  /** "YYYY-MM-DD" */
  expiry: string | null;
  /** "CE" | "PE" | "" */
  type: string;
  /** INSTRUMENT_NAME: "OPTIDX" | "OPTSTK" | "FUTIDX" | … */
  kind: string;
  segment: string;
  exchange: string;
  lotSize: number;
};

export type Index = "NIFTY" | "SENSEX";

export type Segment = "DERIVATIVE" | "EQUITY";
export type Product = "INTRADAY" | "MARGIN" | "CNC";

export type Position = {
  token: number;
  tradingsymbol: string;
  quantity: number;
  avgPrice: number;
  product: string;
  exchange: string;
  segment: string;
  realisedPnL: number;
  lastPrice?: number;
};

/** Normalised order status. INDstocks sends single-letter codes on the order
 *  WebSocket (R/P/S/F/C/RJ/PF/PFC) and words over REST; both map to these. */
export type OrderStatus =
  | "PENDING"
  | "COMPLETE"
  | "PARTIAL"
  | "CANCELLED"
  | "REJECTED"
  | "FAILED";

export type OrderUpdate = {
  orderId: string;
  status: OrderStatus;
  tradingsymbol?: string;
  executedPrice?: number;
  quantity?: number;
  filledQuantity?: number;
  errorMessage?: string;
  timestamp: number;
};
