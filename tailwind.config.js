/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Tailwind classes resolve to the same tokens as raw CSS, so there is one
      // source of truth for colour — styles/theme.css.
      colors: {
        bg:        "var(--bg)",
        elevated:  "var(--bg-elevated)",
        card:      "var(--card)",
        cardHover: "var(--card-hover)",
        border:    "var(--border)",
        borderStrong: "var(--border-strong)",
        fg:        "var(--text)",
        muted:     "var(--text-muted)",
        faint:     "var(--text-faint)",
        accent:    "var(--accent)",
        accent2:   "var(--accent-2)",
        up:        "var(--up)",
        down:      "var(--down)",
        flat:      "var(--flat)",
        warn:      "var(--warn)",
        info:      "var(--info)",
        ce:        "var(--ce)",
        pe:        "var(--pe)",
      },
      borderRadius: { DEFAULT: "var(--radius)", sm: "var(--radius-sm)", lg: "var(--radius-lg)" },
      fontFamily:   { sans: "var(--font-sans)", mono: "var(--font-mono)", display: "var(--font-display)" },
    },
  },
  plugins: [],
};
