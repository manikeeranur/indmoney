import { NextResponse } from "next/server";
import { getOptionChain } from "@/lib/broker/marketdata";
import { getLotSize, getNearestExpiry } from "@/lib/broker/instruments";
import { subscribeTokens } from "@/lib/runtime/registry";
import type { Index } from "@/lib/broker/types";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

// A short server-side cache with in-flight de-duplication, carried over from the
// old app's optionChainService. Several tabs asking for the same chain in the
// same second must cost ONE upstream call, not one each — the 100k/day cap makes
// that non-negotiable.
const TTL_MS = 1500;
type Entry = { at: number; data: any };
const cache    = new Map<string, Entry>();
const inFlight = new Map<string, Promise<any>>();

export async function GET(req: Request) {
  const url     = new URL(req.url);
  const index   = (url.searchParams.get("index") ?? "NIFTY") as Index;
  const strikes = Number(url.searchParams.get("strikes") ?? 15);

  try {
    const expiry = url.searchParams.get("expiry") || (await getNearestExpiry(index));
    const key    = `${index}:${expiry}:${strikes}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.data);

    const existing = inFlight.get(key);
    if (existing) return NextResponse.json(await existing);

    const p = (async () => {
      const lotSize = await getLotSize(index).catch(() => 0);
      const chain   = await getOptionChain(expiry, strikes, index, lotSize);
      // Every visible leg goes on the price feed, so the browser gets pushed
      // updates instead of polling this route.
      subscribeTokens(chain.rows.flatMap((r) => [r.ce.token, r.pe.token]));
      cache.set(key, { at: Date.now(), data: chain });
      return chain;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, p);
    return NextResponse.json(await p);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
