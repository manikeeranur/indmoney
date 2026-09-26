"use client";

// Loads the Google Fonts stylesheet without blocking first paint: the
// classic "media=print, then flip to all on load" trick. Needs to be a
// Client Component because of the onLoad handler — app/layout.tsx itself
// can't be one (it exports `metadata`, which Server Components only).
const FONT_HREF = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:wght@400;700&display=swap";

export default function FontLoader() {
  return (
    <>
      <link rel="stylesheet" href={FONT_HREF} media="print" onLoad={(e) => { (e.currentTarget as HTMLLinkElement).media = "all"; }} />
      <noscript><link rel="stylesheet" href={FONT_HREF} /></noscript>
    </>
  );
}
