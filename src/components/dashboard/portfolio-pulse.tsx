"use client";

import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatPct } from "@/lib/utils";
import { signedTextClass, type BadgeVariant } from "@/lib/ui";
import type { PortfolioInsights, Mood } from "@/lib/insights";

const MOOD_VARIANT: Record<Mood, BadgeVariant> = {
  Bullish: "positive",
  Neutral: "neutral",
  Bearish: "negative",
};

export function PortfolioPulse({ insights }: { insights: PortfolioInsights }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Portfolio Pulse
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Overall mood</span>
          <Badge variant={MOOD_VARIANT[insights.mood]}>{insights.mood}</Badge>
        </div>
        {insights.best ? (
          <PerfRow label="Best performer" ticker={insights.best.ticker} pct={insights.best.pnlPct} />
        ) : null}
        {insights.worst ? (
          <PerfRow label="Worst performer" ticker={insights.worst.ticker} pct={insights.worst.pnlPct} />
        ) : null}
        <div className="flex items-start justify-between gap-3">
          <span className="shrink-0 text-muted-foreground">Buy signals</span>
          <div className="flex flex-wrap justify-end gap-1">
            {insights.buyTickers.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              insights.buyTickers.map((t) => (
                <Badge key={t} variant="brand" className="font-mono-nums">
                  {t}
                </Badge>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PerfRow({
  label,
  ticker,
  pct,
}: {
  label: string;
  ticker: string;
  pct: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono-nums font-medium">{ticker}</span>
        <span className={cn("font-mono-nums text-xs", signedTextClass(pct))}>
          {formatPct(pct, { sign: true })}
        </span>
      </span>
    </div>
  );
}
