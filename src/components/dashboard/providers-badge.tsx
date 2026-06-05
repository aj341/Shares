"use client";

import * as React from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type ProviderCheck = {
  ticker: string;
  finnhub: number | null;
  mboum: number | null;
  divergencePct: number | null;
  agree: boolean;
};

/** Small header indicator: do Finnhub & Mboum prices corroborate? */
export function ProvidersBadge() {
  const [checks, setChecks] = React.useState<ProviderCheck[] | null>(null);

  React.useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setChecks(d.checks ?? []))
      .catch(() => setChecks([]));
  }, []);

  if (!checks || checks.length === 0) return null;

  const diverging = checks.filter((c) => !c.agree);
  if (diverging.length === 0) {
    return (
      <Badge variant="positive" className="hidden gap-1 sm:inline-flex" title="Finnhub & Mboum prices corroborate (<1.5% apart)">
        <ShieldCheck className="h-3 w-3" /> Sources agree
      </Badge>
    );
  }
  return (
    <Badge
      variant="warning"
      className="hidden gap-1 sm:inline-flex"
      title={diverging.map((c) => `${c.ticker} ${c.divergencePct?.toFixed(1)}%`).join(", ")}
    >
      <ShieldAlert className="h-3 w-3" /> {diverging.length} source{diverging.length > 1 ? "s" : ""} diverge
    </Badge>
  );
}
