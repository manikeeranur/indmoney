import { NextResponse } from "next/server";
import { getHistorical, getATM, scripCode, indexScripCode } from "@/lib/broker/marketdata";
import { getFnoInstruments } from "@/lib/broker/instruments";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

const NIFTY_INDEX_ID = 40000001;

// GET /api/historical-open-prices?date=&expiry=
// Fetches NIFTY spot at 9:15 AM on the selected date, the historical ATM, and
// ±15 strikes' 9:15 AM opening prices — mirrors backend's
// optionChain.js /historical-open-prices exactly (same response shape), so
// the OHLC tab needs no changes.
export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  const expiry = searchParams.get("expiry");
  if (!date || !expiry) return NextResponse.json({ error: "date and expiry are required" }, { status: 400 });

  try {
    const from = new Date(`${date}T09:15:00+05:30`);
    const to   = new Date(`${date}T09:16:00+05:30`);

    const spotCode = indexScripCode(NIFTY_INDEX_ID, "NIFTY");
    const spotMap = await getHistorical([spotCode], "1minute", from, to, "NIFTY");
    const spot = spotMap[spotCode]?.[0]?.open ?? 0;
    const atm = getATM(spot);

    const instruments = await getFnoInstruments();
    const wanted = new Set<number>();
    for (let off = -15; off <= 15; off++) wanted.add(atm + off * 50);

    const byStrike = new Map<number, { ce?: { token: number }; pe?: { token: number } }>();
    for (const inst of instruments) {
      if (inst.name !== "NIFTY" || inst.kind !== "OPTIDX" || inst.expiry !== expiry || inst.strike == null) continue;
      if (!wanted.has(inst.strike)) continue;
      const row = byStrike.get(inst.strike) ?? {};
      if (inst.type === "CE") row.ce = { token: inst.token };
      if (inst.type === "PE") row.pe = { token: inst.token };
      byStrike.set(inst.strike, row);
    }

    const allTokens = [...byStrike.values()].flatMap(r => [r.ce?.token, r.pe?.token]).filter((t): t is number => !!t);
    const codes = allTokens.map(t => scripCode(t, "NIFTY"));
    const openMap = await getHistorical(codes, "1minute", from, to, "NIFTY");

    const rows = [...byStrike.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, r]) => ({
        strike, isATM: strike === atm,
        ce: { token: r.ce?.token ?? null, open: r.ce ? (openMap[scripCode(r.ce.token, "NIFTY")]?.[0]?.open ?? null) : null },
        pe: { token: r.pe?.token ?? null, open: r.pe ? (openMap[scripCode(r.pe.token, "NIFTY")]?.[0]?.open ?? null) : null },
      }));

    return NextResponse.json({ spot, atm, rows });
  } catch (err: any) {
    console.error("[HistoricalOpenPrices] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
