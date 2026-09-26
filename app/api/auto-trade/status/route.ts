import { NextResponse } from "next/server";
import { isEnabled, getPositionsList } from "@/lib/runtime/autoTrade";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({ enabled: isEnabled("smc"), positions: getPositionsList("smc") });
}
