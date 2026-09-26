import { NextResponse } from "next/server";
import { getLtp } from "@/lib/broker/marketdata";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// GET /api/quotes?codes=NSE_2885,BSE_500325 — thin wrapper over getLtp() for
// instruments that aren't already streaming on the chain WebSocket (equity
// watchlist items). Generic and reusable, not tied to the Watchlist tab.
export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const codes = (new URL(req.url).searchParams.get("codes") ?? "").split(",").map(c => c.trim()).filter(Boolean);
  if (!codes.length) return NextResponse.json({ quotes: {} });
  try {
    const quotes = await getLtp(codes);
    return NextResponse.json({ quotes });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
