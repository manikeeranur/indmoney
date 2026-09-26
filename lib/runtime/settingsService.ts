// ─── Settings service ─────────────────────────────────────────────────────────
// Ported from backend/src/services/settingsService.js. One thing changed:
// `cached` is anchored on globalThis rather than module scope — the auto-trade
// engine reads it synchronously from the instrumentation graph while the
// settings API route writes it from the route graph, and those are two
// separate copies of a plain module-level variable (the same class of bug
// fixed in lib/broker/auth.ts and lib/runtime/registry.ts).
import Settings from "@/lib/db/models/Settings";
import { isConnected } from "@/lib/db/connect";

const QUANTITY_ENUM     = [1, 2, 5, 10, 15, 20];
const PRODUCT_ENUM      = ["MIS", "NRML", "INTRADAY", "MARGIN"];
const TRADING_MODE_ENUM = ["LIVE", "PAPER"];

export type AccountDefaults = {
  lockPoints: number | null;
  stopLoss: number | null;
  target: number | null;
  quantity: number;
  productType: string;
  tradingMode: "LIVE" | "PAPER";
  breakevenTriggerPct: number | null;
};

export type SettingsDoc = {
  key: string;
  smcAutoTradeEnabled: boolean;
  vwap930AutoTradeEnabled: boolean;
  accountDefaults: AccountDefaults;
  globalLock: { on: boolean; pts: number | null };
};

const DEFAULTS: SettingsDoc = {
  key: "global",
  smcAutoTradeEnabled: false,
  vwap930AutoTradeEnabled: false,
  accountDefaults: {
    lockPoints: null, stopLoss: null, target: null,
    quantity: 10, productType: "INTRADAY", tradingMode: "PAPER",
    breakevenTriggerPct: null,
  },
  globalLock: { on: false, pts: null },
};

function state(): { cached: SettingsDoc } {
  const g = globalThis as any;
  g.__INDMONEY_SETTINGS__ ??= { cached: DEFAULTS };
  return g.__INDMONEY_SETTINGS__;
}

export function getCached(): SettingsDoc {
  return state().cached;
}

export async function loadOrCreate(): Promise<SettingsDoc> {
  if (!isConnected()) return getCached();
  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" }, {}, { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    state().cached = doc as unknown as SettingsDoc;
    return getCached();
  } catch (err: any) {
    console.error("[Settings] loadOrCreate error:", err.message);
    return getCached();
  }
}

function validatePatch(patch: Partial<AccountDefaults>): string | null {
  if (patch.quantity != null && !QUANTITY_ENUM.includes(Number(patch.quantity)))
    return `quantity must be one of ${QUANTITY_ENUM.join(", ")}`;
  if (patch.productType != null && !PRODUCT_ENUM.includes(patch.productType))
    return `productType must be one of ${PRODUCT_ENUM.join(", ")}`;
  if (patch.tradingMode != null && !TRADING_MODE_ENUM.includes(patch.tradingMode))
    return `tradingMode must be one of ${TRADING_MODE_ENUM.join(", ")}`;
  for (const f of ["lockPoints", "stopLoss", "target"] as const) {
    const v = patch[f];
    if (v != null && (typeof v !== "number" || Number.isNaN(v)))
      return `${f} must be a number or null`;
  }
  if (patch.breakevenTriggerPct != null &&
      (typeof patch.breakevenTriggerPct !== "number" || Number.isNaN(patch.breakevenTriggerPct) || patch.breakevenTriggerPct <= 0))
    return "breakevenTriggerPct must be a positive number or null";
  return null;
}

export async function patchAccountDefaults(patch: Partial<AccountDefaults>): Promise<SettingsDoc> {
  const err = validatePatch(patch);
  if (err) throw Object.assign(new Error(err), { status: 400 });

  const s = state();
  s.cached = { ...s.cached, accountDefaults: { ...s.cached.accountDefaults, ...patch } };
  if (!isConnected()) return s.cached;

  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) set[`accountDefaults.${k}`] = v;

  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    s.cached = doc as unknown as SettingsDoc;
    return s.cached;
  } catch (e: any) {
    console.error("[Settings] patchAccountDefaults error:", e.message);
    return s.cached;
  }
}

export async function setGlobalLock(patch: { on?: boolean; pts?: number | null }): Promise<SettingsDoc> {
  if (patch.pts != null && (typeof patch.pts !== "number" || Number.isNaN(patch.pts)))
    throw Object.assign(new Error("pts must be a number or null"), { status: 400 });

  const s = state();
  s.cached = { ...s.cached, globalLock: { ...s.cached.globalLock, ...patch } };
  if (!isConnected()) return s.cached;

  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) set[`globalLock.${k}`] = v;

  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    s.cached = doc as unknown as SettingsDoc;
    return s.cached;
  } catch (e: any) {
    console.error("[Settings] setGlobalLock error:", e.message);
    return s.cached;
  }
}

export async function setAutoTradeEnabled(engine: "smc" | "vwap930", enabled: boolean): Promise<SettingsDoc> {
  const field = engine === "smc" ? "smcAutoTradeEnabled" : "vwap930AutoTradeEnabled";
  const s = state();
  s.cached = { ...s.cached, [field]: enabled };
  if (!isConnected()) return s.cached;
  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" }, { $set: { [field]: enabled, updatedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    s.cached = doc as unknown as SettingsDoc;
    return s.cached;
  } catch (e: any) {
    console.error(`[Settings] setAutoTradeEnabled(${engine}) error:`, e.message);
    throw e;
  }
}
