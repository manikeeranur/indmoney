import { NextResponse } from "next/server";
import { runEodOhlcReport, todayIST } from "@/lib/telegram/eodOhlcReport";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const date = String(url.searchParams.get("date") || body?.date || todayIST());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    return NextResponse.json(await runEodOhlcReport({ date }));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
