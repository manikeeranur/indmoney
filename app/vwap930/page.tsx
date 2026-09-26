"use client";

import { useEffect, useState } from "react";
import { StrategyTableView } from "@/components/StrategyTableView";

export default function Vwap930Page() {
  const [expiry, setExpiry] = useState("");

  useEffect(() => {
    fetch("/api/expiries").then(r => r.json()).then(d => setExpiry(d.expiries?.[0] ?? "")).catch(() => {});
  }, []);

  return (
    <StrategyTableView
      expiry={expiry}
      api={{ base: "/api/vwap930", autoTradeBase: "/api/vwap930-auto-trade", label: "VWAP 9:30", hasTwoTargets: false }}
    />
  );
}
