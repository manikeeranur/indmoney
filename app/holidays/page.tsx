"use client";

// ─── Holidays tab ───────────────────────────────────────────────────────────────
// Full port of frontend/components/HolidaysTab.tsx: same date-badge row design
// (day/month block + name + day-of-week), same Upcoming/Past card split (past
// entries dimmed), same "N upcoming" pill in the header.
import { useTheme } from "@/lib/theme";
import { useHolidays } from "@/lib/holidays";

const MONO = { fontFamily: "'Inter', sans-serif" } as const;
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function dayName(dateStr: string) {
  return DAY_NAMES[new Date(dateStr + "T00:00:00").getDay()];
}

export default function HolidaysPage() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const border = isDark ? "#1e293b" : "#e2e8f0";
  const subtext = isDark ? "#64748b" : "#94a3b8";
  const text = isDark ? "#e2e8f0" : "#1e293b";
  const cardBg = isDark ? "#0f172a" : "#ffffff";

  const holidays = useHolidays();
  const today = new Date().toISOString().split("T")[0];
  const upcoming = holidays.filter(h => h.date >= today);
  const past = [...holidays.filter(h => h.date < today)].reverse();

  function Row({ h, dimmed }: { h: { date: string; name: string }; dimmed?: boolean }) {
    const [, mm, dd] = h.date.split("-");
    return (
      <div className="flex items-center gap-3 border-b px-4 py-3 last:border-0" style={{ borderColor: isDark ? "#1e293b" : "#f1f5f9", opacity: dimmed ? 0.45 : 1 }}>
        <div className="w-11 flex-shrink-0 rounded-lg py-1.5 text-center" style={{ background: dimmed ? (isDark ? "#1e293b" : "#f1f5f9") : "#ea580c15" }}>
          <div className="text-base font-black leading-none" style={{ ...MONO, color: dimmed ? subtext : "#ea580c" }}>{dd}</div>
          <div className="mt-0.5 text-xs font-bold" style={{ ...MONO, color: subtext }}>{MONTHS[+mm - 1]}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold" style={{ color: text }}>{h.name}</div>
          <div className="mt-0.5 text-sm" style={{ ...MONO, color: subtext }}>{dayName(h.date)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-bold uppercase tracking-[2px]" style={{ ...MONO, color: text }}>NSE Market Holidays</span>
        <span className="rounded-lg px-2 py-1 text-xs font-bold" style={{ ...MONO, background: "#ea580c15", color: "#ea580c" }}>{upcoming.length} upcoming</span>
      </div>

      {holidays.length === 0 ? (
        <div className="flex h-40 items-center justify-center">
          <span className="text-sm" style={{ ...MONO, color: subtext }}>Loading…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-2xl" style={{ background: cardBg, border: `1px solid ${border}` }}>
            <div className="border-b px-4 py-2.5" style={{ borderColor: border, background: isDark ? "#0a1220" : "#f8fafc" }}>
              <span className="text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: subtext }}>Upcoming</span>
            </div>
            {upcoming.length > 0 ? upcoming.map(h => <Row key={h.date} h={h} />) : (
              <div className="px-4 py-6 text-center">
                <span className="text-sm" style={{ ...MONO, color: subtext }}>No more holidays this year</span>
              </div>
            )}
          </div>

          {past.length > 0 && (
            <div className="overflow-hidden rounded-2xl" style={{ background: cardBg, border: `1px solid ${border}` }}>
              <div className="border-b px-4 py-2.5" style={{ borderColor: border, background: isDark ? "#0a1220" : "#f8fafc" }}>
                <span className="text-xs font-bold uppercase tracking-[1.5px]" style={{ ...MONO, color: subtext }}>Past</span>
              </div>
              {past.map(h => <Row key={h.date} h={h} dimmed />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
