"use client";

import * as React from "react";
import {
  CalendarRange,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * [earnings] Earnings catalyst calendar panel.
 *
 * Surfaces, per holding + watchlist name: next earnings date & days-until (with
 * a pre-positioning flag when <= ~5 trading days out), the forward estimate-
 * revision trend (up / flat / down), and a post-earnings-drift (PEAD) bias from
 * the last reported surprise. Reads /api/earnings; purely additive + display-
 * only — never affects scores, signals or trades. Degrades gracefully to an
 * empty state when no key / data is available.
 */

type RevisionTrend = "up" | "flat" | "down";
type PeadSignal = "drift_up" | "drift_down" | "none";

type EarningsRow = {
  ticker: string;
  companyName: string;
  kind: "holding" | "watchlist" | "both";
  nextDate?: string;
  daysUntil?: number;
  inPrePositioningWindow?: boolean;
  lastReportDate?: string;
  lastSurprisePct?: number;
  revisionTrend?: RevisionTrend;
  peadSignal?: PeadSignal;
};

function daysLabel(d?: number): string {
  if (d == null) return "—";
  if (d === 0) return "today";
  if (d < 0) return `${-d}d ago`;
  return `in ${d}d`;
}

function RevisionBadge({ trend }: { trend?: RevisionTrend }) {
  if (!trend) return null;
  if (trend === "up")
    return (
      <Badge variant="positive" className="gap-1 text-[10px]">
        <TrendingUp className="h-3 w-3" /> Est. ↑
      </Badge>
    );
  if (trend === "down")
    return (
      <Badge variant="negative" className="gap-1 text-[10px]">
        <TrendingDown className="h-3 w-3" /> Est. ↓
      </Badge>
    );
  return (
    <Badge variant="neutral" className="gap-1 text-[10px]">
      <Minus className="h-3 w-3" /> Est. flat
    </Badge>
  );
}

function PeadBadge({
  pead,
  surprisePct,
}: {
  pead?: PeadSignal;
  surprisePct?: number;
}) {
  if (!pead || pead === "none") return null;
  const sp =
    typeof surprisePct === "number"
      ? `${surprisePct >= 0 ? "+" : ""}${surprisePct.toFixed(1)}%`
      : "";
  if (pead === "drift_up")
    return (
      <Badge
        variant="positive"
        className="gap-1 text-[10px]"
        title={`Positive surprise ${sp} — post-earnings drift up bias`}
      >
        <Target className="h-3 w-3" /> PEAD ↑ {sp}
      </Badge>
    );
  return (
    <Badge
      variant="negative"
      className="gap-1 text-[10px]"
      title={`Negative surprise ${sp} — post-earnings drift down bias`}
    >
      <Target className="h-3 w-3" /> PEAD ↓ {sp}
    </Badge>
  );
}

export function EarningsCalendar() {
  const [rows, setRows] = React.useState<EarningsRow[] | null>(null);

  React.useEffect(() => {
    fetch("/api/earnings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d.rows) ? d.rows : []))
      .catch(() => setRows([]));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarRange className="h-4 w-4 text-muted-foreground" />
          Earnings Calendar &amp; Catalysts
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No earnings dates, estimate revisions or post-earnings drift signals
            available.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.ticker}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"
              >
                <Badge
                  variant="secondary"
                  className="font-mono-nums text-[10px]"
                >
                  {r.ticker}
                </Badge>
                {r.kind === "watchlist" && (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    watch
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {r.nextDate ? (
                    <>
                      Next report {r.nextDate}
                      {r.inPrePositioningWindow && (
                        <span className="ml-1 text-amber-600 dark:text-amber-500">
                          • pre-position
                        </span>
                      )}
                    </>
                  ) : r.lastReportDate ? (
                    <span className="text-muted-foreground">
                      Last reported {r.lastReportDate}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No date</span>
                  )}
                </span>
                <RevisionBadge trend={r.revisionTrend} />
                <PeadBadge pead={r.peadSignal} surprisePct={r.lastSurprisePct} />
                {r.nextDate && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {daysLabel(r.daysUntil)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
