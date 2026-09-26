// ─── Runtime boot ─────────────────────────────────────────────────────────────
// Next calls register() exactly once when the server starts. This is where the
// trading runtime comes up, and it lives here rather than in server.js because
// everything it touches is TypeScript compiled by Next — booting it from the
// CommonJS entry point would load a second, disconnected copy of the module
// graph (the same reason browserHub publishes itself on globalThis).

export async function register() {
  // Guard against the edge runtime, where none of this can run.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { boot } = await import("./lib/runtime/boot");
  await boot();
}
