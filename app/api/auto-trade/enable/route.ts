import { NextResponse } from "next/server";
import { setEnabled } from "@/lib/runtime/autoTrade";
import { setAutoTradeEnabled } from "@/lib/runtime/settingsService";
import { sendAutoTradeStarted } from "@/lib/telegram/smcTelegram";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function POST() {
  try { await setAutoTradeEnabled("smc", true); }
  catch (err: any) { return NextResponse.json({ error: `Failed to persist enable state: ${err.message}` }, { status: 500 }); }
  setEnabled("smc", true);
  sendAutoTradeStarted();
  return NextResponse.json({ enabled: true });
}
