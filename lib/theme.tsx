"use client";

// ─── Theme provider ─────────────────────────────────────────────────────────────
// Ported from frontend/lib/theme.tsx exactly: same localStorage key
// ("smc_theme"), same default ("light" — the old app's actual default theme,
// which the first pass of this migration dropped and shipped dark-only
// instead), same data-theme attribute mechanism that styles/theme.css's
// [data-theme="light"] / [data-theme="dark"] blocks key off.
import { createContext, useContext, useEffect, useState } from "react";
import { IconMoon, IconSun } from "@tabler/icons-react";

type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    let saved: Theme = "light";
    try { saved = (localStorage.getItem("smc_theme") as Theme) ?? "light"; } catch {}
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    try { localStorage.setItem("smc_theme", next); } catch {}
    document.documentElement.setAttribute("data-theme", next);
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeToggle({ className, variant = "default" }: { className?: string; variant?: "default" | "icon" }) {
  const { theme, toggle } = useTheme();
  if (variant === "icon") {
    return (
      <button onClick={toggle} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        className="flex h-11 w-11 flex-shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl transition-all"
        style={{ color: "#94a3b8" }}>
        {theme === "light" ? <IconMoon size={20} /> : <IconSun size={20} />}
      </button>
    );
  }
  return (
    <button onClick={toggle} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm border transition-all ${className ?? ""}`}
      style={{
        background: theme === "dark" ? "rgba(2,132,199,0.1)" : "rgba(0,0,0,0.04)",
        borderColor: theme === "dark" ? "#1e2a3a" : "#cbd5e1",
        color: theme === "dark" ? "#94a3b8" : "#64748b",
      }}>
      {theme === "light" ? <IconMoon size={14} /> : <IconSun size={14} />}
    </button>
  );
}
