import { NextResponse } from "next/server";
import { getExpiries } from "@/lib/broker/instruments";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ expiries: await getExpiries("NIFTY") });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
