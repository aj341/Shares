// [sizing] Concentration / position-sizing panel. Additive UI — renders the
// configurable limits, per-limit OK/WARN/BREACH status, headline metrics
// (largest name, top-3, HHI / effective names, cash, top sector) and the
// suggested max $ per name. Mounted next to the existing PortfolioRisk widget.
"use client";

import * as React from "react";
import { Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Status = "OK" | "WARN" | "BREACH";

type Assessment = {
  metrics: {
    nameCount: number;
    largestSingleNameWeight: number;
    largestSingleNameTicker: string | null;
    top3Weight: number;
    hhi: number;
    effectiveNames: number | null;
    cashWeight: number;
    topSector: string | null;
    topSectorWeight: number;
  };
  limits: {
    maxSingleNameWeight: number;
    warnSingleName: number;
    maxTop3: number;
    maxSectorWeight: number;
  };
  assessments: Array<{
    key: string;
    label: string;
    value: number;
    limit: number;
    status: Status;
    message: string;
    subject: string | null;
  }>;
  overallStatus: Status;
  grade: "A" | "B" | "C" | "D";
  maxDollarsPerName: number;
  messages: string[];
};

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

const STATUS_CLASS: Record<Status, string> = {
  OK: "[color:hsl(var(--positive))] [background:hsl(var(--positive)/0.12)]",
  WARN: "[color:hsl(38_92%_45%)] [background:hsl(38_92%_50%/0.14)]",
  BREACH: "[color:hsl(var(--negative))] [background:hsl(var(--negative)/0.12)]",
};

export function ConcentrationPanel() {
  const [data, setData] = React.useState<Assessment | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/concentration", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Concentration & Sizing
          </span>
          {data ? (
            <span
              className={cn(
                "rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                STATUS_CLASS[data.overallStatus]
              )}
            >
              {data.overallStatus} · Grade {data.grade}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Concentration analytics unavailable.
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
                label="Largest name"
                value={
                  data.metrics.largestSingleNameTicker
                    ? `${data.metrics.largestSingleNameTicker} ${pct(data.metrics.largestSingleNameWeight)}`
                    : "—"
                }
              />
              <Metric label="Top 3" value={pct(data.metrics.top3Weight)} />
              <Metric
                label="Eff. names"
                value={
                  data.metrics.effectiveNames != null
                    ? data.metrics.effectiveNames.toFixed(1)
                    : "—"
                }
                hint={`HHI ${data.metrics.hhi.toFixed(2)}`}
              />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric label="Names" value={String(data.metrics.nameCount)} />
              <Metric label="Cash" value={pct(data.metrics.cashWeight)} />
              <Metric
                label="Top sector"
                value={
                  data.metrics.topSector
                    ? pct(data.metrics.topSectorWeight)
                    : "—"
                }
                hint={data.metrics.topSector ?? undefined}
              />
            </div>

            {/* Per-limit status with OK/WARN/BREACH coloring. */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Limits & status
              </p>
              {data.assessments.map((a) => (
                <div
                  key={a.key}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate">
                    {a.label}
                    <span className="text-muted-foreground">
                      {" "}
                      (limit {pct(a.limit)})
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono-nums">{pct(a.value)}</span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                        STATUS_CLASS[a.status]
                      )}
                    >
                      {a.status}
                    </span>
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Suggested max per name (risk budget)
              </span>
              <span className="font-mono-nums font-semibold">
                $
                {data.maxDollarsPerName.toLocaleString("en-US", {
                  maximumFractionDigits: 0,
                })}
              </span>
            </div>

            {data.messages.length > 0 && (
              <div className="space-y-1">
                {data.messages.map((m, i) => (
                  <p
                    key={i}
                    className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                  >
                    {m}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <p className="font-mono-nums text-sm font-semibold">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {hint ? (
        <p className="truncate text-[9px] text-muted-foreground/70">{hint}</p>
      ) : null}
    </div>
  );
}
