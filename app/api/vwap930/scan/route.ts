import { NextResponse } from "next/server";
import { doScan } from "@/lib/runtime/alertStore";
import { vwap930Config } from "@/lib/runtime/engines";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const url = new URL(req.url);
  const expiry = url.searchParams.get("expiry") ?? (await req.json().catch(() => ({})))?.expiry;
  if (!expiry) return NextResponse.json({ error: "expiry required" }, { status: 400 });
  // Built manually, not via toLocaleTimeString(hour12:false) — that idiom
  // renders midnight IST as "24:MM" instead of "00:MM" on Node's ICU (verified
  // live), a cosmetic bug the original Kite app also had. This field is
  // display-only (never used for a trading decision), but there is no reason
  // to carry the bug forward when avoiding it costs nothing.
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const time = `${String(ist.getHours()).padStart(2, "0")}:${String(ist.getMinutes()).padStart(2, "0")}`;
  doScan(vwap930Config, expiry); // non-blocking, matches the old app's fire-and-forget scan
  return NextResponse.json({ queued: true, time });
}
