"use strict";

// ─── Browser WebSocket hub ────────────────────────────────────────────────────
// One socket per open tab. The server pushes ticks here instead of the browser
// polling REST — the old app polled the chain every 2s AND quotes every 500ms,
// which under INDstocks' 100,000 calls/day cap would have consumed most of the
// budget before lunch.
//
// Message shapes are kept identical to the old backend's so ported UI code that
// consumes { type: "ticks" | "status" | "scan_result" } needs no changes.

const { WebSocketServer } = require("ws");

let wss = null;
const clients = new Set();

// Next's dev server runs its OWN WebSocket on this port for hot reload and the
// dev overlay. Sharing a port with it needs care, and BOTH naive options break
// the app:
//
//   new WebSocketServer({ server })              -> grabs EVERY upgrade,
//        including Next's, which then gets our JSON and reconnect-loops.
//   new WebSocketServer({ server, path: "/ws" }) -> looks right, but `ws`
//        ABORTS every upgrade that does not match the path (400 + destroy),
//        so Next's HMR socket is killed instead of being left alone.
//
// The correct approach is noServer + our own upgrade listener that handles ONLY
// our path and simply returns for anything else, leaving Next's listener to do
// its job.
const WS_PATH = "/ws";

function attachBrowserHub(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return; // malformed — not ours; let another listener decide
    }
    if (pathname !== WS_PATH) return; // NOT ours: do not touch this socket

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (total: ${clients.size})`);

    // Tell the new tab where things stand immediately, rather than leaving it
    // blank until the next tick.
    safeSend(ws, { type: "status", ...statusSnapshot() });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "subscribe" && Array.isArray(msg.tokens)) {
          // The price feed lives in TypeScript compiled by Next, so it is
          // reached through the globalThis registry rather than require() —
          // see the note at the bottom of this file.
          globalThis.__INDMONEY_PRICES__?.subscribeTokens(msg.tokens);
        }
      } catch {
        /* a malformed frame from a browser is not worth killing the socket over */
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (total: ${clients.size})`);
    });
    ws.on("error", () => clients.delete(ws));
  });

  return wss;
}

function statusSnapshot() {
  return {
    authenticated: globalThis.__INDMONEY_RUNTIME__?.authenticated?.() ?? false,
    marketOpen:    isMarketOpen(),
  };
}

function isMarketOpen() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  if (day === 0 || day === 6) return false;
  return (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
}

function safeSend(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* socket died mid-send */ }
}

/** Fan a payload out to every open tab. */
function broadcast(payload) {
  if (!clients.size) return;
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { clients.delete(ws); }
    }
  }
}

function clientCount() { return clients.size; }

// ─── Cross-boundary registry ──────────────────────────────────────────────────
// server.js (plain CommonJS) owns this file, but the code that needs to PUSH —
// the broker price feed, the scanners — is TypeScript compiled by Next into a
// separate module graph. A plain require() across that boundary would hand back
// a second, empty copy of this module. Publishing the handful of functions on
// globalThis is the standard Next.js escape hatch and keeps exactly one hub.
globalThis.__INDMONEY_HUB__ = { broadcast, clientCount };

module.exports = { attachBrowserHub, broadcast, clientCount, isMarketOpen, WS_PATH };
