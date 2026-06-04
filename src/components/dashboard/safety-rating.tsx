"use client";

import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatPct } from "@/lib/utils";
import type { PortfolioInsights } from "@/lib/insights";

const TONE_STROKE: Record<PortfolioInsights["safety"]["tone"], string> = {
  positive: "hsl(var(--positive))",
  warning: "hsl(var(--warning))",
  negative: "hsl(var(--negative))",
};

const TONE_TEXT: Record<PortfolioInsights["safety"]["tone"], string> = {
  positive: "[color:hsl(var(--positive))]",
  warning: "[color:hsl(var(--warning))]",
  negative: "[color:hsl(var(--negative))]",
};

/** SVG ring gauge (0–10). No chart lib needed — crisp at any size. */
function Gauge({
  value,
  stroke,
}: {
  value: number;
  stroke: string;
}) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / 10));
  return (
    <svg viewBox="0 0 140 140" className="h-32 w-32 -rotate-90">
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke="hsl(var(--muted))"
        strokeWidth="10"
      />
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
      />
    </svg>
  );
}

export function SafetyRating({ insights }: { insights: PortfolioInsights }) {
  const { safety } = insights;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Safety Rating
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-5">
        <div className="relative shrink-0">
          <Gauge value={safety.score10} stroke={TONE_STROKE[safety.tone]} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn("font-mono-nums text-2xl font-bold", TONE_TEXT[safety.tone])}>
              {safety.score10.toFixed(1)}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {safety.label}
            </span>
          </div>
        </div>
        <dl className="flex-1 space-y-2 text-sm">
          <Row label="Winners / Losers" value={`${insights.winners} / ${insights.losers}`} />
          <Row label="Bullish signals" value={`${insights.bullishPct}%`} />
          <Row
            label="Max concentration"
            value={formatPct(insights.maxConcentration)}
            warn={insights.maxConcentration > 30}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-mono-nums font-medium",
          warn && "[color:hsl(var(--warning))]"
        )}
      >
        {value}
      </dd>
    </div>
  );
}
