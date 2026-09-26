import { NextResponse } from "next/server";
import { placeOrder } from "@/lib/broker/orders";
import { buildAccountData } from "@/lib/runtime/accountService";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function POST() {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const data = await buildAccountData();
    const open = data.positions.filter(p => p.status === "OPEN");
    if (!open.length) return NextResponse.json({ exited: [], message: "No open positions" });

    const results = [];
    for (const pos of open) {
      try {
        const orderId = await placeOrder({ txnType: "SELL", securityId: pos.tradingsymbol, qty: pos.quantity, limitPrice: pos.currentPrice || pos.buyPrice, remarks: "MANUAL_EXIT_ALL" });
        results.push({ tradingsymbol: pos.tradingsymbol, order_id: orderId, ok: true });
      } catch (err: any) {
        results.push({ tradingsymbol: pos.tradingsymbol, error: err.message, ok: false });
      }
    }
    return NextResponse.json({ exited: results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
