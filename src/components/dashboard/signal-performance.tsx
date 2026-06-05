"use client";

import { useEffect, useState } from "react";
import { LineChart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { Signal } from "@/lib/types";

/** One row of backtested signal performance, mirroring getSignalPerformance(). */
type SignalPerformanceRow = {
  signal: string;
  samples: number;
  avgForwardReturnPct: number | null;
};

/** Recognised signals get a labelled, colour-mapped badge; anything else falls back to raw text. */
function isKnownSignal(signal: string): signal is Signal {
  return signal in STATUS_LABELS;
}

function formatForwardReturn(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
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
          Signal Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-muted-foreground">Couldn’t load signal performance.</p>
        ) : rows === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            Collecting data — signal performance appears once a few daily snapshots accumulate.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
              <span>Signal</span>
              <span className="flex items-center gap-4">
                <span>Samples</span>
                <span>Avg fwd return</span>
              </span>
            </div>
            {rows.map((row) => (
              <div key={row.signal} className="flex items-center justify-between">
                {isKnownSignal(row.signal) ? (
                  <Badge variant={signalToVariant(row.signal)}>
                    {STATUS_LABELS[row.signal]}
                  </Badge>
                ) : (
                  <span className="font-medium">{row.signal}</span>
                )}
                <span className="flex items-center gap-4">
                  <span className="font-mono-nums text-muted-foreground">
                    {row.samples}
                  </span>
                  <span
                    className={cn(
                      "font-mono-nums font-medium",
                      row.avgForwardReturnPct === null
                        ? "text-muted-foreground"
                        : signedTextClass(row.avgForwardReturnPct)
                    )}
                  >
                    {formatForwardReturn(row.avgForwardReturnPct)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
