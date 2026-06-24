"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { Signal } from "@/lib/types";

/**
 * [wfa] Walk-forward validation panel (ADDITIVE, read-only).
 *
 * Renders /api/walk-forward: per score band, the OUT-OF-SAMPLE win-rate / edge
 * across rolling folds plus the in-sample-vs-out-of-sample edge degradation
 * (the overfit indicator). Honest about sparsity. Never changes score/signal.
 */

type BandSummary = {
  band: string;
  horizonDays: number;
  foldsCounted: number;
  oosSamples: number;
  oosWinRate: number;
  oosAvgReturn: number;
  oosEdge: number;
  isEdge: number;
  edgeDegradation: number;
  insufficient: boolean;
};

type WalkForward = {
  bandSummaries: BandSummary[];
  horizons: number[];
  config: {
    isWindowDays: number;
    oosWindowDays: number;
    stepDays: number;
    minOosSamples: number;
  };
  totalSnapshots: number;
  distinctDates: number;
  countedOosSamples: number;
  meanEdgeDegradation: number;
  overfitVerdict: "robust" | "mild" | "overfit" | "insufficient";
  insufficientData: boolean;
  folds: unknown[];
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

function verdictClass(v: WalkForward["overfitVerdict"]): string {
  switch (v) {
    case "robust":
      return "text-emerald-600 dark:text-emerald-400";
    case "mild":
      return "text-amber-600 dark:text-amber-400";
    case "overfit":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-muted-foreground";
  }
}

function verdictLabel(v: WalkForward["overfitVerdict"]): string {
  switch (v) {
    case "robust":
      return "Robust (edge held out-of-sample)";
    case "mild":
      return "Mild decay out-of-sample";
    case "overfit":
      return "Overfit (edge did not hold)";
    default:
      return "Insufficient out-of-sample data";
  }
}

function Cell({ s }: { s: BandSummary | undefined }) {
  if (!s) return <span className="text-muted-foreground">&mdash;</span>;
  if (s.insufficient) {
    return (
      <span className="text-xs text-muted-foreground/70">
        insufficient{s.oosSamples ? ` (n=${s.oosSamples})` : ""}
      </span>
    );
  }
  return (
    <span
      title={`OOS win ${(s.oosWinRate * 100).toFixed(0)}% · OOS edge ${s.oosEdge.toFixed(
        2
      )} · IS edge ${s.isEdge.toFixed(2)} · degrade ${s.edgeDegradation.toFixed(
        2
      )} · ${s.foldsCounted} folds`}
    >
      <span className={cn("font-mono-nums font-medium", signedTextClass(s.oosAvgReturn))}>
        {pct(s.oosAvgReturn)}
      </span>{" "}
      <span className="text-xs text-muted-foreground">
        ({(s.oosWinRate * 100).toFixed(0)}% · n={s.oosSamples})
      </span>{" "}
      <span
        className={cn(
          "text-xs font-medium",
          s.edgeDegradation > 0.15
            ? "text-red-600 dark:text-red-400"
            : s.edgeDegradation > 0.05
              ? "text-amber-600 dark:text-amber-400"
              : "text-emerald-600 dark:text-emerald-400"
        )}
      >
        d{s.edgeDegradation >= 0 ? "+" : ""}
        {s.edgeDegradation.toFixed(2)}
      </span>
    </span>
  );
}

export function WalkForwardPanel() {
  const [data, setData] = useState<WalkForward | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/walk-forward", { cache: "no-store" });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const json: { walkForward: WalkForward | null } = await res.json();
        if (active) setData(json.walkForward);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const horizons = data?.horizons ?? [5, 20, 60];
  const empty =
    data === null ||
    (data != null && (data.insufficientData || data.bandSummaries.length === 0));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Walk-Forward Validation
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-muted-foreground">Couldn&rsquo;t load walk-forward validation.</p>
        ) : data === undefined ? (
          <p className="text-muted-foreground">Loading&hellip;</p>
        ) : empty ? (
          <p className="text-muted-foreground">
            Insufficient data &mdash; walk-forward splits the snapshot history into
            rolling in-sample windows (fit) and forward out-of-sample windows
            (test). The snapshot table is still too young to support an honest
            split
            {data ? ` (${data.totalSnapshots} snapshots, ${data.distinctDates} dates)` : ""}.
            Bands stay &ldquo;insufficient&rdquo; until enough out-of-sample samples mature.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Overfit indicator (mean IS&minus;OOS edge):
              </span>
              <span className={cn("text-sm font-semibold", verdictClass(data.overfitVerdict))}>
                {data.meanEdgeDegradation >= 0 ? "+" : ""}
                {data.meanEdgeDegradation.toFixed(2)} &middot; {verdictLabel(data.overfitVerdict)}
              </span>
            </div>
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
                {BAND_ORDER.filter((b) =>
                  data.bandSummaries.some((s) => s.band === b)
                ).map((band) => (
                  <tr key={band}>
                    <td className="py-1">
                      {isKnownSignal(band) ? (
                        <Badge variant={signalToVariant(band)}>{STATUS_LABELS[band]}</Badge>
                      ) : (
                        <span className="font-medium">{band}</span>
                      )}
                    </td>
                    {horizons.map((h) => (
                      <td key={h} className="py-1 text-right">
                        <Cell
                          s={data.bandSummaries.find(
                            (s) => s.band === band && s.horizonDays === h
                          )}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Out-of-sample avg return (win-rate &middot; n) and d = in-sample&minus;out-of-sample
              edge per band. Rolling {data.config.isWindowDays}d fit /{" "}
              {data.config.oosWindowDays}d test, step {data.config.stepDays}d.{" "}
              {data.countedOosSamples} matured OOS samples across {data.folds.length}{" "}
              folds. Positive d = the in-sample edge decayed out of sample (overfit).
              Indicative only &mdash; does not change the live score or signal.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
