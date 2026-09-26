// ─── Process-wide runtime state ───────────────────────────────────────────────
// Next compiles instrumentation.ts, route handlers and server components into
// SEPARATE module graphs. A plain module-level `let` is therefore NOT one value
// per process — each graph gets its own copy, so the runtime booted by
// instrumentation is invisible to an API route importing the same file.
//
// Everything that must be singular for the whole process — the boot result, the
// broker feed status, the alert stores — is anchored on globalThis here, and
// read through this module. This is the same reason lib/runtime/browserHub.js
// publishes itself on globalThis for server.js.

export type PriceFeedStatus = {
  connected: boolean;
  instruments: number;
  reconnectAttempt: number;
};

export type RuntimeState = {
  booted: boolean;
  bootError: string | null;
  lotSize: number | null;
  /** Registered by boot() so status readers get the LIVE feed, not a copy. */
  priceFeedStatus: (() => PriceFeedStatus) | null;
  /** Registered by boot() so status readers see the live token, not a copy. */
  authenticated: (() => boolean) | null;
};

const KEY = "__INDMONEY_STATE__";

export function state(): RuntimeState {
  const g = globalThis as any;
  g[KEY] ??= {
    booted: false,
    bootError: null,
    lotSize: null,
    priceFeedStatus: null,
    authenticated: null,
  } satisfies RuntimeState;
  return g[KEY] as RuntimeState;
}
