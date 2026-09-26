"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@/components/AppShell";

/**
 * /login must render outside the gate, otherwise the gate would redirect the
 * login page to itself. Everything else goes through AppShell.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}
