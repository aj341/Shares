"use client";

import * as React from "react";
import { Sparkles, ArrowDownRight, ArrowUpRight, Eye, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fetchTopMoves } from "@/lib/client";
import type { TopMove, TopMovesResponse, TopMoveAction } from "@/lib/top-moves";

const ACTION_META: Record<
  TopMoveAction,
  { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  ADD: { label: "Add", cls: "bg-positive-muted [color:hsl(var(--positive))]", Icon: ArrowUpRight },
  TRIM: { label: "Trim", cls: "bg-warning-muted [color:hsl(var(--warning))]", Icon: ArrowDownRight },
  SELL: { label: "Sell", cls: "bg-negative-muted [color:hsl(var(--negative))]", Icon: XCircle },
  WATCH: { label: "Watch", cls: "bg-muted text-muted-foreground", Icon: Eye },
};

export function TopMovesCard({ onSelect }: { onSelect?: (ticker: string) => void }) {
  const [data, setData] = React.useState<TopMovesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    fetchTopMoves()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!data || !data.hasData || data.moves.length === 0) return null;

  return (
    <Card className="overflow-hidden border-brand/30">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 [color:hsl(var(--brand))]" />
            Top 3 Moves Today
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Ranked from the app&apos;s own signals; AI writes the reasoning.
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 gap-1 text-[11px]">
          {data.source === "llm" ? "AI" : "auto"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.moves.map((m) => (
          <MoveRow key={`${m.ticker}-${m.rank}`} move={m} onSelect={onSelect} />
        ))}
        <p className="border-t pt-3 text-[11px] text-muted-foreground">{data.disclaimer}</p>
      </CardContent>
    </Card>
  );
}

function MoveRow({ move, onSelect }: { move: TopMove; onSelect?: (ticker: string) => void }) {
  const meta = ACTION_META[move.action];
  const { Icon } = meta;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 p-3">
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
          meta.cls
        )}
        aria-hidden
      >
        {move.rank}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={cn("gap-1", meta.cls)}>
            <Icon className="h-3 w-3" />
            {meta.label}
          </Badge>
          <button
            type="button"
            onClick={() => onSelect?.(move.ticker)}
            className="font-mono-nums text-sm font-semibold hover:underline"
          >
            {move.ticker}
          </button>
          <span className="truncate text-xs text-muted-foreground">{move.companyName}</span>
        </div>
        <p className="text-sm">{move.rationale}</p>
        {move.whyNow ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold uppercase tracking-wide">Why now:</span> {move.whyNow}
          </p>
        ) : null}
      </div>
    </div>
  );
}
