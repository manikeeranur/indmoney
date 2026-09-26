import { NextResponse } from "next/server";
import Alert from "@/lib/db/models/Alert";
import Vwap930Alert from "@/lib/db/models/Vwap930Alert";
import BacktestResult from "@/lib/db/models/BacktestResult";
import Vwap930BacktestResult from "@/lib/db/models/Vwap930BacktestResult";
import { isConnected } from "@/lib/db/connect";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

function modelsFor(strategy: string) {
  return strategy === "vwap930"
    ? { AlertModel: Vwap930Alert, BacktestModel: Vwap930BacktestResult }
    : { AlertModel: Alert, BacktestModel: BacktestResult };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const strategy = searchParams.get("strategy") === "vwap930" ? "vwap930" : "smc";
  const { AlertModel, BacktestModel } = modelsFor(strategy);
  if (!isConnected()) return NextResponse.json({ summary: [] });

  try {
    // "TIME_PROFIT" only exists in OLD records from before the strategies were
    // refactored to a single "TIME_EXIT" status (win/loss then read off the
    // sign of currentPnL) — both journal/page.tsx and results/page.tsx already
    // count a profitable TIME_EXIT as a win for that reason. This aggregation
    // needs the same OR, or every current/future profitable 15:20 time-exit
    // silently counts as a loss in the calendar heatmap.
    if (type === "live") {
      const agg = await AlertModel.aggregate([
        { $group: { _id: "$date", totalPnL: { $sum: "$currentPnL" }, trades: { $sum: 1 }, wins: { $sum: { $cond: [{ $or: [
          { $in: ["$status", ["TARGET", "TIME_PROFIT"]] },
          { $and: [{ $eq: ["$status", "TIME_EXIT"] }, { $gte: ["$currentPnL", 0] }] },
        ] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
      ]);
      return NextResponse.json({ summary: agg.map((r: any) => ({ date: r._id, totalPnL: r.totalPnL ?? 0, trades: r.trades, wins: r.wins })) });
    }
    if (type === "backtest") {
      const docs = await BacktestModel.find({}, { date: 1, results: 1 }).lean();
      const summary = docs.map((doc: any) => {
        const rows = doc.results ?? [];
        const totalPnL = rows.reduce((s: number, r: any) => s + (r.currentPnL ?? 0), 0);
        const wins = rows.filter((r: any) =>
          r.status === "TARGET" || r.status === "TIME_PROFIT" || (r.status === "TIME_EXIT" && (r.currentPnL ?? 0) >= 0)
        ).length;
        return { date: doc.date, totalPnL, trades: rows.length, wins };
      }).sort((a: any, b: any) => a.date.localeCompare(b.date));
      return NextResponse.json({ summary });
    }
    return NextResponse.json({ error: "type must be live or backtest" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
