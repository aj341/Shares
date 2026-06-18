"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { Signal } from "@/lib/types";

/**
 * [calibration] Conviction calibration panel (ADDITIVE, read-only).
 *
 * Renders the per-score-band historical track record from /api/calibration:
 * win-rate, average forward return and sample size at each horizon, plus a
 * shrinkage-based conviction level. Honest about sparsity — low-n bands are
 * labelled "Unproven" and the panel shows an explicit empty state until
 * snapshots accumulate. Does NOT change the live score/signal anywhere.
 */

type ConvictionLevel = "High" | "Medium" | "Low" | "Unproven";

type BucketStat = {
  horizonDays: number;
  sampleSize: number;
  winRate: number;
  winRateVsBenchmark: number;
  avgReturn: number;
  medianReturn: number;
  avgExcessReturn: number;
  confidence: number;
  weight: number;
  level: ConvictionLevel;
};

type Calibration = {
  byBand: Record<string, Record<string, BucketStat>>;
  bySignal: Record<string, Record<string, BucketStat>>;
  horizons: number[];
  totalSnapshots: number;
  totalSamples: number;
  benchmarkAvailable: boolean;
  benchmark: string;
  computedAt: string;
};

const HORIZON_LABELS: Record<number, string> = { 5: "1W", 20: "1M", 60: "3M" };
const BAND_ORDER = ["STRONG_BUY", "BUY", "HOLD", "TRIM", "SELL"];

function isKnownSignal(s: string): s is Signal {
  return s in STATUS_LABELS;
}

function pct(frac: number): string {
  const v = frac * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function levelClass(level: ConvictionLevel): string {
  switch (level) {
    case "High":
      return "text-emerald-600 dark:text-emerald-400";
    case "Medium":
      return "text-amber-600 dark:text-amber-400";
    case "Low":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground/70";
  }
}

function StatCell({ stat }: { stat: BucketStat | undefined }) {
  if (!stat) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      title={`Win rate ${(stat.winRate * 100).toFixed(0)}% · vs ${"QQQ"} ${(
        stat.winRateVsBenchmark * 100
      ).toFixed(0)}% · weight ${stat.weight.toFixed(2)} · ${stat.level}`}
    >
      <span className={cn("font-mono-nums font-medium", signedTextClass(stat.avgReturn))}>
        {pct(stat.avgReturn)}
      </span>{" "}
      <span className="text-xs text-muted-foreground">
        ({(stat.winRate * 100).toFixed(0)}% · n={stat.sampleSize})
      </span>{" "}
      <span className={cn("text-xs font-medium", levelClass(stat.level))}>
        {stat.level}
      </span>
    </span>
  );
}

export function ConvictionCalibration() {
  const [data, setData] = useState<Calibration | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/calibration", { cache: "no-store" });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const json: { calibration: Calibration | null } = await res.json();
        if (active) setData(json.calibration);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const horizons = data?.horizons ?? [5, 20, 60];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          Conviction Calibration
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-muted-foreground">Couldn’t load conviction calibration.</p>
        ) : data === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : data === null || data.totalSamples === 0 ? (
          <p className="text-muted-foreground">
            Insufficient data — conviction is derived from the app’s own scored
            snapshots once they age past each horizon (1 week, 1 month, 3
            months). Bands stay “Unproven” until enough samples accumulate.
          </p>
        ) : (
          <div className="space-y-2">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Band</th>
                  {horizons.map((h) => (
                    <th key={h} className="pb-2 text-right font-medium">
                      {HORIZON_LABELS[h] ?? `${h}d`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BAND_ORDER.filter((b) => data.byBand[b]).map((band) => (
                  <tr key={band}>
                    <td className="py-1">
                      {isKnownSignal(band) ? (
                        <Badge variant={signalToVariant(band)}>
                          {STATUS_LABELS[band]}
                        </Badge>
                      ) : (
                        <span className="font-medium">{band}</span>
                      )}
                    </td>
                    {horizons.map((h) => (
                      <td key={h} className="py-1 text-right">
                        <StatCell stat={data.byBand[band]?.[String(h)]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Average forward return (win-rate · n) and conviction level per
              score band, shrunk toward neutral for small samples. Excess vs{" "}
              {data.benchmark || "QQQ"}. {data.totalSnapshots} snapshots ·{" "}
              {data.totalSamples} matured samples. Indicative only — does not
              change the live score or signal.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
