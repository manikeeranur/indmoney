"use client";

// ─── Live chain store ─────────────────────────────────────────────────────────
// The performance point of the whole rewrite lives here.
//
// In the old app every incoming tick set state on a 3,000-line component, so a
// single price change re-rendered the entire option chain — 30+ rows, all their
// cells, on every tick of every leg. With a busy chain that is hundreds of full
// re-renders a second.
//
// Here, prices live in a flat token → price map. A row component subscribes to
// exactly the two tokens it displays, so a tick re-renders that one row and
// nothing else.

import { create } from "zustand";
import type { OptionChain, Tick } from "@/lib/broker/types";

type ChainState = {
  chain: OptionChain | null;
  /** token → last traded price, updated from the WebSocket */
  ltp: Record<number, number>;
  /** token → previous tick's price, so a row can flash up/down */
  prevLtp: Record<number, number>;
  connected: boolean;
  error: string | null;
  lastTickAt: number | null;

  setChain: (chain: OptionChain) => void;
  applyTicks: (ticks: Tick[]) => void;
  setConnected: (v: boolean) => void;
  setError: (e: string | null) => void;
};

export const useChainStore = create<ChainState>((set) => ({
  chain: null,
  ltp: {},
  prevLtp: {},
  connected: false,
  error: null,
  lastTickAt: null,

  setChain: (chain) =>
    set((s) => {
      // Seed prices from the REST snapshot so rows render immediately instead of
      // waiting for the first tick on each leg.
      const ltp = { ...s.ltp };
      for (const r of chain.rows) {
        ltp[r.ce.token] ??= r.ce.ltp;
        ltp[r.pe.token] ??= r.pe.ltp;
      }
      return { chain, ltp };
    }),

  applyTicks: (ticks) =>
    set((s) => {
      let changed = false;
      const ltp: Record<number, number> = s.ltp;
      const next: Record<number, number> = {};
      const prev: Record<number, number> = {};

      for (const t of ticks) {
        const old = ltp[t.instrument_token];
        if (old === t.last_price) continue; // nothing to render
        next[t.instrument_token] = t.last_price;
        prev[t.instrument_token] = old ?? t.last_price;
        changed = true;
      }
      if (!changed) return s; // identical state object → zero re-renders

      return {
        ltp:     { ...s.ltp,     ...next },
        prevLtp: { ...s.prevLtp, ...prev },
        lastTickAt: Date.now(),
      };
    }),

  setConnected: (connected) => set({ connected }),
  setError:     (error)     => set({ error }),
}));

/** Subscribe to ONE instrument's price. This is what keeps a tick from
 *  re-rendering the whole table. */
export const useLtp = (token: number) =>
  useChainStore((s) => s.ltp[token]);

export const usePrevLtp = (token: number) =>
  useChainStore((s) => s.prevLtp[token]);
