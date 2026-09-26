import { NextResponse } from "next/server";
import { buildAccountData, saveSnapshot } from "@/lib/runtime/accountService";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

function todayIST() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }

export async function GET() {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const data = await buildAccountData();
    saveSnapshot(todayIST(), data.positions, data.charges, data.pnl).catch(() => {});
    return NextResponse.json(data);
  } catch (err: any) {
    console.error("[Account] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
