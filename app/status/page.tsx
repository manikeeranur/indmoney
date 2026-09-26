"use client";

import { useEffect, useState } from "react";

type Health = {
  status: string;
  configured: boolean;
  authenticated: boolean;
  bootError: string | null;
  lotSize: number | null;
  priceFeed: { connected: boolean; instruments: number; reconnectAttempt: number };
  apiUsage: { count: number; cap: number; date: string };
  browserClients: number;
  serverTime: string;
};

function StatusInner() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((d) => { if (alive) { setHealth(d); setError(null); } })
        .catch((e) => { if (alive) setError(e.message); });
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const usagePct = health ? (health.apiUsage.count / health.apiUsage.cap) * 100 : 0;

  return (
    <main className="min-h-screen px-5 py-10 md:px-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-8 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">INDMONEY</h1>
            <p className="mt-1 text-sm text-muted">
              NIFTY options algo · INDstocks
            </p>
          </div>
          <Badge ok={health?.status === "ok"}>
            {health?.status === "ok" ? "Healthy" : health ? "Degraded" : "…"}
          </Badge>
        </header>

        {error && <Notice tone="down">Cannot reach the server: {error}</Notice>}
        {health?.bootError && <Notice tone="warn">{health.bootError}</Notice>}
        {health && !health.configured && (
          <Notice tone="warn">
            INDstocks credentials are not set. Copy <code>.env.example</code> to{" "}
            <code>.env</code> and fill in <code>IND_CLIENT_ID</code>,{" "}
            <code>IND_MPIN</code> and <code>IND_TOTP_SECRET</code>.
          </Notice>
        )}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card label="Broker token">
            <Dot ok={!!health?.authenticated} />
            {health?.authenticated ? "Active (auto-refreshing)" : "Not authenticated"}
          </Card>

          <Card label="Price feed">
            <Dot ok={!!health?.priceFeed.connected} />
            {health?.priceFeed.connected
              ? `Live · ${health.priceFeed.instruments} instrument(s)`
              : "Disconnected"}
          </Card>

          <Card label="NIFTY lot size">
            <span className="tabular text-lg">{health?.lotSize ?? "—"}</span>
            <span className="ml-2 text-xs text-faint">from exchange master</span>
          </Card>

          <Card label="Open browser tabs">
            <span className="tabular text-lg">{health?.browserClients ?? 0}</span>
          </Card>
        </section>

        <section className="mt-3">
          <Card label={`API calls today (${health?.apiUsage.date ?? "—"})`}>
            <div className="flex items-baseline gap-2">
              <span className="tabular text-lg">
                {health?.apiUsage.count.toLocaleString() ?? 0}
              </span>
              <span className="text-xs text-faint">
                / {health?.apiUsage.cap.toLocaleString() ?? "100,000"} cap
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-[var(--border)]">
              <div
                className="h-full rounded-sm transition-all"
                style={{
                  width: `${Math.min(usagePct, 100)}%`,
                  background: usagePct > 80 ? "var(--down)" : "var(--accent)",
                }}
              />
            </div>
          </Card>
        </section>

        <p className="mt-6 text-xs text-faint">
          Server time {health?.serverTime ?? "—"} IST · refreshes every 5s
        </p>
      </div>
    </main>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-faint">{label}</div>
      <div className="flex items-center text-sm">{children}</div>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className="mr-2 inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: ok ? "var(--up)" : "var(--down)" }}
    />
  );
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className="rounded-sm px-2 py-1 text-xs font-medium"
      style={{
        color: ok ? "var(--up)" : "var(--warn)",
        background: ok ? "var(--up-soft)" : "rgba(255,176,32,0.12)",
      }}
    >
      {children}
    </span>
  );
}

function Notice({ tone, children }: { tone: "warn" | "down"; children: React.ReactNode }) {
  const color = tone === "warn" ? "var(--warn)" : "var(--down)";
  return (
    <div
      className="mb-4 rounded-[var(--radius)] border p-3 text-sm"
      style={{ borderColor: color, background: `${tone === "warn" ? "rgba(255,176,32,0.08)" : "var(--down-soft)"}`, color }}
    >
      {children}
    </div>
  );
}

export default function StatusPage() {
  return <StatusInner />;
}
