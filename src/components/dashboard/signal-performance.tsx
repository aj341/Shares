"use client";

import { useEffect, useState } from "react";
import { LineChart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { Signal } from "@/lib/types";

/** Aggregate stats for one signal × horizon cell, mirroring getSignalPerformance(). */
type HorizonStats = {
  meanExcessPct: number;
  samples: number;
  hitRatePct: number;
};

/** One row of backtested signal performance, mirroring getSignalPerformance(). */
type SignalPerformanceRow = {
  signal: string;
  /** Aligned with HORIZON_LABELS (5 / 21 / 63 trading days); null = no matured samples. */
  horizons: (HorizonStats | null)[];
};

/** Display labels for the fixed 5 / 21 / 63 trading-day horizons. */
const HORIZON_LABELS = ["1W", "1M", "3M"] as const;

/** Recognised signals get a labelled, colour-mapped badge; anything else falls back to raw text. */
function isKnownSignal(signal: string): signal is Signal {
  return signal in STATUS_LABELS;
}

function formatExcess(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function HorizonCell({ stats }: { stats: HorizonStats | null }) {
  if (stats === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span title={`Hit rate ${stats.hitRatePct}%`}>
      <span
        className={cn(
          "font-mono-nums font-medium",
          signedTextClass(stats.meanExcessPct)
        )}
      >
        {formatExcess(stats.meanExcessPct)}
      </span>{" "}
      <span className="text-xs text-muted-foreground">(n={stats.samples})</span>
    </span>
  );
}

export function SignalPerformance() {
  const [rows, setRows] = useState<SignalPerformanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/backtest", { cache: "no-store" });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data: { performance: SignalPerformanceRow[] } = await res.json();
        if (active) setRows(data.performance ?? []);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LineChart className="h-4 w-4 text-muted-foreground" />
          Signal Performance vs QQQ
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-muted-foreground">Couldn’t load signal performance.</p>
        ) : rows === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            No matured samples yet — results accumulate as daily snapshots age
            past each horizon (1 week, 1 month, 3 months).
          </p>
        ) : (
          <div className="space-y-2">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Signal</th>
                  {HORIZON_LABELS.map((label) => (
                    <th key={label} className="pb-2 text-right font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.signal}>
                    <td className="py-1">
                      {isKnownSignal(row.signal) ? (
                        <Badge variant={signalToVariant(row.signal)}>
                          {STATUS_LABELS[row.signal]}
                        </Badge>
                      ) : (
                        <span className="font-medium">{row.signal}</span>
                      )}
                    </td>
                    {HORIZON_LABELS.map((label, h) => (
                      <td key={label} className="py-1 text-right">
                        <HorizonCell stats={row.horizons[h] ?? null} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Forward returns minus QQQ over the same window. Small samples —
              indicative only.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
