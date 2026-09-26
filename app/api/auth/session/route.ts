import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionValue } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

/** Public on purpose: it only ever answers yes/no about the caller's own
 *  cookie, so it cannot be used to learn anything about the account. */
export async function GET() {
  const jar = await cookies();
  const ok  = await verifySessionValue(jar.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ session: ok });
}
