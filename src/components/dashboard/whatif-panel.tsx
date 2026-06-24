"use client";

import * as React from "react";
import { History, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatUsd } from "@/lib/utils";
import { signedTextClass } from "@/lib/ui";
import type { BadgeVariant } from "@/lib/ui";

/**
 * [whatif] Sell-decision counterfactual view — "what if I hadn't sold?".
 *
 * Read-only view over /api/whatif. Mirrors the server shapes structurally
 * (kept local so shared types stay minimal, like journal-panel.tsx). For every
 * SELL / TRIM it shows the sell price, current price, decision P&L ($ and %), a
 * verdict (Good call / Too early / Neutral) and a sparkline of the
 * counterfactual since the sale, plus an aggregate header (total decision P&L
 * and hit rate). Honest about sparsity: unpriced sells render an em dash and a
 * "no live price" note; missing history hides the sparkline.
 */

type Point = { date: string; counterfactual: number; decisionPnl: number };

type WhatIfSell = {
  id: string;
  ticker: string;
  companyName: string;
  sector: string;
  kind: "sell" | "trim";
  sellDate: string;
  soldShares: number;
  sellPrice: number;
  proceeds: number;
  currentPrice: number | null;
  decisionPnl: number | null;
  decisionPnlPct: number | null;
  verdict: "good" | "early" | "neutral" | "unknown";
  priced: boolean;
  series: Point[];
  best: Point | null;
  worst: Point | null;
  current: Point | null;
  seriesAvailable: boolean;
};

type WhatIfSummary = {
  totalSells: number;
  pricedSells: number;
  totalDecisionPnl: number;
  goodCalls: number;
  earlyCalls: number;
  neutralCalls: number;
  hitRatePct: number | null;
  bestDecisionPnl: number | null;
  worstDecisionPnl: number | null;
};

type WhatIfResponse = {
  sells: WhatIfSell[];
  summary: WhatIfSummary;
  data: { priceUsed: boolean; seriesUsed: boolean };
};

const dash = "—";
function pct(v: number | null, sign = false): string {
  if (v == null) return dash;
  const s = sign && v > 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}

const VERDICT: Record<
  WhatIfSell["verdict"],
  { label: string; variant: BadgeVariant }
> = {
  good: { label: "Good call", variant: "positive" },
  early: { label: "Too early", variant: "negative" },
  neutral: { label: "Neutral", variant: "neutral" },
  unknown: { label: "No price", variant: "neutral" },
};

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-mono-nums text-lg font-bold", tone)}>{value}</p>
    </div>
  );
}

/**
 * Inline SVG sparkline of the counterfactual DECISION P&L since the sale. The
 * line is the running decision P&L; a baseline at 0 separates "good" (above,
 * green) from "too early" (below, red). The trailing dot marks "now".
 */
function Sparkline({ series, width = 120, height = 28 }: { series: Point[]; width?: number; height?: number }) {
  if (series.length < 2) {
    return <span className="text-xs text-muted-foreground">{dash}</span>;
  }
  const vals = series.map((p) => p.decisionPnl);
  let min = Math.min(...vals, 0);
  let max = Math.max(...vals, 0);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = 2;
  const x = (i: number) => pad + (i / (series.length - 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (height - 2 * pad);
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.decisionPnl).toFixed(1)}`).join(" ");
  const last = series[series.length - 1].decisionPnl;
  const stroke = last > 0 ? "hsl(var(--positive))" : last < 0 ? "hsl(var(--negative))" : "hsl(var(--muted-foreground))";
  const zeroY = y(0);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" role="img" aria-label="Counterfactual decision P&L since sale">
      <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} stroke="hsl(var(--border))" strokeWidth={1} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(series.length - 1)} cy={y(last)} r={2} fill={stroke} />
    </svg>
  );
}

export function WhatIfPanel() {
  const [data, setData] = React.useState<WhatIfResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch("/api/whatif", { cache: "no-store" });
        if (!r.ok) throw new Error(`whatif ${r.status}`);
        const j = (await r.json()) as WhatIfResponse;
        if (active) setData(j);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the sell-decision counterfactual.
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading sell decisions&hellip;</CardContent>
      </Card>
    );
  }

  const s = data.summary;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="h-4 w-4 text-muted-foreground" />
          Sell decisions &mdash; what if I hadn&rsquo;t sold?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {s.totalSells === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sells or trims in the ledger yet. Once you sell or trim a position,
            each decision is replayed here against the live price.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi
                label="Decision P&L"
                value={formatUsd(s.totalDecisionPnl, { sign: true })}
                tone={signedTextClass(s.totalDecisionPnl)}
              />
              <Kpi label="Hit rate" value={pct(s.hitRatePct)} />
              <Kpi label="Good calls" value={String(s.goodCalls)} tone="[color:hsl(var(--positive))]" />
              <Kpi label="Too early" value={String(s.earlyCalls)} tone="[color:hsl(var(--negative))]" />
              <Kpi
                label="Best sell"
                value={s.bestDecisionPnl != null ? formatUsd(s.bestDecisionPnl, { sign: true }) : dash}
                tone={s.bestDecisionPnl != null ? signedTextClass(s.bestDecisionPnl) : undefined}
              />
              <Kpi
                label="Worst sell"
                value={s.worstDecisionPnl != null ? formatUsd(s.worstDecisionPnl, { sign: true }) : dash}
                tone={s.worstDecisionPnl != null ? signedTextClass(s.worstDecisionPnl) : undefined}
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Sold</th>
                    <th className="pb-2 px-2 text-right font-medium">Sell px</th>
                    <th className="pb-2 px-2 text-right font-medium">Now</th>
                    <th className="pb-2 px-2 text-right font-medium">Decision P&L</th>
                    <th className="pb-2 px-2 text-right font-medium">%</th>
                    <th className="pb-2 px-2 font-medium">Verdict</th>
                    <th className="pb-2 px-2 font-medium">Since sale</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sells.map((sell) => {
                    const v = VERDICT[sell.verdict];
                    return (
                      <tr key={sell.id} className="border-t border-border/50 align-middle">
                        <td className="py-1.5 pr-3">
                          <span className="font-mono-nums font-semibold">{sell.ticker}</span>
                          <Badge variant={sell.kind === "trim" ? "warning" : "neutral"} className="ml-2 text-[10px]">
                            {sell.kind === "trim" ? "trim" : "sell"}
                          </Badge>
                          <span className="ml-2 text-xs text-muted-foreground">{sell.sellDate}</span>
                        </td>
                        <td className="px-2 text-right font-mono-nums">{formatUsd(sell.sellPrice)}</td>
                        <td className="px-2 text-right font-mono-nums">
                          {sell.currentPrice != null ? formatUsd(sell.currentPrice) : dash}
                        </td>
                        <td className={cn("px-2 text-right font-mono-nums", sell.decisionPnl != null && signedTextClass(sell.decisionPnl))}>
                          {sell.decisionPnl != null ? formatUsd(sell.decisionPnl, { sign: true }) : dash}
                        </td>
                        <td className={cn("px-2 text-right font-mono-nums", sell.decisionPnlPct != null && signedTextClass(sell.decisionPnlPct))}>
                          {pct(sell.decisionPnlPct, true)}
                        </td>
                        <td className="px-2">
                          <Badge variant={v.variant} className="text-[10px]">{v.label}</Badge>
                        </td>
                        <td className="px-2">
                          <Sparkline series={sell.series} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Decision P&amp;L = shares sold &times; (sell price &minus; current
            price). Positive = a good sell (price fell after you sold); negative
            = sold too early (price rose). Hit rate = good calls &divide; (good +
            too-early). Verdict is as-of-now and moves with the market; sells
            without a live price ({s.totalSells - s.pricedSells} of {s.totalSells})
            are listed but excluded from the aggregate. Daily closes only; fees,
            taxes and redeploying the proceeds are ignored.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}
