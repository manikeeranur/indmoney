import { NextResponse } from "next/server";
import { clearAccessToken } from "@/lib/broker/auth";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function POST() {
  // Drop BOTH: this browser's session and the server's broker token. With the
  // INDstocks login acting as the gate, signing out means the app is fully
  // locked again rather than just this tab being forgotten.
  clearAccessToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
