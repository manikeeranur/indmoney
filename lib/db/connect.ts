// ─── MongoDB connection ────────────────────────────────────────────────────────
// mongoose is listed in next.config.js's serverExternalPackages, which forces
// Node's native require() instead of bundling it — so, unlike our own modules,
// there is exactly one mongoose instance and one connection no matter which
// module graph (route vs instrumentation) imports this file. No globalThis
// anchor needed here, only for our own state.
import mongoose from "mongoose";

let connected = false;
let connecting: Promise<boolean> | null = null;

export async function connectDB(): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[MongoDB] MONGODB_URI not set — skipping DB connection");
    return false;
  }
  if (connected) return true;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      await mongoose.connect(uri);
      connected = true;
      console.log("[MongoDB] Connected");
      return true;
    } catch (err: any) {
      console.error("[MongoDB] Connection failed:", err.message);
      return false;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export function isConnected(): boolean {
  return connected || mongoose.connection.readyState === 1;
}
