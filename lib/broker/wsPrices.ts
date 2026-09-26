// ─── INDstocks price WebSocket ────────────────────────────────────────────────
// This replaces BOTH polling loops in the old app (the 2s option-chain refresh
// and the 500ms quote poll in the chart), which together would have burned most
// of INDstocks' 100,000 calls/day before midday.
//
// Differences from the Kite ticker this is ported from:
//   - JSON frames, not a binary packet format.
//   - Auth is an Authorization header on the handshake, not a URL parameter.
//   - Instruments are addressed as "SEGMENT:TOKEN" strings (NFO:51011,
//     NIDX:26000), not bare numeric tokens.
//   - Limits: 3 connections per user, 3,000 instruments per connection.
//
// Reconnection deliberately keeps the old app's hand-rolled backoff rather than
// any library default: the Kite SDK's own reconnect called process.exit(1) on a
// stale token and took the whole trading process down with it.

import WebSocket from "ws";
import { getAccessToken } from "./auth";
import type { Tick } from "./types";

const URL_PRICES = process.env.IND_WS_PRICES || "wss://ws-prices.indstocks.com/api/v1/ws/prices";

const MAX_INSTRUMENTS = 3000;
const BACKOFF_MIN_MS  = 5_000;
const BACKOFF_MAX_MS  = 60_000;

export type PriceMode = "ltp" | "quote";

let ws: WebSocket | null = null;
let connected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let stopped = false;

/** token → mode. Entered legs go to "quote" so we capture OI, which INDstocks
 *  does NOT return in historical candles — that is how the EOD OHLC report
 *  keeps its OI column alive. */
const subscriptions = new Map<number, PriceMode>();
/** token → segment prefix ("NFO" / "NIDX" / "BFO" / "BIDX"). */
const segments = new Map<number, string>();

type TickListener = (ticks: Tick[]) => void;
const listeners = new Set<TickListener>();

export function onTicks(fn: TickListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function instrumentKey(token: number): string {
  return `${segments.get(token) ?? "NFO"}:${token}`;
}

export function registerSegment(token: number, segment: string) {
  segments.set(token, segment);
}

/** Subscribe tokens, defaulting to cheap LTP mode. Safe to call repeatedly. */
export function subscribeTokens(tokens: number[], mode: PriceMode = "ltp") {
  const added: number[] = [];
  for (const t of tokens) {
    const token = Number(t);
    if (!Number.isFinite(token) || token <= 0) continue;
    const current = subscriptions.get(token);
    // An existing "quote" subscription outranks a later "ltp" one — never
    // downgrade a leg we are trading down to LTP and lose its OI.
    if (current === "quote" && mode === "ltp") continue;
    if (current === mode) continue;
    subscriptions.set(token, mode);
    added.push(token);
  }
  if (!added.length) return;

  if (subscriptions.size > MAX_INSTRUMENTS) {
    console.warn(
      `[Prices] ${subscriptions.size} instruments subscribed — over the ${MAX_INSTRUMENTS} per-connection limit`,
    );
  }
  if (connected) send({ action: "subscribe", mode, instruments: added.map(instrumentKey) });
}

export function unsubscribeTokens(tokens: number[]) {
  const byMode = new Map<PriceMode, string[]>();
  for (const t of tokens) {
    const mode = subscriptions.get(t);
    if (!mode) continue;
    subscriptions.delete(t);
    const arr = byMode.get(mode) ?? [];
    arr.push(instrumentKey(t));
    byMode.set(mode, arr);
  }
  if (!connected) return;
  for (const [mode, instruments] of byMode) {
    send({ action: "unsubscribe", mode, instruments });
  }
}

function send(payload: unknown) {
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch (e: any) {
      console.warn("[Prices] send failed:", e.message);
    }
  }
}

export async function startPriceFeed() {
  stopped = false;
  await connect();
}

async function connect() {
  if (stopped) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err: any) {
    console.error("[Prices] Cannot connect — no access token:", err.message);
    scheduleReconnect();
    return;
  }

  ws = new WebSocket(URL_PRICES, { headers: { Authorization: token } });

  ws.on("open", () => {
    connected = true;
    reconnectAttempt = 0;
    console.log(`[Prices] Connected — resubscribing ${subscriptions.size} instrument(s)`);
    // Re-send every subscription; the server keeps no state for us across drops.
    const byMode = new Map<PriceMode, string[]>();
    for (const [tok, mode] of subscriptions) {
      const arr = byMode.get(mode) ?? [];
      arr.push(instrumentKey(tok));
      byMode.set(mode, arr);
    }
    for (const [mode, instruments] of byMode) {
      if (instruments.length) send({ action: "subscribe", mode, instruments });
    }
  });

  ws.on("message", (raw) => {
    const tick = parseFrame(raw.toString());
    if (!tick) return; // heartbeat or unknown frame
    for (const fn of listeners) {
      try { fn([tick]); } catch (e: any) { console.error("[Prices] listener error:", e.message); }
    }
  });

  ws.on("close", () => {
    connected = false;
    console.warn("[Prices] Disconnected");
    scheduleReconnect();
  });

  ws.on("error", (err: any) => {
    console.error("[Prices] Socket error:", err.message);
    // 'close' follows an 'error', so reconnection is scheduled there.
  });
}

/** INDstocks frames look like
 *  { mode, instrument: "2885", timestamp, data: { ltp, oi?, volume? } }
 *  Heartbeats and anything without a price are ignored. */
function parseFrame(text: string): Tick | null {
  let msg: any;
  try { msg = JSON.parse(text); } catch { return null; }

  // The docs note order-update payloads arrive double-encoded; be tolerant.
  if (typeof msg === "string") {
    try { msg = JSON.parse(msg); } catch { return null; }
  }
  if (!msg || typeof msg !== "object") return null;
  if (!msg.data || msg.instrument === undefined) return null;

  const token = Number(msg.instrument);
  const ltp   = Number(msg.data.ltp ?? msg.data.last_price);
  if (!Number.isFinite(token) || !Number.isFinite(ltp)) return null;

  return {
    instrument_token: token,
    last_price: ltp,
    volume_traded: numOrUndef(msg.data.volume ?? msg.data.volume_traded),
    oi: numOrUndef(msg.data.oi),
  };
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(BACKOFF_MIN_MS * 2 ** reconnectAttempt, BACKOFF_MAX_MS);
  reconnectAttempt++;
  console.log(`[Prices] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function stopPriceFeed() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  connected = false;
}

export function priceFeedStatus() {
  return { connected, instruments: subscriptions.size, reconnectAttempt };
}

// Reachable from server.js (plain CommonJS) and from API routes, which Next
// compiles into a separate module graph — see lib/runtime/hub.ts.
//
// `status` is published here too, rather than captured as a closure at boot:
// a closure pins ONE module instance, so if this module is ever re-evaluated
// the status reader and the subscribe writer end up on different copies and
// subscriptions appear to vanish. Registry for both = always the same copy.
// First writer wins. If this module is ever evaluated a second time (a stray
// import from another module graph), the newcomer must NOT replace the copy
// that owns the live socket and the subscription map.
if (!(globalThis as any).__INDMONEY_PRICES__) {
  (globalThis as any).__INDMONEY_PRICES__ = {
    subscribeTokens,
    unsubscribeTokens,
    status: priceFeedStatus,
  };
}
