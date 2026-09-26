import { NextResponse } from "next/server";
import { buildAccountData } from "@/lib/runtime/accountService";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function GET() {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const data = await buildAccountData();
    return NextResponse.json({ positions: data.positions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
