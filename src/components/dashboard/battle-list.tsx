"use client";

import * as React from "react";
import {
  Swords,
  TrendingUp,
  TrendingDown,
  Flame,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * [scanner] "Today's Battle List" — pre-market gap + opening-range scanner.
 * Self-fetches /api/scanner; degrades quietly when Mboum/data is missing.
 * Purely informational — a deterministic ranking that blends gap/RVOL with the
 * app's own additive factor / insider signals. Not a trade trigger.
 */

type Direction = "up" | "down";

type OpeningRange = {
  high: number;
  low: number;
  position: "above" | "inside" | "below";
  interval: string;
};

type Candidate = {
  ticker: string;
  companyName: string;
  sector: string;
  direction: Direction;
  lists: string[];
  price: number | null;
  priorClose: number | null;
  gapPct: number | null;
  gapAtr: number | null;
  rvol: number | null;
  dollarVol: number | null;
  openingRange: OpeningRange | null;
  rsPercentile: number | null;
  factorComposite: number | null;
  insiderSignal: "cluster_buy" | "notable_buy" | "selling" | "none" | null;
  catalyst: string | null;
  battleScore: number;
  reasons: string[];
};

type ScannerResponse = {
  candidates: Candidate[];
  session: "pre" | "regular" | "post" | "closed";
  asOf: string;
  thresholds: {
    minGapPct: number;
    minDollarVol: number;
    atrDays: number;
    topN: number;
  };
  source: "mboum" | "none";
};

function compactUsd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `$${(a / 1_000_000_000).toFixed(1)}B`;
  if (a >= 1_000_000) return `$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${Math.round(a / 1_000)}K`;
  return `$${Math.round(a)}`;
}

const SESSION_LABEL: Record<ScannerResponse["session"], string> = {
  pre: "Pre-Market",
  regular: "Market Open",
  post: "After Hours",
  closed: "Closed",
};

export function BattleList({
  onSelect,
}: {
  onSelect?: (ticker: string) => void;
}) {
  const [data, setData] = React.useState<ScannerResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/scanner", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Swords className="h-4 w-4 text-muted-foreground" />
          Today&apos;s Battle List
          {data && data.source !== "none" ? (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {SESSION_LABEL[data.session]}
            </Badge>
          ) : null}
          <span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
            gap scanner
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed || data?.source === "none" ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Scanner data unavailable (Mboum not configured).
          </p>
        ) : !data ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : data.candidates.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No names clearing the {data.thresholds.minGapPct}% gap filter right now.
          </p>
        ) : (
          <div className="space-y-1.5">
            {data.candidates.map((c, i) => (
              <BattleRow key={c.ticker} c={c} rank={i + 1} onSelect={onSelect} />
            ))}
          </div>
        )}

        {data && data.source !== "none" ? (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            Ranked by a blended &quot;battle score&quot;: gap size + gap-vs-ATR +
            relative volume, confirmed by the app&apos;s own factor / relative-strength
            rank and insider cluster-buy overlay. Gap filter at least{" "}
            {data.thresholds.minGapPct}% vs prior close. General information, not advice.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BattleRow({
  c,
  rank,
  onSelect,
}: {
  c: Candidate;
  rank: number;
  onSelect?: (ticker: string) => void;
}) {
  const up = c.direction === "up";
  const Dir = up ? ArrowUpRight : ArrowDownRight;
  const insiderBuy =
    c.insiderSignal === "cluster_buy" || c.insiderSignal === "notable_buy";

  return (
    <button
      type="button"
      onClick={() => onSelect?.(c.ticker)}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg bg-muted/40 px-3 py-2 text-left text-xs transition-colors",
        onSelect ? "hover:bg-muted/70" : "cursor-default"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="w-4 shrink-0 text-center font-mono-nums text-[10px] text-muted-foreground">
          {rank}
        </span>
        <span className="font-mono-nums font-semibold">{c.ticker}</span>
        <Badge variant={up ? "positive" : "negative"}>
          <Dir className="mr-0.5 h-3 w-3" />
          {c.gapPct != null
            ? `${c.gapPct >= 0 ? "+" : ""}${c.gapPct.toFixed(1)}%`
            : "—"}
        </Badge>
        {c.rvol != null && c.rvol >= 1.5 ? (
          <Badge variant="warning">
            <Flame className="mr-0.5 h-3 w-3" />
            {c.rvol.toFixed(1)}x
          </Badge>
        ) : null}
        {insiderBuy ? (
          <Badge variant="positive">
            <TrendingUp className="mr-0.5 h-3 w-3" />
            insider
          </Badge>
        ) : c.insiderSignal === "selling" ? (
          <Badge variant="warning">
            <TrendingDown className="mr-0.5 h-3 w-3" />
            insider sell
          </Badge>
        ) : null}
        <span className="ml-auto font-mono-nums font-semibold">
          {Math.round(c.battleScore)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-[11px] text-muted-foreground">
        <span className="truncate">{c.companyName || c.sector}</span>
        {c.gapAtr != null ? <span>· {c.gapAtr.toFixed(1)} ATR</span> : null}
        {c.dollarVol != null ? <span>· {compactUsd(c.dollarVol)} vol</span> : null}
        {c.factorComposite != null ? (
          <span>· factor {c.factorComposite}</span>
        ) : null}
        {c.rsPercentile != null ? (
          <span>· RS {Math.round(c.rsPercentile)}pct</span>
        ) : null}
        {c.openingRange ? <span>· OR {c.openingRange.position}</span> : null}
      </div>
      {c.catalyst ? (
        <div className="pl-6 text-[11px] italic text-muted-foreground">
          &ldquo;{c.catalyst}&rdquo;
        </div>
      ) : null}
    </button>
  );
}
