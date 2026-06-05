"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatPct } from "@/lib/utils";

type RiskAnalysis = {
  benchmark: string;
  relativeStrength: Array<{ ticker: string; sixMonthReturnPct: number | null; vsBenchmarkPct: number | null }>;
  portfolioBeta: number | null;
  topConcentration: { ticker: string; weight: number } | null;
  herfindahl: number;
  sectorConcentration: Array<{ sector: string; weight: number }>;
  correlation: { pairs: Array<{ a: string; b: string; corr: number }>; note: string };
};

export function PortfolioRisk() {
  const [data, setData] = React.useState<RiskAnalysis | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/risk", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          Portfolio Risk
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Risk analytics unavailable.
          </p>
        ) : !data ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric
                label={`Beta vs ${data.benchmark}`}
                value={data.portfolioBeta != null ? data.portfolioBeta.toFixed(2) : "—"}
              />
              <Metric
                label="Top position"
                value={
                  data.topConcentration
                    ? `${data.topConcentration.ticker} ${data.topConcentration.weight.toFixed(0)}%`
                    : "—"
                }
              />
              <Metric
                label="Concentration"
                value={data.herfindahl ? data.herfindahl.toFixed(2) : "—"}
                hint="HHI 0–1"
              />
            </div>

            {data.sectorConcentration.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Sector concentration</p>
                {data.sectorConcentration.slice(0, 4).map((s) => (
                  <div key={s.sector} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{s.sector}</span>
                    <span className="font-mono-nums">{formatPct(s.weight)}</span>
                  </div>
                ))}
              </div>
            )}

            {data.relativeStrength.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  6-mo return vs {data.benchmark}
                </p>
                {data.relativeStrength.map((r) => (
                  <div key={r.ticker} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono-nums">{r.ticker}</span>
                    <span
                      className={cn(
                        "font-mono-nums",
                        r.vsBenchmarkPct == null
                          ? "text-muted-foreground"
                          : r.vsBenchmarkPct >= 0
                            ? "[color:hsl(var(--positive))]"
                            : "[color:hsl(var(--negative))]"
                      )}
                    >
                      {r.vsBenchmarkPct == null ? "—" : formatPct(r.vsBenchmarkPct, { sign: true })}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {data.correlation.note && (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {data.correlation.note}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <p className="font-mono-nums text-sm font-semibold">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      {hint ? <p className="text-[9px] text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}
