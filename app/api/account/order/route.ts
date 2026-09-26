import { NextResponse } from "next/server";
import { placeOrder } from "@/lib/broker/orders";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { tradingsymbol, security_id, transaction_type, quantity, limit_price } = body;
  if (!security_id || !transaction_type || !quantity || !limit_price) {
    return NextResponse.json({ error: "security_id, transaction_type, quantity and limit_price are required" }, { status: 400 });
  }
  if (!["BUY", "SELL"].includes(transaction_type)) {
    return NextResponse.json({ error: "transaction_type must be BUY or SELL" }, { status: 400 });
  }
  try {
    const orderId = await placeOrder({ txnType: transaction_type, securityId: String(security_id), qty: Number(quantity), limitPrice: Number(limit_price), remarks: "CHAIN_ORDER" });
    console.log(`[Account/Order] ${transaction_type} ${tradingsymbol ?? security_id} × ${quantity}  [${orderId}]`);
    return NextResponse.json({ order_id: orderId, tradingsymbol, transaction_type, quantity });
  } catch (err: any) {
    console.error("[Account/Order] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
