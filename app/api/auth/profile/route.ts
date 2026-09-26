import { NextResponse } from "next/server";
import { request } from "@/lib/broker/client";
import { isAuthenticated } from "@/lib/runtime/registry";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

// GET /api/auth/profile — INDstocks' GET /user/profile, verified live:
// { user_id, email, first_name, last_name, demat_id, ucc, is_nse_onboarded, ... }.
// There is no single "user_name" field like Kite's profile — first+last name
// combine to make one for the header.
export async function GET() {
  if (!isAuthenticated()) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const data = await request<any>("/user/profile", { category: "nonTrading" });
    const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
    return NextResponse.json({
      user_id: data.user_id ?? null,
      user_name: name,
      email: data.email ?? null,
      ucc: data.ucc ?? null,
      broker: "INDstocks",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
