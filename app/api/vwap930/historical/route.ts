import { NextResponse } from "next/server";
import { runBacktest } from "@/lib/runtime/alertStore";
import { vwap930Config } from "@/lib/runtime/engines";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date"), expiry = searchParams.get("expiry");
  if (!date || !expiry) return NextResponse.json({ error: "date and expiry are required" }, { status: 400 });
  const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const marketClosed = nowIST.getHours() > 15 || (nowIST.getHours() === 15 && nowIST.getMinutes() >= 30);
  if (date > todayIST || (date === todayIST && !marketClosed)) {
    return NextResponse.json({ error: "date must be a past date, or today after market close (3:30 PM IST), for backtesting" }, { status: 400 });
  }
  try {
    console.log(`[VWAP930 Historical] Backtesting ${date} expiry ${expiry}...`);
    const result = await runBacktest(vwap930Config, date, expiry);
    console.log(`[VWAP930 Historical] Done — ${result.totalSignals} signals, winRate ${result.winRate}%`);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
