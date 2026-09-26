import { NextResponse } from "next/server";
import { placeOrder } from "@/lib/broker/orders";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { security_id, tradingsymbol, quantity, limit_price } = await req.json().catch(() => ({}));
  if (!security_id || !quantity || !limit_price) {
    return NextResponse.json({ error: "security_id, quantity and limit_price are required" }, { status: 400 });
  }
  try {
    const orderId = await placeOrder({ txnType: "SELL", securityId: String(security_id), qty: Number(quantity), limitPrice: Number(limit_price), remarks: "MANUAL_EXIT" });
    console.log(`[Account/Exit] Manual exit — ${tradingsymbol ?? security_id} × ${quantity}  [${orderId}]`);
    return NextResponse.json({ order_id: orderId, tradingsymbol, quantity });
  } catch (err: any) {
    console.error("[Account/Exit] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
