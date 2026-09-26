"use client";

import { useSyncExternalStore } from "react";

export type Holiday = { date: string; name: string };

// Shared holiday cache — fetched once from /api/holidays (the real NSE
// calendar via Upstox's public feed) and shared by every consumer via
// useSyncExternalStore, instead of each component fetching independently.
// Ported from frontend/lib/holidays.ts.
let holidays: Holiday[] = [];
let holidaysMap: Record<string, string> = {};
let loaded = false;
let loading = false;
const listeners = new Set<() => void>();

function notify() { listeners.forEach(l => l()); }

function load() {
  if (loaded || loading) return;
  loading = true;
  fetch("/api/holidays")
    .then(r => r.json())
    .then(d => {
      holidays = d.holidays ?? [];
      holidaysMap = Object.fromEntries(holidays.map(h => [h.date, h.name]));
      loaded = true;
    })
    .catch(() => { loading = false; })
    .finally(() => notify());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  load();
  return () => listeners.delete(cb);
}

const EMPTY_LIST: Holiday[] = [];
const EMPTY_MAP: Record<string, string> = {};

export function useHolidays(): Holiday[] {
  return useSyncExternalStore(subscribe, () => holidays, () => EMPTY_LIST);
}

export function useHolidaysMap(): Record<string, string> {
  return useSyncExternalStore(subscribe, () => holidaysMap, () => EMPTY_MAP);
}
