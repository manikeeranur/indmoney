import { NextResponse } from "next/server";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// Ported from backend/src/routes/holidays.js — Upstox's free public holiday
// calendar, cached process-wide (anchored on globalThis, since the scanner's
// crons and this route are separate module graphs and must share one cache).
const UPSTOX_HOLIDAYS_URL = "https://api.upstox.com/v2/market/holidays";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

type Holiday = { date: string; name: string };
function cache(): { at: number; holidays: Holiday[] } {
  const g = globalThis as any;
  g.__INDMONEY_HOLIDAYS__ ??= { at: 0, holidays: [] };
  return g.__INDMONEY_HOLIDAYS__;
}

function isFullHoliday(entry: any): boolean {
  return !!entry.closed_exchanges?.includes("NSE") && !entry.open_exchanges?.some((e: any) => e.exchange === "NSE");
}

async function fetchHolidays(): Promise<Holiday[]> {
  const res = await fetch(UPSTOX_HOLIDAYS_URL);
  if (!res.ok) throw new Error(`Upstox holidays fetch failed: ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).filter(isFullHoliday).map((e: any) => ({ date: e.date, name: e.description })).sort((a: Holiday, b: Holiday) => a.date.localeCompare(b.date));
}

export async function GET() {
  const c = cache();
  try {
    if (Date.now() - c.at > CACHE_TTL_MS || c.holidays.length === 0) {
      c.at = Date.now();
      c.holidays = await fetchHolidays();
    }
    return NextResponse.json({ holidays: c.holidays });
  } catch (err: any) {
    if (c.holidays.length > 0) return NextResponse.json({ holidays: c.holidays, stale: true });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
