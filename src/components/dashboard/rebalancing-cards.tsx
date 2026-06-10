"use client";

import { ArrowDownToLine, ArrowUpFromLine, Scissors, Target } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency, formatPct, formatUsd } from "@/lib/utils";
import { signedTextClass } from "@/lib/ui";
import type { Holding, RedistributionResponse } from "@/lib/types";

/**
 * Rich "Rebalancing Recommendations" layout matching the reference: a header
 * card per SELL/TRIM (proceeds, cost, realised P&L, residual cash), then the
 * redistribution split and a card per BUY with reasoning and current→new total.
 * Pure presentation over the existing redistribution contract.
 */
export function RebalancingCards({
  redistribution,
  holdings,
}: {
  redistribution: RedistributionResponse;
  holdings: Holding[];
}) {
  const { recommendations, summary } = redistribution;
  const sells = recommendations.filter((r) => r.action === "SELL" || r.action === "TRIM");
  const buys = recommendations.filter((r) => r.action === "BUY");
  const totalInvested = buys.reduce((s, b) => s + b.estimatedProceedsOrCost, 0) || 1;
  const sharesOf = (t: string) => holdings.find((h) => h.ticker === t)?.shares ?? 0;

  if (recommendations.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-1 py-12 text-center">
          <Target className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">Portfolio is balanced</p>
          <p className="text-xs text-muted-foreground">
            No trades recommended — every position is within tolerance.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Target className="h-5 w-5 [color:hsl(var(--brand))]" />
        <h2 className="text-base font-semibold">Rebalancing Recommendations</h2>
      </div>

      {/* Source: sells / trims */}
      {sells.map((s) => {
        const costBasis = s.estimatedRealisedPnl != null
          ? s.estimatedProceedsOrCost - s.estimatedRealisedPnl
          : null;
        return (
          <Card key={`${s.action}-${s.ticker}`} className="overflow-hidden">
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Badge variant={s.action === "SELL" ? "negative" : "warning"} className="gap-1">
                  {s.action === "SELL" ? (
                    <ArrowUpFromLine className="h-3 w-3" />
                  ) : (
                    <Scissors className="h-3 w-3" />
                  )}
                  {s.action} {s.ticker}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  — {s.shares} shares @ {formatUsd(s.estimatedPrice)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Gross Proceeds" value={formatCurrency(s.estimatedProceedsOrCost)} />
                <Metric label="Cost Basis" value={costBasis != null ? formatCurrency(costBasis) : "—"} />
                <Metric
                  label="Realised P&L"
                  value={s.estimatedRealisedPnl != null ? formatCurrency(s.estimatedRealisedPnl, { sign: true }) : "—"}
                  className={s.estimatedRealisedPnl != null ? signedTextClass(s.estimatedRealisedPnl) : undefined}
                />
                <Metric label="Residual Cash" value={formatCurrency(summary.newCashBalance)} className="[color:hsl(var(--warning))]" />
              </div>
              {s.rationale && (
                <p className="mt-3 text-sm text-muted-foreground">{s.rationale}</p>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Redistribution split */}
      {buys.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold [color:hsl(var(--brand))]">Redistribute</span>{" "}
          <span className="text-muted-foreground">
            {buys
              .map((b) => `${Math.round((b.estimatedProceedsOrCost / totalInvested) * 100)}% ${b.ticker}`)
              .join(" · ")}
          </span>
        </p>
      )}

      {/* Targets: buys */}
      {buys.map((b) => {
        const cur = sharesOf(b.ticker);
        return (
          <Card key={`BUY-${b.ticker}`}>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="positive" className="gap-1">
                    <ArrowDownToLine className="h-3 w-3" /> {b.ticker}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {Math.round((b.estimatedProceedsOrCost / totalInvested) * 100)}% of proceeds (
                    {formatCurrency(b.estimatedProceedsOrCost)})
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  @ {formatUsd(b.estimatedPrice)}/share
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Shares to Buy" value={`+${b.shares}`} className="[color:hsl(var(--positive))]" />
                <Metric label="Total Cost" value={formatCurrency(b.estimatedProceedsOrCost)} />
                <Metric label="Current Holding" value={`${cur} shares`} />
                <Metric label="New Total" value={`${cur + b.shares} shares`} className="[color:hsl(var(--brand))]" />
              </div>
              {b.rationale && (
                <p className="mt-3 text-sm text-muted-foreground">{b.rationale}</p>
              )}
            </CardContent>
          </Card>
        );
      })}

      <p className="text-center text-xs text-muted-foreground">
        Max weight {formatPct(summary.maxWeightBefore)} → {formatPct(summary.maxWeightAfter)} ·
        Residual cash {formatCurrency(summary.newCashBalance)} held as buffer
        {summary.targetCashBufferPct != null
          ? ` (target ${(summary.targetCashBufferPct * 100).toFixed(0)}%${
              summary.regimeLabel ? ` — ${summary.regimeLabel}` : ""
            })`
          : ""}
        {summary.candidatesConsidered && summary.candidatesConsidered.length > 0 && (
          <span className="mt-1 block">
            New-position contest:{" "}
            {summary.candidatesConsidered
              .map((c) => `${c.ticker} ${c.score != null ? `scored ${c.score}/100` : "unscored"}`)
              .join(", ")}{" "}
            — needs 70+ to outbid topping up existing holdings.
          </span>
        )}
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("font-mono-nums text-sm font-semibold", className)}>{value}</p>
    </div>
  );
}
