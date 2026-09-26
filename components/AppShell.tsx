"use client";

// ─── App shell — ported from frontend/app/options/page.tsx's header + left
// icon sidebar + mobile bottom nav (lines ~1495-1760, ~2767-2894). Same icons
// (@tabler/icons-react), same colors, same badge + live-pulse-dot behavior,
// and — corrected after an earlier pass shipped dark-only — the same
// light/dark toggle (lib/theme.tsx), defaulting to LIGHT like the real app.
// Auth gate added on top, since this app also needs an INDstocks login (the
// old app didn't gate the UI at all — anyone with the URL saw live positions,
// which is the hole fixed in lib/session.ts + middleware.ts).

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  IconWallet, IconLayoutGrid, IconScan, IconClock, IconBookmark, IconBookmarkFilled,
  IconChartLine, IconFileAnalytics, IconNotebook, IconCalendarEvent, IconPower,
} from "@tabler/icons-react";
import { useChainStore } from "@/lib/store/chainStore";
import { useLiveSocket } from "@/lib/useLiveSocket";
import { useTheme, ThemeToggle } from "@/lib/theme";

const MONO = { fontFamily: "'Space Mono', monospace" } as const;
const ACCENT = "#ea580c";

const NAV = [
  { tab: "account",  href: "/account",  icon: IconWallet,        label: "Account"  },
  { tab: "chain",    href: "/",         icon: IconLayoutGrid,    label: "Chain"    },
  { tab: "smc",      href: "/smc",      icon: IconScan,          label: "SMC"      },
  { tab: "vwap930",  href: "/vwap930",  icon: IconClock,         label: "VWAP 9:30"},
  { tab: "watchlist",href: "/watchlist",icon: IconBookmark,      label: "Watch"    },
  { tab: "ohlc",     href: "/ohlc",     icon: IconChartLine,     label: "OHLC"     },
  { tab: "results",  href: "/results",  icon: IconFileAnalytics, label: "Results"  },
  { tab: "journal",  href: "/journal",  icon: IconNotebook,      label: "Journal"  },
  { tab: "holidays", href: "/holidays", icon: IconCalendarEvent, label: "Holidays" },
] as const;

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["", "JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [smcCount, setSmcCount] = useState(0);
  const [vwapCount, setVwapCount] = useState(0);
  const [smcScanActive, setSmcScanActive] = useState(false);
  const [vwapScanActive, setVwapScanActive] = useState(false);
  const [watchCount, setWatchCount] = useState(0);
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [profile, setProfile] = useState<{ user_name: string | null; user_id: string | null } | null>(null);

  useLiveSocket();
  const connected = useChainStore((s) => s.connected);

  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch("/api/auth/session")
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setAuthed(!!d.session);
          if (!d.session) router.replace("/login");
        })
        .catch(() => alive && setAuthed(false));
    check();
    const id = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [router]);

  // Badge counts — same alerts/watchlist-count badges the old sidebar showed.
  useEffect(() => {
    if (!authed) return;
    const load = () => {
      fetch("/api/smc/status").then(r => r.json()).then(d => { setSmcCount(d.totalAlerts ?? 0); setSmcScanActive(!!d.scanActive); }).catch(() => {});
      fetch("/api/vwap930/status").then(r => r.json()).then(d => { setVwapCount(d.totalAlerts ?? 0); setVwapScanActive(!!d.scanActive); }).catch(() => {});
      fetch("/api/watchlist/groups").then(r => r.json()).then(d => setWatchCount((d.groups ?? []).reduce((s: number, g: any) => s + (g.items?.length ?? 0), 0))).catch(() => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [authed]);

  useEffect(() => {
    fetch("/api/holidays").then(r => r.json()).then(d => setHolidays(d.holidays ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetch("/api/auth/profile").then(r => r.json()).then(d => { if (!d.error) setProfile(d); }).catch(() => {});
  }, [authed]);

  if (authed === null) return <div className="flex min-h-screen items-center justify-center text-sm" style={{ color: "var(--text-muted)", ...MONO }}>Loading…</div>;
  if (!authed) return null;

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const dayIdx = now.getDay();
  const [, mm, dd] = todayStr.split("-");
  const isWeekend = dayIdx === 0 || dayIdx === 6;
  const holiday = holidays.find(h => h.date === todayStr);
  const status = holiday ? "HOLIDAY" : isWeekend ? "WEEKEND" : "WORKING";
  const statusClr = holiday || isWeekend ? "#e11d48" : "#16a34a";

  const activeTab = NAV.find(n => n.href === pathname)?.tab ?? (pathname === "/" ? "chain" : "");
  const text1 = isDark ? "#e2e8f0" : "#1e293b";
  const text2 = isDark ? "#94a3b8" : "#64748b";
  const inactive = isDark ? "#94a3b8" : "#64748b";

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* ── Header ── */}
      <header
        className="flex h-14 flex-shrink-0 items-center gap-3 px-3 md:px-4"
        style={{ background: "var(--shell-bg)", borderBottom: "1px solid var(--shell-border)" }}
      >
        <span
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-black"
          style={{ background: `${ACCENT}22`, color: ACCENT }}
          title={profile?.user_name ?? "INDMONEY"}
        >
          {profile?.user_name ? profile.user_name.slice(0, 2).toUpperCase() : "IM"}
        </span>
        {profile?.user_name ? (
          <div className="hidden min-w-0 flex-col items-start leading-tight sm:flex">
            <span className="max-w-[160px] truncate text-[12px] font-bold" style={{ ...MONO, color: text1 }}>
              {profile.user_name}
            </span>
            {profile.user_id && <span className="text-[9px]" style={{ ...MONO, color: text2 }}>{profile.user_id}</span>}
          </div>
        ) : (
          <span className="hidden text-sm font-bold tracking-tight sm:inline" style={{ color: text1 }}>INDMONEY</span>
        )}

        <div className="flex-1" />

        <button
          className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1.5 text-[10px] transition-colors md:px-3"
          style={{
            ...MONO,
            background: connected ? "rgba(22,163,74,0.1)" : "transparent",
            borderColor: connected ? "#16a34a" : (isDark ? "#334155" : "#cbd5e1"),
            color: connected ? "#16a34a" : text2,
          }}
        >
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${connected ? "live-pulse" : ""}`} style={{ background: connected ? "#16a34a" : "#94a3b8" }} />
          <span className="hidden sm:inline">{connected ? "LIVE" : "PAUSED"}</span>
        </button>

        <ThemeToggle />

        <div className="flex flex-shrink-0 flex-col items-end gap-0.5 leading-none">
          <div className="flex items-baseline gap-1">
            <span className="text-[11px] font-black" style={{ ...MONO, color: text1 }}>{DAY_NAMES[dayIdx]}</span>
            <span className="text-[10px] font-bold" style={{ ...MONO, color: text2 }}>{dd} {MONTHS[Number(mm)]}</span>
          </div>
          <span className="text-[7.5px] font-bold tracking-[0.8px]" style={{ ...MONO, color: statusClr }}>
            {holiday ? holiday.name.toUpperCase().slice(0, 14) : status}
          </span>
        </div>
      </header>

      {/* ── Body: sidebar + content ── */}
      <div className="flex flex-1 overflow-hidden">
        <nav
          className="hidden w-[60px] flex-shrink-0 flex-col items-center gap-1 py-3 md:flex"
          style={{ background: "var(--shell-bg)", borderRight: "1px solid var(--shell-border)" }}
        >
          {NAV.map(({ tab, href, icon: Icon, label }) => {
            const active = activeTab === tab;
            const badge = tab === "smc" ? smcCount : tab === "vwap930" ? vwapCount : tab === "watchlist" ? watchCount : undefined;
            return (
              <button
                key={tab}
                onClick={() => router.push(href)}
                title={label}
                className="relative flex h-11 w-11 flex-shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl transition-all"
                style={{ background: active ? "rgba(234,88,12,0.10)" : "transparent", color: active ? ACCENT : inactive }}
              >
                <Icon size={20} />
                {!!badge && (
                  <span
                    className="absolute right-1 top-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-0.5 text-[8px] font-bold text-white"
                    style={{ background: ACCENT, ...MONO }}
                  >
                    {badge}
                  </span>
                )}
                {tab === "smc" && smcScanActive && <span className="live-pulse absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full" style={{ background: "#7c3aed" }} />}
                {tab === "vwap930" && vwapScanActive && <span className="live-pulse absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full" style={{ background: "#0d9488" }} />}
              </button>
            );
          })}
          <div className="flex-1" />
          <ThemeToggle variant="icon" />
          <button
            onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); }}
            title="Sign out"
            className="flex h-11 w-11 flex-shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl text-[#e11d48]/50 transition-all hover:text-[#e11d48]"
          >
            <IconPower size={20} />
          </button>
        </nav>

        <main className="relative flex-1 overflow-auto">{children}</main>
      </div>

      {/* ── Mobile bottom nav ── */}
      <nav
        className="flex h-14 flex-shrink-0 items-center justify-around md:hidden"
        style={{ background: "var(--shell-bg)", borderTop: "1px solid var(--shell-border)" }}
      >
        {NAV.map(({ tab, href, icon: Icon, label }) => {
          const active = activeTab === tab;
          const badge = tab === "smc" ? smcCount : tab === "vwap930" ? vwapCount : tab === "watchlist" ? watchCount : undefined;
          const IconEl = tab === "watchlist" && active ? IconBookmarkFilled : Icon;
          return (
            <button
              key={tab}
              onClick={() => router.push(href)}
              className="relative flex h-full flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent"
              style={{ color: active ? ACCENT : inactive }}
            >
              <IconEl size={20} />
              <span className="text-[8px]" style={MONO}>{label === "VWAP 9:30" ? "9:30" : label}</span>
              {!!badge && (
                <span className="absolute right-[calc(50%-18px)] top-1.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-0.5 text-[8px] font-bold text-white" style={{ background: ACCENT }}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
