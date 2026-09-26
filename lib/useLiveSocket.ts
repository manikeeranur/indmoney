"use client";

// ─── Browser WebSocket client ─────────────────────────────────────────────────
// Connects to the hub on /ws (a dedicated path so it never collides with Next's
// own hot-reload socket) and feeds ticks straight into the chain store.
//
// The old app's client had no reconnect at all — if the socket dropped, prices
// silently froze and the UI kept showing stale numbers as if they were live.
// This one reconnects with backoff and exposes `connected` so the UI can SAY
// when it is stale rather than lying.

import { useEffect, useRef } from "react";
import { useChainStore } from "./store/chainStore";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 15000;

// Module-level so any component (e.g. ChartPanel, opened for a token that may
// not be in the currently visible chain rows) can ask the server to subscribe
// a token, without needing its own WebSocket connection — there is exactly
// one, opened once by AppShell's useLiveSocket() at the root of every page.
let activeSocket: WebSocket | null = null;

/** Ask the server to start streaming a token's price. Safe to call before the
 *  socket is open — silently a no-op then, since every page that can reach
 *  this already has AppShell mounted and reconnecting. */
export function subscribeTokens(tokens: number[]) {
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: "subscribe", tokens }));
  }
}

export function useLiveSocket() {
  const wsRef      = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef  = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    const { applyTicks, setConnected } = useChainStore.getState();

    const connect = () => {
      if (closedRef.current) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;
      activeSocket = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "ticks" && Array.isArray(msg.data)) applyTicks(msg.data);
        } catch {
          /* ignore malformed frames rather than killing the socket */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (activeSocket === ws) activeSocket = null;
        if (closedRef.current) return;
        const delay = Math.min(BACKOFF_MIN_MS * 2 ** attemptRef.current, BACKOFF_MAX_MS);
        attemptRef.current++;
        timerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close(); // onclose handles the retry
    };

    connect();

    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      if (activeSocket === wsRef.current) activeSocket = null;
    };
  }, []);
}
