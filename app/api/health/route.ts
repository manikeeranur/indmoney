import { NextResponse } from "next/server";
// Deliberately imports only the registry — see lib/runtime/registry.ts. Pulling
// in boot here would instantiate a second price feed and break live prices.
import {
  runtimeState, priceFeedStatus, isAuthenticated, isConfigured,
  canAutoRefresh, browserClientCount,
} from "@/lib/runtime/registry";
import { usage } from "@/lib/broker/client";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET() {
  const rt   = runtimeState();
  const feed = priceFeedStatus();
  const status = !rt.booted ? "starting" : rt.bootError ? "degraded" : "ok";

  return NextResponse.json({
    app: "INDMONEY",
    broker: "INDstocks",
    status,
    booted:        rt.booted,
    bootError:     rt.bootError,
    configured:    isConfigured(),
    authenticated: isAuthenticated(),
    autoRefresh:   canAutoRefresh(),
    lotSize:       rt.lotSize,
    priceFeed:     feed,
    apiUsage:      usage(),
    browserClients: browserClientCount(),
    serverTime: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  });
}
