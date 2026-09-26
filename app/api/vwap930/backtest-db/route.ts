import { NextResponse } from "next/server";
import { getBacktestFromDb } from "@/lib/runtime/alertStore";
import { vwap930Config } from "@/lib/runtime/engines";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });
  try {
    return NextResponse.json(await getBacktestFromDb(vwap930Config, date));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
