import { NextResponse } from "next/server";
import { setEnabled } from "@/lib/runtime/autoTrade";
import { setAutoTradeEnabled } from "@/lib/runtime/settingsService";
import { sendAutoTradeStopped } from "@/lib/telegram/smcTelegram";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function POST() {
  try { await setAutoTradeEnabled("smc", false); }
  catch (err: any) { return NextResponse.json({ error: `Failed to persist disable state: ${err.message}` }, { status: 500 }); }
  setEnabled("smc", false);
  sendAutoTradeStopped();
  return NextResponse.json({ enabled: false });
}
