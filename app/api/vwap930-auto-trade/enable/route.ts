import { NextResponse } from "next/server";
import { setEnabled } from "@/lib/runtime/autoTrade";
import { setAutoTradeEnabled } from "@/lib/runtime/settingsService";
import { sendVwap930AutoTradeStarted } from "@/lib/telegram/vwap930Telegram";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function POST() {
  try { await setAutoTradeEnabled("vwap930", true); }
  catch (err: any) { return NextResponse.json({ error: `Failed to persist enable state: ${err.message}` }, { status: 500 }); }
  setEnabled("vwap930", true);
  sendVwap930AutoTradeStarted();
  return NextResponse.json({ enabled: true });
}
