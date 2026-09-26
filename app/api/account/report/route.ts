import { NextResponse } from "next/server";
import DailyPnL from "@/lib/db/models/DailyPnL";
import { isConnected } from "@/lib/db/connect";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

function weekdaysBetween(fromStr: string, toStr: string): string[] {
  const days: string[] = [];
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) days.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const row = (cols: unknown[]) => cols.map(cell).join(",");

export async function GET(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!isConnected()) return NextResponse.json({ error: "Database not connected" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from"), to = searchParams.get("to"), type = searchParams.get("type") ?? "trades";
  if (!from || !to) return NextResponse.json({ error: "from and to are required" }, { status: 400 });

  try {
    const snapshots = await DailyPnL.find({ date: { $gte: from, $lte: to } }).sort({ date: 1 });
    const snapMap: Record<string, any> = Object.fromEntries(snapshots.map((r: any) => [r.date, r]));
    const allDays = weekdaysBetween(from, to);
    const multiDay = from !== to;
    const activeDays = allDays.filter(d => snapMap[d]);
    if (!activeDays.length) {
      return NextResponse.json({ error: "No trading data found for this period. Data is saved daily from 3:31 PM IST." }, { status: 404 });
    }

    let csv = "";
    if (type === "summary") {
      csv += row(["Date","Trades","Winners","Losers","Win Rate (%)","Gross P&L (₹)","Charges (₹)","Net P&L (₹)"]) + "\n";
      let tTrades = 0, tWinners = 0, tLosers = 0, tGross = 0, tCharges = 0;
      for (const date of activeDays) {
        const r = snapMap[date];
        const closed = (r.positions || []).filter((p: any) => p.status === "CLOSED");
        const winners = closed.filter((p: any) => p.pnl > 0).length;
        const losers = closed.filter((p: any) => p.pnl < 0).length;
        const winRate = closed.length ? (winners / closed.length * 100).toFixed(1) : "0.0";
        const gross = +(r.pnl?.total ?? 0), chrgs = +(r.charges?.total ?? 0);
        csv += row([date, closed.length, winners, losers, winRate, gross.toFixed(2), chrgs.toFixed(2), (gross - chrgs).toFixed(2)]) + "\n";
        tTrades += closed.length; tWinners += winners; tLosers += losers; tGross += gross; tCharges += chrgs;
      }
      const tWinRate = tTrades ? (tWinners / tTrades * 100).toFixed(1) : "0.0";
      csv += "\n" + row(["OVERALL TOTAL", tTrades, tWinners, tLosers, tWinRate, tGross.toFixed(2), tCharges.toFixed(2), (tGross - tCharges).toFixed(2)]) + "\n";
      return new NextResponse(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="pnl_summary_${from}_${to}.csv"` } });
    }

    csv += row(["Date","Symbol","Direction","Strike","Qty","Entry Time","Exit Time","Entry Price (₹)","Exit Price (₹)","Gross P&L (₹)","Status"]) + "\n";
    let overallPnl = 0, overallCharges = 0;
    for (const date of activeDays) {
      const r = snapMap[date];
      const dayPos = r.positions || [];
      for (const p of dayPos) csv += row([date, p.tradingsymbol, p.direction, p.strike ?? "", p.quantity, p.entryTime ?? "", p.exitTime ?? "", p.buyPrice, p.sellPrice || "", p.pnl, p.status]) + "\n";
      const dailyPnl = dayPos.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
      const dailyCharges = +(r.charges?.total ?? 0);
      overallPnl += dailyPnl; overallCharges += dailyCharges;
      if (multiDay) {
        csv += row([`${date} — Daily Gross`, "", "", "", "", "", "", "", "", dailyPnl.toFixed(2), ""]) + "\n";
        csv += row([`${date} — Charges`, "", "", "", "", "", "", "", "", `-${dailyCharges.toFixed(2)}`, ""]) + "\n";
        csv += row([`${date} — Net P&L`, "", "", "", "", "", "", "", "", (dailyPnl - dailyCharges).toFixed(2), ""]) + "\n\n";
      }
    }
    csv += row(["OVERALL GROSS P&L", "", "", "", "", "", "", "", "", overallPnl.toFixed(2), ""]) + "\n";
    csv += row(["OVERALL CHARGES", "", "", "", "", "", "", "", "", `-${overallCharges.toFixed(2)}`, ""]) + "\n";
    csv += row(["NET P&L (FINAL)", "", "", "", "", "", "", "", "", (overallPnl - overallCharges).toFixed(2), ""]) + "\n";
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="pnl_trades_${from}_${to}.csv"` } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
