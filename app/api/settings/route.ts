import { NextResponse } from "next/server";
import { loadOrCreate } from "@/lib/runtime/settingsService";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function GET() {
  try { return NextResponse.json(await loadOrCreate()); }
  catch (err: any) { return NextResponse.json({ error: err.message }, { status: 500 }); }
}
