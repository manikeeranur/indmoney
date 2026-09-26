// ─── Instrument master ────────────────────────────────────────────────────────
// INDstocks serves the instrument catalogue as a raw CSV per source
// (equity | fno | index), unlike Kite's JSON dump. Two things matter here:
//
//  1. LOT SIZE COMES FROM HERE, never hardcoded. Measured against the live CSV
//     on 2026-09-25: all 3,372 NIFTY OPTIDX contracts carry LOT_UNITS=65, so the
//     old app's hardcoded 65 was correct and order sizes are unchanged. (The
//     "75" in the INDstocks docs is a sample value, not NIFTY's real lot.)
//     Reading it per contract still matters: it survives the next exchange
//     revision without a code change, and stock options differ per symbol.
//
//  2. The option-chain endpoint wants the UNDERLYING's security id, which must
//     come from source=index (or equity), never from source=fno. The docs call
//     this out explicitly; using an fno id silently returns nothing useful.

import { request, requestText } from "./client";
import type { Index, Instrument } from "./types";

const FNO_TTL_MS   = 60 * 60 * 1000;      // 1h, same as the old app's NFO cache
const OTHER_TTL_MS = 6 * 60 * 60 * 1000;  // 6h

type Cache<T> = { at: number; data: T } | null;

let fnoCache: Cache<Instrument[]> = null;
let indexCache: Cache<Map<string, number>> = null;
let equityCache: Cache<EquityInstrument[]> = null;
let inFlight = new Map<string, Promise<any>>();

export type EquityInstrument = { token: number; tradingsymbol: string; name: string; exchange: "NSE" | "BSE" };

// ─── CSV parsing ──────────────────────────────────────────────────────────────
// Header-driven: we look columns up by name, so a change in column ORDER (or
// the documented "plus 8 additional fields") cannot silently shift the data.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = (cells[c] ?? "").trim();
    out.push(row);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ─── F&O instruments ──────────────────────────────────────────────────────────
export async function getFnoInstruments(force = false): Promise<Instrument[]> {
  if (!force && fnoCache && Date.now() - fnoCache.at < FNO_TTL_MS) return fnoCache.data;

  return dedupe("fno", async () => {
    const csv  = await requestText("/market/instruments", { source: "fno" });
    const rows = parseCsv(csv);

    const instruments: Instrument[] = rows.map((r) => ({
      token:         Number(r.SECURITY_ID),
      tradingsymbol: r.TRADING_SYMBOL ?? "",
      name:          underlyingOf(r.TRADING_SYMBOL ?? ""),
      // "NIFTY 29 SEP 23400 PE" — the exchange's own display label, which is
      // exactly the format the Telegram reports use. No need to build it.
      label:         r.CUSTOM_SYMBOL ?? "",
      strike:        r.STRIKE_PRICE ? Number(r.STRIKE_PRICE) : null,
      expiry:        normaliseExpiry(r.EXPIRY_DATE),
      type:          r.OPTION_TYPE ?? "",
      kind:          r.INSTRUMENT_NAME ?? "",
      segment:       r.SEGMENT ?? "",
      exchange:      r.EXCH ?? "",
      lotSize:       Number(r.LOT_UNITS || 0),
    })).filter((i) => Number.isFinite(i.token) && i.token > 0);

    fnoCache = { at: Date.now(), data: instruments };
    console.log(`[Instruments] Loaded ${instruments.length} F&O instruments`);
    return instruments;
  });
}

/** Trading symbols are "UNDERLYING-MonYYYY-STRIKE-TYPE", e.g.
 *  "NIFTY-Sep2026-23400-PE" or "CIPLA-Oct2026-980-PE", so the underlying is
 *  simply the first hyphen-delimited part.
 *
 *  UNDERLYING_SCRIP_NAME is NOT usable here: it is populated for stock options
 *  ("CIPLA LTD") but EMPTY for index options, which is precisely the case we
 *  care about. Verified against the live CSV. */
function underlyingOf(tradingsymbol: string): string {
  return (tradingsymbol.split("-")[0] ?? "").trim().toUpperCase();
}

/** The F&O CSV ships expiry as "MM/DD/YYYY HH:MM" (e.g. "09/29/2026 14:00").
 *  Parsed explicitly rather than via new Date(), because a Date round-trip
 *  through toISOString() can shift the calendar day across the IST/UTC
 *  boundary — and an expiry off by one day picks the wrong contract. */
function normaliseExpiry(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (mdy) {
    const [, mm, dd, yyyy] = mdy;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

// ─── Lot size ─────────────────────────────────────────────────────────────────
/** Lot size for an index's current contracts, straight from the exchange master.
 *  This deliberately replaces the old app's hardcoded LOT_SIZE = 65. */
export async function getLotSize(index: Index = "NIFTY"): Promise<number> {
  const all = await getFnoInstruments();
  // Match the index's own OPTION contracts exactly. An unanchored match would
  // happily pick up NIFTYNXT50 (2,149 contracts, different lot size) for "NIFTY".
  const match = all.find(
    (i) => i.name === index && i.kind === "OPTIDX" && i.lotSize > 0,
  );
  if (!match) {
    throw new Error(
      `Could not determine lot size for ${index} from the instrument master — ` +
      `refusing to guess, because a wrong lot size mis-sizes every order.`,
    );
  }
  return match.lotSize;
}

export async function getLotSizeForToken(token: number): Promise<number | null> {
  const all = await getFnoInstruments();
  return all.find((i) => i.token === token)?.lotSize ?? null;
}

async function loadIndexMap(): Promise<Map<string, number>> {
  if (!indexCache || Date.now() - indexCache.at > OTHER_TTL_MS) {
    await dedupe("index", async () => {
      const csv  = await requestText("/market/instruments", { source: "index" });
      const rows = parseCsv(csv);
      const map  = new Map<string, number>();
      for (const r of rows) {
        // The index CSV is 3 columns: EXCH, SEGMENT (holds the index name), SECURITY_ID
        const name = (r.SEGMENT || r.INDEX_NAME || r.SYMBOL_NAME || "").toUpperCase().trim();
        const id   = Number(r.SECURITY_ID);
        if (name && Number.isFinite(id)) map.set(name, id);
      }
      indexCache = { at: Date.now(), data: map };
      console.log(`[Instruments] Loaded ${map.size} index instruments`);
    });
  }
  return indexCache!.data;
}

// ─── Underlying security id (for the option-chain endpoint) ───────────────────
export async function getUnderlyingScrip(index: Index = "NIFTY"): Promise<number> {
  const map = await loadIndexMap();
  // Index names vary in punctuation across feeds ("NIFTY 50", "NIFTY50", "NIFTY").
  const wanted = index === "NIFTY"
    ? ["NIFTY 50", "NIFTY50", "NIFTY"]
    : ["SENSEX", "BSE SENSEX"];

  for (const w of wanted) {
    const hit = map.get(w);
    if (hit) return hit;
  }
  // Last resort: a loose contains-match before giving up.
  for (const [name, id] of map) {
    if (wanted.some((w) => name.replace(/\s+/g, "") === w.replace(/\s+/g, ""))) return id;
  }
  throw new Error(
    `No underlying security id found for ${index}. Known index names: ${[...map.keys()].slice(0, 20).join(", ")}`,
  );
}

/** Generalised lookup for indices beyond NIFTY/SENSEX (BANKNIFTY, FINNIFTY,
 *  MIDCPNIFTY, NIFTY NEXT 50, BANKEX, INDIA VIX, …) — used by the Watchlist
 *  tab's live index ticker. Returns null instead of throwing so the ticker
 *  can just skip an index it can't resolve rather than break the whole strip. */
export async function getIndexToken(candidates: string[]): Promise<number | null> {
  const map = await loadIndexMap();
  for (const w of candidates) {
    const hit = map.get(w.toUpperCase());
    if (hit) return hit;
  }
  for (const [name, id] of map) {
    if (candidates.some((w) => name.replace(/\s+/g, "") === w.toUpperCase().replace(/\s+/g, ""))) return id;
  }
  return null;
}

// ─── Equity instruments (Watchlist tab's stock search) ────────────────────────
// source=equity's CSV carries bonds/NCDs alongside real shares — verified live,
// they show SEM_EXCH_INSTRUMENT_TYPE="Other" where a share shows "ES", so
// that field (not SERIES, which has more noisy values like "B"/"F") is what
// separates them.
async function loadEquityList(): Promise<EquityInstrument[]> {
  if (!equityCache || Date.now() - equityCache.at > OTHER_TTL_MS) {
    await dedupe("equity", async () => {
      const csv  = await requestText("/market/instruments", { source: "equity" });
      const rows = parseCsv(csv);
      const list: EquityInstrument[] = rows
        .filter((r) => r.SEM_EXCH_INSTRUMENT_TYPE === "ES")
        .map((r) => ({
          token: Number(r.SECURITY_ID),
          tradingsymbol: r.TRADING_SYMBOL ?? "",
          name: r.SYMBOL_NAME || r.CUSTOM_SYMBOL || r.TRADING_SYMBOL || "",
          exchange: (r.EXCH === "BSE" ? "BSE" : "NSE") as "NSE" | "BSE",
        }))
        .filter((i) => Number.isFinite(i.token) && i.token > 0 && i.tradingsymbol);
      equityCache = { at: Date.now(), data: list };
      console.log(`[Instruments] Loaded ${list.length} equity instruments`);
    });
  }
  return equityCache!.data;
}

/** Score-matched instrument search — same scoring the old app used against
 *  Kite's instrument dump (exact=100, symbol starts-with=50+, name starts-
 *  with=30, symbol contains=10, name contains=5), just against INDstocks'
 *  own equity CSV instead. */
export async function searchEquities(query: string, limit = 15): Promise<EquityInstrument[]> {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const list = await loadEquityList();
  return list
    .map((inst) => {
      const sym = inst.tradingsymbol.toUpperCase();
      const name = inst.name.toUpperCase();
      let score = 0;
      if (sym === q) score = 100;
      else if (sym.startsWith(q)) score = 50 + 1 / sym.length;
      else if (name.startsWith(q)) score = 30;
      else if (sym.includes(q)) score = 10;
      else if (name.includes(q)) score = 5;
      return { inst, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.inst);
}

// ─── Expiries ─────────────────────────────────────────────────────────────────
export async function getExpiries(index: Index = "NIFTY"): Promise<string[]> {
  const data = await request<string[]>("/market/instruments/expiries", {
    query: { underlying: index, segment: "DERIVATIVE" },
    category: "nonTrading",
  });
  // Documented as a flat ascending array of "YYYY-MM-DD".
  return Array.isArray(data) ? data : [];
}

/** Nearest upcoming expiry — what every scanner runs against. */
export async function getNearestExpiry(index: Index = "NIFTY"): Promise<string> {
  const list = await getExpiries(index);
  if (!list.length) throw new Error(`No expiries returned for ${index}`);
  return list[0];
}

export function clearInstrumentCache() {
  fnoCache = null;
  indexCache = null;
}
