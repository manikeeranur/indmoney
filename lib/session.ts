// ─── Browser session ──────────────────────────────────────────────────────────
// The INDstocks login is the gate, but the broker token CANNOT be the gate by
// itself. Once anyone logs in, the server holds a token — and if "server has a
// token" meant "you are allowed in", every other visitor would walk straight
// into the account. That was exactly the hole in the first version.
//
// So: logging in proves who you are AND issues a signed cookie. Only browsers
// carrying a valid cookie get past middleware.
//
// Uses Web Crypto (not node:crypto) because Next middleware runs on the edge
// runtime, where node:crypto is unavailable — the same function has to verify
// in both places.

const COOKIE_NAME = "indmoney_session";
/** Sessions are deliberately short: this app can place real orders. */
const MAX_AGE_SEC = 12 * 60 * 60; // 12h

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    // Deliberately fatal rather than falling back to a generated value.
    //
    // This function runs in TWO runtimes: route handlers (Node) and middleware
    // (edge). They do not share globalThis, so a per-process generated secret
    // silently differs between them — the cookie verifies in the route and
    // fails in middleware, and the app locks you out of every page while
    // insisting you are logged in. Only a real shared env value works.
    throw new Error(
      "SESSION_SECRET is missing or too short (need 32+ chars). Sessions cannot be signed.",
    );
  }
  return s;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(sig);
}

/** `<expiryEpochSeconds>.<hmac>` — no secrets or PII in the cookie itself. */
export async function createSessionValue(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = String(exp);
  return `${payload}.${await sign(payload)}`;
}

export async function verifySessionValue(value: string | undefined | null): Promise<boolean> {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = value.slice(0, dot);
  const given   = value.slice(dot + 1);

  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;

  const expected = await sign(payload);
  // Constant-time-ish compare: same length check plus a full-length XOR, so a
  // wrong signature does not leak how much of it was right via timing.
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE = MAX_AGE_SEC;

/** Cookie options. `secure` is on unless we are plainly on localhost, because
 *  this app is intended to sit on a public IP where a cleartext cookie would be
 *  interceptable. */
export function cookieOptions(isLocalhost: boolean) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: !isLocalhost,
    path: "/",
    maxAge: MAX_AGE_SEC,
  };
}
