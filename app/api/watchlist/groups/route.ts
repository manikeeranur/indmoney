import { NextResponse } from "next/server";
import Watchlist from "@/lib/db/models/Watchlist";
import { isConnected } from "@/lib/db/connect";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function GET() {
  if (!isConnected()) return NextResponse.json({ groups: [{ id: "wl_default", name: "My Watchlist", items: [] }] });
  try {
    const docs = await Watchlist.find({}).sort({ updatedAt: 1 }).lean();
    const groups = docs.map((d: any) => ({ id: d.groupId, name: d.name, items: d.items ?? [] }));
    if (!groups.find(g => g.id === "wl_default")) groups.unshift({ id: "wl_default", name: "My Watchlist", items: [] });
    return NextResponse.json({ groups });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
