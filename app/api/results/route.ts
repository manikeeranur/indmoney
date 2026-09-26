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

// VWAP 9:30 has a single target (no T1/T2) — mapped into both slots so the
// shared SMC-shaped table/journal UI renders it unchanged.
function mapRow(a: any, strategy: string) {
  const isVwap = strategy === "vwap930";
  const target1 = isVwap ? a.rr?.target : a.rr?.target1;
  const target2 = isVwap ? a.rr?.target : a.rr?.target2;
  const t1Hit = isVwap ? a.status === "TARGET" : !!a.t1Hit;
  return {
    EntryTime: a.entryTime ?? "", ExitTime: a.exitTime ?? "", Direction: a.direction ?? "", Strike: String(a.strike ?? ""),
    Entry: String(a.rr?.entry?.toFixed(2) ?? ""), SL: String(a.rr?.sl?.toFixed(2) ?? ""),
    Target1: String(target1?.toFixed(2) ?? ""), Target2: String(target2?.toFixed(2) ?? ""),
    Status: a.status ?? "", T1Hit: t1Hit ? "Y" : "N",
    T1HitTime: (isVwap ? (t1Hit ? a.exitTime ?? "" : "") : a.t1HitTime) ?? "",
    PnL: String(a.currentPnL?.toFixed(2) ?? "0"), PnLPct: String(a.pnlPct?.toFixed(2) ?? "0"),
    Concepts: isVwap ? (a.vwap != null ? `VWAP ₹${Number(a.vwap).toFixed(2)}` : "") : (a.concepts ?? []).join("+"),
    MaxPoints: String(a.peakMove?.toFixed(2) ?? "0"), Spot: String(a.spot?.toFixed(2) ?? ""), Expiry: a.expiry ?? "",
  };
}

export async function GET(req: Request) {
  const res = NextResponse;
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type"), date = searchParams.get("date");
  const strategy = searchParams.get("strategy") === "vwap930" ? "vwap930" : "smc";
  const { AlertModel, BacktestModel } = modelsFor(strategy);

  if (type && date) {
    if (!isConnected()) return res.json({ error: "MongoDB not connected" }, { status: 503 });
    try {
      if (type === "live") {
        const docs = await AlertModel.find({ date }).sort({ createdAt: 1 }).lean();
        return res.json({ rows: docs.map((a: any) => mapRow(a, strategy)) });
      }
      if (type === "backtest") {
        const doc: any = await BacktestModel.findOne({ date }).lean();
        if (!doc) return res.json({ rows: [] });
        return res.json({ rows: (doc.results ?? []).map((a: any) => mapRow(a, strategy)) });
      }
      return res.json({ error: "type must be live or backtest" }, { status: 400 });
    } catch (err: any) {
      return res.json({ error: err.message }, { status: 500 });
    }
  }

  if (!isConnected()) return res.json({ backtest: [], live: [] });
  try {
    const [liveDates, backtestDates] = await Promise.all([
      AlertModel.distinct("date").then((d: string[]) => d.sort().reverse()),
      BacktestModel.distinct("date").then((d: string[]) => d.sort().reverse()),
    ]);
    return res.json({ live: liveDates, backtest: backtestDates });
  } catch (err: any) {
    return res.json({ error: err.message }, { status: 500 });
  }
}
