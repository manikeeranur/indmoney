import { NextResponse } from "next/server";
import { getAlerts } from "@/lib/runtime/alertStore";
import { vwap930Config } from "@/lib/runtime/engines";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const expiry = new URL(req.url).searchParams.get("expiry");
  if (!expiry) return NextResponse.json({ error: "expiry required" }, { status: 400 });
  return NextResponse.json(await getAlerts(vwap930Config, expiry));
}
