import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function POST() {
  // UI logout only — the same contract as the original Kite app's own
  // POST /api/auth/logout ("backend token retained, scanning continues").
  // The scanners, auto-trade engine and scheduler are server-side processes
  // that don't know or care whether a browser tab is logged in; killing the
  // broker token here would silently stop live trading every time someone
  // logs out of the UI, which is not what "logout" should mean for a
  // background trading process. Only this browser's session cookie is
  // cleared — the broker token (and TOTP auto-refresh, once configured)
  // keeps working regardless.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
