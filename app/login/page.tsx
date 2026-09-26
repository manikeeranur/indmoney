"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "totp" | "token";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode]     = useState<Mode>("totp");
  const [mpin, setMpin]     = useState("");
  const [totp, setTotp]     = useState("");
  const [token, setToken]   = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);

  // Already signed in? Don't make them do it again.
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((d) => { if (d.session) router.replace("/"); })
      .catch(() => {});
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "totp" ? { mode, mpin, totp } : { mode, token }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || "Login failed");
      router.replace("/");
    } catch (err: any) {
      setError(err.message);
      setTotp("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg text-lg font-bold"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            IM
          </div>
          <h1 className="text-xl font-semibold tracking-tight">INDMONEY</h1>
          <p className="mt-1 text-sm text-muted">Sign in with your INDstocks account</p>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-card p-5">
          {/* mode switch */}
          <div className="mb-5 flex rounded-[var(--radius-sm)] bg-[var(--bg)] p-1">
            <Tab active={mode === "totp"} onClick={() => { setMode("totp"); setError(null); }}>
              Authenticator
            </Tab>
            <Tab active={mode === "token"} onClick={() => { setMode("token"); setError(null); }}>
              Paste token
            </Tab>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "totp" ? (
              <>
                <Field label="MPIN">
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={mpin}
                    onChange={(e) => setMpin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="••••"
                    className={inputCls}
                    required
                  />
                </Field>
                <Field label="Authenticator code">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={totp}
                    onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123456"
                    className={`${inputCls} tabular tracking-[0.3em]`}
                    required
                  />
                </Field>
                <Hint>
                  5 wrong codes locks the account for 15 minutes, so check the code before
                  submitting.
                </Hint>
              </>
            ) : (
              <>
                <Field label="Access token">
                  <textarea
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste the token from indstocks.com → API trading → Access tokens"
                    rows={4}
                    className={`${inputCls} resize-none font-mono text-xs`}
                    required
                  />
                </Field>
                <Hint tone="warn">
                  A pasted token cannot be renewed by the app. When it expires, scanning and
                  trading stop until you sign in again.
                </Hint>
              </>
            )}

            {error && <Hint tone="down">{error}</Hint>}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-[var(--radius-sm)] px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

const inputCls =
  "w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm " +
  "text-fg outline-none placeholder:text-faint focus:border-[var(--accent)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-colors"
      style={{
        background: active ? "var(--card-hover)" : "transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
      }}
    >
      {children}
    </button>
  );
}

function Hint({ tone = "muted", children }: { tone?: "muted" | "warn" | "down"; children: React.ReactNode }) {
  const color =
    tone === "warn" ? "var(--warn)" : tone === "down" ? "var(--down)" : "var(--text-faint)";
  return <p className="text-xs leading-relaxed" style={{ color }}>{children}</p>;
}
