import { NextResponse } from "next/server";
import { loginWithTotp, setAccessToken } from "@/lib/broker/auth";
import { bootAfterLogin } from "@/lib/runtime/registry";
import { createSessionValue, SESSION_COOKIE, cookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

// ─── Brute-force guard ────────────────────────────────────────────────────────
// This endpoint is the ONE public door on an app that can place real orders,
// and it is intended to sit on a public IP. INDstocks itself locks the account
// after 5 bad TOTP codes, so an attacker spraying codes would lock the OWNER
// out — the throttle protects availability as much as access.
const WINDOW_MS   = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

type Bucket = { count: number; first: number };
function attempts(): Map<string, Bucket> {
  const g = globalThis as any;
  g.__INDMONEY_LOGIN_ATTEMPTS__ ??= new Map<string, Bucket>();
  return g.__INDMONEY_LOGIN_ATTEMPTS__;
}

function rateLimited(ip: string): boolean {
  const m = attempts();
  const b = m.get(ip);
  const now = Date.now();
  if (!b || now - b.first > WINDOW_MS) { m.set(ip, { count: 0, first: now }); return false; }
  return b.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string) {
  const m = attempts();
  const b = m.get(ip) ?? { count: 0, first: Date.now() };
  b.count++;
  m.set(ip, b);
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : null)?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Wait 10 minutes and try again." },
      { status: 429 },
    );
  }

  let body: any;
  try { body = await req.json(); } catch { return bad(ip, "Invalid request body"); }

  const mode = body?.mode === "token" ? "token" : "totp";

  try {
    if (mode === "token") {
      const token = String(body?.token ?? "").trim();
      if (!token) return bad(ip, "Paste an access token");
      // Prove the token works BEFORE accepting it, so the UI can't show a green
      // "logged in" state for a token that is already dead.
      const check = await fetch(
        `${process.env.IND_API_BASE || "https://api.indstocks.com"}/user/profile`,
        { headers: { Authorization: token } },
      );
      if (!check.ok) return bad(ip, `INDstocks rejected that token (HTTP ${check.status})`);
      setAccessToken(token);
    } else {
      const mpin = String(body?.mpin ?? "").trim();
      const totp = String(body?.totp ?? "").trim();
      if (!/^\d{4,6}$/.test(mpin)) return bad(ip, "MPIN must be 4–6 digits");
      if (!/^\d{6}$/.test(totp))   return bad(ip, "Authenticator code must be 6 digits");
      await loginWithTotp({ clientId: body?.clientId, mpin, totp });
    }

    // Credentials are good: issue this browser a session, then bring market
    // data up. The session is what actually gates the UI — see lib/session.ts.
    const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(
      new URL(req.url).host,
    );
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, await createSessionValue(), cookieOptions(isLocalhost));

    attempts().delete(ip); // successful login clears the throttle

    await bootAfterLogin();
    return res;
  } catch (err: any) {
    return bad(ip, err.message ?? "Login failed");
  }
}

function bad(ip: string, error: string) {
  recordFailure(ip);
  return NextResponse.json({ ok: false, error }, { status: 400 });
}
