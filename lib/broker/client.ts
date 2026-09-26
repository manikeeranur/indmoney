// ─── INDstocks REST client ────────────────────────────────────────────────────
// Every outbound INDstocks call goes through here. This is a direct descendant
// of the old app's kiteRateLimiter.js, which existed because independent call
// sites (two per-minute scanners + a polling dashboard + P&L refresh) landed in
// the same second and blew the broker's rate limit. Same fix, now with the
// per-category limits INDstocks documents:
//
//   Order APIs        10 / sec
//   Data + Quote APIs  5 / sec   and 100,000 / day
//   Non-trading APIs  15 / sec
//
// The daily cap is the new constraint Kite never had. The app is designed to
// stay far below it by pushing prices over the WebSocket instead of polling,
// but the counter here makes that measurable rather than assumed.

import { getAccessToken, refreshAccessToken } from "./auth";

const BASE = process.env.IND_API_BASE || "https://api.indstocks.com";

export type Category = "data" | "order" | "nonTrading";

/** Minimum spacing between outbound calls, per category. Slightly slower than
 *  the documented ceiling so a burst never trips a 429 in the first place. */
const MIN_INTERVAL_MS: Record<Category, number> = {
  data:       210, // ~4.7/s against a 5/s limit
  order:      110, // ~9/s   against a 10/s limit
  nonTrading:  70, // ~14/s  against a 15/s limit
};

const MAX_RETRIES     = 4;
const BASE_BACKOFF_MS = 500;
const DAILY_CAP       = 100_000;
const DAILY_WARN_AT   = 80_000;

// One queue per category so a slow data call cannot delay an exit order.
const queues: Record<Category, { tail: Promise<unknown>; lastAt: number }> = {
  data:       { tail: Promise.resolve(), lastAt: 0 },
  order:      { tail: Promise.resolve(), lastAt: 0 },
  nonTrading: { tail: Promise.resolve(), lastAt: 0 },
};

// ─── Daily usage counter (IST day) ────────────────────────────────────────────
// Anchored on globalThis, not module scope: this module is evaluated once in
// the instrumentation graph (boot's instrument download) and again in the route
// graph (chain requests). Two module-level counters would each see half the
// traffic and the 100,000/day cap would be blown long before either noticed.
type Usage = { date: string; count: number; warned: boolean };

function istDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function usageState(): Usage {
  const g = globalThis as any;
  g.__INDMONEY_USAGE__ ??= { date: istDate(), count: 0, warned: false } satisfies Usage;
  return g.__INDMONEY_USAGE__ as Usage;
}

function countCall() {
  const u     = usageState();
  const today = istDate();
  if (today !== u.date) { u.date = today; u.count = 0; u.warned = false; }
  u.count++;
  if (u.count >= DAILY_WARN_AT && !u.warned) {
    u.warned = true;
    console.warn(`[Broker] ${u.count} INDstocks calls today — approaching the ${DAILY_CAP}/day cap`);
  }
}

export function usage() {
  const u = usageState();
  return { date: u.date, count: u.count, cap: DAILY_CAP };
}

// ─── Throttle ─────────────────────────────────────────────────────────────────
function schedule<T>(cat: Category, fn: () => Promise<T>): Promise<T> {
  const q = queues[cat];
  const run = q.tail.then(async () => {
    const wait = Math.max(0, q.lastAt + MIN_INTERVAL_MS[cat] - Date.now());
    if (wait > 0) await sleep(wait);
    q.lastAt = Date.now();
    return fn();
  }) as Promise<T>;
  // Swallow on the queue chain only, so one failure doesn't wedge the queue.
  q.tail = run.catch(() => {});
  return run;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export class BrokerError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "BrokerError";
    this.status = status;
    this.code = code;
  }
}

type RequestOpts = {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  category?: Category;
  /** Internal: prevents an infinite 401 → refresh → 401 loop. */
  _retriedAuth?: boolean;
};

/**
 * One INDstocks REST call, rate-limited, with 429 backoff and one automatic
 * token refresh on 401.
 */
export async function request<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", query, body, category = "data" } = opts;

  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getAccessToken();

    const res = await schedule(category, () => {
      countCall();
      return fetch(url.toString(), {
        method,
        headers: {
          Authorization: token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    });

    // 429 — back off and retry.
    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        const backoff = BASE_BACKOFF_MS * 2 ** attempt;
        console.warn(`[Broker] 429 on ${path} — backing off ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw new BrokerError(`Rate limited by INDstocks on ${path}`, 429);
    }

    // 401 — the token died early (revoked, or another process minted one).
    // Refresh once and retry; never loop.
    if (res.status === 401 && !opts._retriedAuth) {
      console.warn(`[Broker] 401 on ${path} — refreshing token and retrying once`);
      await refreshAccessToken();
      return request<T>(path, { ...opts, _retriedAuth: true });
    }

    const json = await res.json().catch(() => null) as any;

    if (!res.ok) {
      const msg = json?.message || json?.error || `HTTP ${res.status}`;
      throw new BrokerError(`${method} ${path} failed: ${msg}`, res.status, json?.error_code);
    }

    // INDstocks wraps payloads as { status: "success", data } or { success, data }.
    if (json && typeof json === "object" && "status" in json && json.status !== "success") {
      throw new BrokerError(
        `${method} ${path} returned status=${json.status}: ${json.message ?? ""}`,
        res.status,
        json.error_code,
      );
    }

    return (json?.data ?? json) as T;
  }

  throw new BrokerError(`${method} ${path} exhausted retries`, 429);
}

/** Raw text fetch — the instruments master is served as a CSV file, not JSON. */
export async function requestText(path: string, query?: Record<string, string>): Promise<string> {
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  const token = await getAccessToken();
  const res = await schedule("nonTrading", () => {
    countCall();
    return fetch(url.toString(), { headers: { Authorization: token } });
  });

  if (!res.ok) throw new BrokerError(`GET ${path} failed: HTTP ${res.status}`, res.status);
  return res.text();
}
