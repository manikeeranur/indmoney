import { NextResponse } from "next/server";
import { isAuthenticated, canAutoRefresh } from "@/lib/runtime/registry";
import { hasClientId } from "@/lib/broker/auth";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET() {
  return NextResponse.json({
    authenticated: isAuthenticated(),
    autoRefresh:   canAutoRefresh(),
    hasClientId:   hasClientId(),
  });
}
