import { NextResponse } from "next/server";
import { getExpiries } from "@/lib/broker/instruments";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET(req: Request) {
  const index = (new URL(req.url).searchParams.get("index") ?? "NIFTY") as "NIFTY" | "SENSEX";
  try {
    return NextResponse.json({ expiries: await getExpiries(index) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
