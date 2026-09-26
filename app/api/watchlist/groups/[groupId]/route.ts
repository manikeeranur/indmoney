import { NextResponse } from "next/server";
import Watchlist from "@/lib/db/models/Watchlist";
import { isConnected } from "@/lib/db/connect";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";

export async function PUT(req: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const { name, items } = await req.json().catch(() => ({}));
  if (!name) return NextResponse.json({ error: "Missing name" }, { status: 400 });
  if (!isConnected()) return NextResponse.json({ ok: true });
  try {
    await Watchlist.findOneAndUpdate({ groupId }, { groupId, name, items: items ?? [], updatedAt: new Date() }, { upsert: true, new: true });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  if (groupId === "wl_default") return NextResponse.json({ error: "Cannot delete default watchlist" }, { status: 400 });
  if (!isConnected()) return NextResponse.json({ ok: true });
  try {
    await Watchlist.deleteOne({ groupId });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
