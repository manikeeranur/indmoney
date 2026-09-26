import { NextResponse } from "next/server";
import { clearAlerts } from "@/lib/runtime/alertStore";
import { smcConfig } from "@/lib/runtime/engines";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function DELETE() { clearAlerts(smcConfig); return NextResponse.json({ cleared: true }); }
