import { NextResponse } from "next/server";
import { patchAccountDefaults } from "@/lib/runtime/settingsService";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function PATCH(req: Request) {
  try { return NextResponse.json(await patchAccountDefaults(await req.json().catch(() => ({})))); }
  catch (err: any) { return NextResponse.json({ error: err.message }, { status: err.status ?? 500 }); }
}
