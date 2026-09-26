import { NextResponse } from "next/server";
import { getStatus } from "@/lib/runtime/alertStore";
import { vwap930Config } from "@/lib/runtime/engines";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function GET() { return NextResponse.json(getStatus(vwap930Config)); }
