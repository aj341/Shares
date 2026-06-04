"use client";

import { ArrowDownToLine, ArrowUpFromLine, Scissors } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatCurrency } from "@/lib/utils";
import { signedTextClass, type BadgeVariant } from "@/lib/ui";
import type {
  RedistributionSummary,
  TradeRecommendation,
} from "@/lib/types";

const ACTION_META: Record<
  TradeRecommendation["action"],
  { variant: BadgeVariant; Icon: typeof ArrowUpFromLine }
> = {
  BUY: { variant: "positive", Icon: ArrowDownToLine },
  SELL: { variant: "negative", Icon: ArrowUpFromLine },
  TRIM: { variant: "warning", Icon: Scissors },
};

export function RedistributionSummaryCards({
  summary,
}: {
  summary: RedistributionSummary;
}) {
  const items = [
    { label: "Total proceeds", value: formatCurrency(summary.totalProceeds) },
    { label: "Total invested", value: formatCurrency(summary.totalInvested) },
    { label: "New cash balance", value: formatCurrency(summary.newCashBalance) },
    {
      label: "Max weight",
      value: `${summary.maxWeightBefore.toFixed(1)}% → ${summary.maxWeightAfter.toFixed(1)}%`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label}>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {it.label}
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{it.value}</p>
          </CardContent>
        </Card>
      ))}
      {summary.tickersFullySold.length > 0 ? (
        <Card className="col-span-2 lg:col-span-4">
          <CardContent className="flex flex-wrap items-center gap-2 p-4">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Fully sold
            </span>
            {summary.tickersFullySold.map((t) => (
              <Badge key={t} variant="negative">
                {t}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function RedistributionTable({
  recommendations,
}: {
  recommendations: TradeRecommendation[];
}) {
  if (recommendations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
        <p className="text-sm font-medium">No trades recommended</p>
        <p className="text-xs text-muted-foreground">
          Every position is within tolerance — hold the book as-is.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Action</TableHead>
          <TableHead>Ticker</TableHead>
          <TableHead className="text-right">Shares</TableHead>
          <TableHead className="text-right">Est. price</TableHead>
          <TableHead className="text-right">Proceeds / cost</TableHead>
          <TableHead className="text-right">Est. realised P&L</TableHead>
          <TableHead className="min-w-[260px]">Rationale</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {recommendations.map((r, i) => {
          const meta = ACTION_META[r.action];
          return (
            <TableRow key={`${r.ticker}-${i}`} className="hover:bg-muted/40">
              <TableCell>
                <Badge variant={meta.variant} className="gap-1">
                  <meta.Icon className="h-3 w-3" />
                  {r.action}
                </Badge>
              </TableCell>
              <TableCell className="font-semibold">{r.ticker}</TableCell>
              <TableCell className="text-right tabular-nums">{r.shares}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(r.estimatedPrice)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(r.estimatedProceedsOrCost)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right tabular-nums",
                  r.estimatedRealisedPnl !== undefined
                    ? signedTextClass(r.estimatedRealisedPnl)
                    : "text-muted-foreground"
                )}
              >
                {r.estimatedRealisedPnl !== undefined
                  ? formatCurrency(r.estimatedRealisedPnl, { sign: true })
                  : "—"}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {r.rationale}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
