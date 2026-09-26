"use client";

import { useEffect, useState } from "react";
import { StrategyTableView } from "@/components/StrategyTableView";

export default function SMCPage() {
  const [expiry, setExpiry] = useState("");

  useEffect(() => {
    fetch("/api/expiries").then(r => r.json()).then(d => setExpiry(d.expiries?.[0] ?? "")).catch(() => {});
  }, []);

  return (
    <StrategyTableView
      expiry={expiry}
      api={{ base: "/api/smc", autoTradeBase: "/api/auto-trade", label: "SMC", hasTwoTargets: true }}
    />
  );
}
