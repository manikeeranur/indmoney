import { NextResponse } from "next/server";
import { clearAlerts } from "@/lib/runtime/alertStore";
import { vwap930Config } from "@/lib/runtime/engines";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function DELETE() { clearAlerts(vwap930Config); return NextResponse.json({ cleared: true }); }
