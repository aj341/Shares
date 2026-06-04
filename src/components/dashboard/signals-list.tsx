"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency, formatPct } from "@/lib/utils";
import { groupBySignal } from "@/lib/insights";
import { signalToVariant } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { DisagreementRow, Holding } from "@/lib/types";

export function SignalsList({
  holdings,
  disagreement,
  onSelect,
}: {
  holdings: Holding[];
  disagreement: DisagreementRow[];
  onSelect: (ticker: string) => void;
}) {
  const { buy, hold, trimSell } = groupBySignal(holdings);
  const upsideByTicker = new Map(
    disagreement.map((d) => [d.ticker, d.analystTargetUpsidePct])
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Today’s Signals</CardTitle>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="[color:hsl(var(--positive))]">{buy.length} BUY</span>
          <span>{hold.length} HOLD</span>
          <span className="[color:hsl(var(--negative))]">{trimSell.length} TRIM/SELL</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Group title="Buy" icon={<ArrowUpRight className="h-3.5 w-3.5" />} tone="positive" items={buy} upside={upsideByTicker} onSelect={onSelect} />
        <Group title="Hold" icon={<Minus className="h-3.5 w-3.5" />} tone="neutral" items={hold} upside={upsideByTicker} onSelect={onSelect} />
        <Group title="Trim / Sell" icon={<ArrowDownRight className="h-3.5 w-3.5" />} tone="negative" items={trimSell} upside={upsideByTicker} onSelect={onSelect} />
      </CardContent>
    </Card>
  );
}

function Group({
  title,
  icon,
  tone,
  items,
  upside,
  onSelect,
}: {
  title: string;
  icon: React.ReactNode;
  tone: "positive" | "neutral" | "negative";
  items: Holding[];
  upside: Map<string, number | null>;
  onSelect: (ticker: string) => void;
}) {
  if (items.length === 0) return null;
  const toneText =
    tone === "positive"
      ? "[color:hsl(var(--positive))]"
      : tone === "negative"
        ? "[color:hsl(var(--negative))]"
        : "text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <div className={cn("flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide", toneText)}>
        {icon}
        {title} ({items.length})
      </div>
      <ul className="space-y-1">
        {items.map((h) => {
          const up = upside.get(h.ticker);
          return (
            <li key={h.ticker}>
              <button
                type="button"
                onClick={() => onSelect(h.ticker)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted/50",
                  tone === "positive" && "bg-positive-muted/40",
                  tone === "negative" && "bg-negative-muted/40"
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-nums text-sm font-semibold">{h.ticker}</span>
                    <Badge variant={signalToVariant(h.signal)} className="text-[10px]">
                      {STATUS_LABELS[h.signal]}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{h.companyName}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono-nums text-sm font-medium">
                    {formatCurrency(h.currentPrice)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {up === null || up === undefined ? (
                      `score ${h.score}`
                    ) : (
                      <span className={up >= 0 ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]"}>
                        {formatPct(up, { sign: true })} to target
                      </span>
                    )}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
