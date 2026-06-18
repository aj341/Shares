"use client";

import * as React from "react";
import { Users, TrendingUp, TrendingDown, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type InsiderSignal = "cluster_buy" | "notable_buy" | "selling" | "none";

type Overlay = {
  signal: InsiderSignal;
  buyerCount: number;
  netDollar: number;
  lastDate: string | null;
};

type InsiderResponse = {
  byTicker: Record<string, Overlay>;
  clusterBuys: string[];
  thresholds: {
    clusterWindowDays: number;
    minTxnUsd: number;
    clusterMinBuyers: number;
  };
  source: "mboum" | "none";
};

const LABEL: Record<InsiderSignal, string> = {
  cluster_buy: "Cluster buy",
  notable_buy: "Notable buy",
  selling: "Selling",
  none: "—",
};

function compactUsd(n: number): string {
  const sign = n < 0 ? "-" : "+";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${Math.round(a / 1_000)}K`;
  return `${sign}$${a}`;
}

/**
 * [insider] Compact insider cluster-buy overlay (SLOW fundamental signal).
 * Self-fetches /api/insider; degrades quietly when Mboum/data is missing.
 * Purely informational — never a frequent trade trigger.
 */
export function InsiderPanel() {
  const [data, setData] = React.useState<InsiderResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/insider", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const rows = React.useMemo(() => {
    if (!data) return [];
    const order: Record<InsiderSignal, number> = {
      cluster_buy: 0,
      notable_buy: 1,
      selling: 2,
      none: 3,
    };
    return Object.entries(data.byTicker)
      .filter(([, o]) => o.signal !== "none")
      .sort((a, b) => {
        const r = order[a[1].signal] - order[b[1].signal];
        return r !== 0 ? r : b[1].netDollar - a[1].netDollar;
      });
  }, [data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4 text-muted-foreground" />
          Insider Activity
          <span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
            slow overlay
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed || data?.source === "none" ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Insider data unavailable.
          </p>
        ) : !data ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No notable open-market insider activity.
          </p>
        ) : (
          <div className="space-y-1.5">
            {rows.map(([ticker, o]) => (
              <InsiderRow key={ticker} ticker={ticker} o={o} />
            ))}
          </div>
        )}

        {data && data.source !== "none" ? (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            Open-market buys only — 10b5-1 / automatic sells, option exercises and
            grants are excluded. Cluster = {data.thresholds.clusterMinBuyers}+ distinct
            buyers within {data.thresholds.clusterWindowDays}d (or a large CEO/CFO buy);
            txns under ${Math.round(data.thresholds.minTxnUsd / 1000)}K ignored.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InsiderRow({ ticker, o }: { ticker: string; o: Overlay }) {
  const positive = o.signal === "cluster_buy" || o.signal === "notable_buy";
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono-nums font-semibold">{ticker}</span>
        <Badge variant={o.signal === "cluster_buy" ? "positive" : positive ? "secondary" : "warning"}>
          <Icon className="mr-1 h-3 w-3" />
          {LABEL[o.signal]}
        </Badge>
        {o.buyerCount > 0 ? (
          <span className="hidden text-muted-foreground sm:inline">
            {o.buyerCount} buyer{o.buyerCount > 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={cn(
            "font-mono-nums",
            o.netDollar >= 0
              ? "[color:hsl(var(--positive))]"
              : "[color:hsl(var(--negative))]"
          )}
        >
          {compactUsd(o.netDollar)}
        </span>
        {o.lastDate ? (
          <span className="hidden items-center gap-1 text-muted-foreground sm:flex">
            <Clock className="h-3 w-3" />
            {o.lastDate.slice(5)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
