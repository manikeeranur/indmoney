import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionValue } from "@/lib/session";

// ─── Gate ─────────────────────────────────────────────────────────────────────
// Everything is closed by default. Only the login page, the login API and
// Next's own assets are open. This runs BEFORE any route handler, so there is
// no way to add a new page or API later and accidentally leave it public.
const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/api/auth/login",
  "/api/auth/session", // reports whether a session exists; leaks nothing
]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const ok = await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();

  // An API caller gets a clean 401 rather than a login page it cannot render.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and static files; gate everything else.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
