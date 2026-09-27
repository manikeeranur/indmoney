import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/runtime/registry";
import { getAccessToken } from "@/lib/broker/auth";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// GET /api/auth/token-value — ported from the Kite app's own route (same
// name, same purpose: "use once to copy into [a deployment's] env var").
// Returns the CURRENT access token so the UI can offer a one-click copy —
// e.g. to hand-set IND_ACCESS_TOKEN on a server that isn't running TOTP
// auto-refresh yet.
export async function GET() {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const access_token = await getAccessToken();
    return NextResponse.json({ access_token });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
