"use client";

import { useEffect, useState } from "react";

// Live "lots per entry" from the Auto-Trade Defaults (accountDefaults.quantity)
// — SMC/VWAP930 tables and cards must show this, not a hardcoded constant, or
// their displayed P&L-per-lot silently drifts from what auto-trade actually
// orders. Shared by both strategies: one global `quantity` setting for both.
// Polls every 30s so a change made on another tab/device shows up without a
// full page reload; `fallback` is used until the first fetch resolves (and if
// the fetch ever fails). Ported from frontend/lib/useAccountQty.ts.
export function useAccountQty(fallback: number): number {
  const [qty, setQty] = useState(fallback);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetch("/api/settings")
        .then(r => r.json())
        .then(s => { if (!cancelled) setQty(s.accountDefaults?.quantity ?? fallback); })
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return qty;
}
