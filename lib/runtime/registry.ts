// ─── Runtime registry (the ONLY thing API routes may import) ──────────────────
//
// Hard-won rule: **an API route must never import lib/runtime/boot or
// lib/broker/wsPrices.**
//
// Next compiles route handlers into a different module graph from
// instrumentation.ts. Importing boot from a route pulls wsPrices in with it and
// evaluates a SECOND copy of the price feed — one with its own empty
// subscription map and its own (unopened) socket. The symptom is brutal to
// debug: the server log says "[Prices] Connected" while /api/health reports
// connected:false, and every subscription made by a route vanishes, so no
// prices ever stream even though everything looks wired correctly.
//
// This file has NO imports on purpose. It only reads the functions that the
// real runtime published on globalThis, so routes always talk to the one live
// instance that instrumentation.ts booted.

export type PriceFeedStatus = {
  connected: boolean;
  instruments: number;
  reconnectAttempt: number;
};

const EMPTY_FEED: PriceFeedStatus = { connected: false, instruments: 0, reconnectAttempt: 0 };

type PriceRegistry = {
  subscribeTokens: (tokens: number[], mode?: "ltp" | "quote") => void;
  unsubscribeTokens: (tokens: number[]) => void;
  status: () => PriceFeedStatus;
};

type RuntimeRegistry = {
  authenticated: () => boolean;
  configured: () => boolean;
  autoRefresh: () => boolean;
  bootAfterLogin: () => Promise<void>;
  shutdown: () => void;
};

type HubRegistry = {
  broadcast: (payload: unknown) => void;
  clientCount: () => number;
};

const g = () => globalThis as any;

const prices  = (): PriceRegistry | null   => g().__INDMONEY_PRICES__  ?? null;
const runtime = (): RuntimeRegistry | null => g().__INDMONEY_RUNTIME__ ?? null;
const hub     = (): HubRegistry | null     => g().__INDMONEY_HUB__     ?? null;

// ─── Price feed ───────────────────────────────────────────────────────────────
export function subscribeTokens(tokens: number[], mode: "ltp" | "quote" = "ltp") {
  prices()?.subscribeTokens(tokens, mode);
}

export function unsubscribeTokens(tokens: number[]) {
  prices()?.unsubscribeTokens(tokens);
}

export function priceFeedStatus(): PriceFeedStatus {
  return prices()?.status() ?? EMPTY_FEED;
}

// ─── Runtime ──────────────────────────────────────────────────────────────────
export function isAuthenticated(): boolean { return runtime()?.authenticated() ?? false; }
export function isConfigured():    boolean { return runtime()?.configured()    ?? false; }
export function canAutoRefresh():  boolean { return runtime()?.autoRefresh()   ?? false; }

/** Bring market data up after a successful login, on the LIVE runtime. */
export async function bootAfterLogin(): Promise<void> {
  await runtime()?.bootAfterLogin();
}

export function runtimeState() {
  const s = g().__INDMONEY_STATE__;
  return {
    booted:    !!s?.booted,
    bootError: (s?.bootError ?? null) as string | null,
    lotSize:   (s?.lotSize ?? null) as number | null,
  };
}

// ─── Browser hub ──────────────────────────────────────────────────────────────
export function broadcastToBrowsers(payload: unknown) { hub()?.broadcast(payload); }
export function browserClientCount(): number { return hub()?.clientCount() ?? 0; }
