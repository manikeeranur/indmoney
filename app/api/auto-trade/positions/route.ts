import { NextResponse } from "next/server";
import { clearPositions } from "@/lib/runtime/autoTrade";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function DELETE() { clearPositions("smc"); return NextResponse.json({ cleared: true }); }
