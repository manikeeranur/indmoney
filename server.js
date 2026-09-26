// ─── INDMONEY server ──────────────────────────────────────────────────────────
// Next.js runs INSIDE this process rather than via `next start`, for two reasons
// the old architecture makes unavoidable:
//
//   1. The app owns long-lived state — cron scanners, the broker WebSocket,
//      in-memory alert arrays, the rate-limiter queue. None of that survives a
//      serverless/per-request model.
//   2. `next start` gives no access to the HTTP server, so it cannot accept the
//      browser WebSocket upgrade that pushes ticks to the UI.
//
// One process, one broker connection, one scheduler.
process.env.TZ = "Asia/Kolkata"; // MUST be first — every cron and getHours() depends on it
require("dotenv").config();

const { createServer } = require("http");
const { parse }        = require("url");
const next             = require("next");
const compression      = require("compression");

const dev      = process.env.NODE_ENV !== "production";
const port     = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";

const app    = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // gzip/brotli — `next start` does this itself, but a custom server (needed
  // here for the WebSocket upgrade and the long-lived scanner/broker state)
  // has to opt in explicitly, or every response goes out uncompressed.
  const compress = compression();
  const server = createServer((req, res) => {
    compress(req, res, () => handle(req, res, parse(req.url, true)));
  });

  // Browser WebSocket hub — attached to the same server so there is one port.
  const { attachBrowserHub } = require("./lib/runtime/browserHub.js");
  attachBrowserHub(server);

  server.listen(port, hostname, () => {
    console.log(`\n  INDMONEY  ready on http://localhost:${port}  (${dev ? "dev" : "production"})\n`);
  });

  // The trading runtime (broker WebSocket, scanners, schedulers) is booted by
  // Next's instrumentation hook — see instrumentation.ts. It lives there rather
  // than here because it is TypeScript and must be compiled by Next; booting it
  // from this CommonJS file would load a second copy of the module graph.
});

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down`);
  try { globalThis.__INDMONEY_RUNTIME__?.shutdown?.(); } catch {}
  process.exit(0);
}
