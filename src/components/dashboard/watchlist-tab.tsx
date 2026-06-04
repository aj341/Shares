"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCurrency, formatPct } from "@/lib/utils";
import type {
  WatchlistBucket,
  WatchlistItem,
  WatchlistResponse,
} from "@/lib/types";

const BUCKET_META: Record<
  WatchlistBucket,
  { title: string; tone: string; chip: string }
> = {
  best_entry: {
    title: "Best Entry Now",
    tone: "[color:hsl(var(--positive))]",
    chip: "bg-positive-muted [color:hsl(var(--positive))]",
  },
  neutral: {
    title: "Neutral / Wait",
    tone: "[color:hsl(var(--warning))]",
    chip: "bg-warning-muted [color:hsl(var(--warning))]",
  },
  overbought: {
    title: "Overbought / Patience",
    tone: "[color:hsl(var(--negative))]",
    chip: "bg-negative-muted [color:hsl(var(--negative))]",
  },
};

export function WatchlistTab({
  data,
  loading,
}: {
  data: WatchlistResponse | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!data || !data.items.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Watchlist unavailable — set <code>MBOUM_API_KEY</code> to load live
          candidate metrics.
        </CardContent>
      </Card>
    );
  }

  const buckets: WatchlistBucket[] = ["best_entry", "neutral", "overbought"];
  const byBucket = (b: WatchlistBucket) =>
    data.items.filter((i) => i.bucket === b).map((i) => i.ticker);

  return (
    <div className="space-y-4">
      {/* Header summary */}
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div>
            <h2 className="text-base font-semibold">Watchlist — Suggested Additions</h2>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              High-conviction AI/tech names to complement the portfolio, ranked by
              entry quality (RSI signal). Not financial advice.
            </p>
          </div>
          <div className="flex gap-6 text-right">
            <Summary label="Suggestions" value={String(data.suggestionsCount)} className="[color:hsl(var(--brand))]" />
            <Summary
              label="Avg Upside"
              value={data.avgUpsidePct != null ? formatPct(data.avgUpsidePct, { sign: true }) : "—"}
              className="[color:hsl(var(--positive))]"
            />
            <Summary label="Best Entry" value={data.bestEntry[0] ?? "—"} className="[color:hsl(var(--warning))]" />
          </div>
        </CardContent>
      </Card>

      {/* Bucket strip */}
      <div className="grid gap-3 sm:grid-cols-3">
        {buckets.map((b) => (
          <div
            key={b}
            className={cn("rounded-lg border border-border p-3", BUCKET_META[b].chip.split(" ")[0] + "/40")}
          >
            <p className={cn("text-xs font-semibold uppercase tracking-wide", BUCKET_META[b].tone)}>
              {BUCKET_META[b].title}
            </p>
            <p className="mt-1 font-mono-nums text-sm">
              {byBucket(b).join(" ") || "—"}
            </p>
          </div>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {data.items.map((it) => (
          <WatchRow key={it.ticker} item={it} />
        ))}
      </div>
    </div>
  );
}

function Summary({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <p className={cn("font-mono-nums text-lg font-bold", className)}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function WatchRow({ item }: { item: WatchlistItem }) {
  const [open, setOpen] = React.useState(false);
  const meta = BUCKET_META[item.bucket];

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono-nums font-bold">{item.ticker}</span>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {item.companyName}
            </span>
          </div>
          <p className="truncate text-xs [color:hsl(var(--brand))]">
            {item.subSectors.join(" / ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <Stat label="Price" value={item.price != null ? formatCurrency(item.price) : "—"} />
          <Stat
            label="Upside"
            value={item.upsidePct != null ? formatPct(item.upsidePct, { sign: true }) : "—"}
            className={item.upsidePct != null && item.upsidePct >= 0 ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]"}
          />
          <Stat label="RSI" value={item.rsi != null ? String(item.rsi) : "—"} className="[color:hsl(var(--warning))]" />
          <Stat label="Target" value={item.targetMean != null ? formatCurrency(item.targetMean) : "—"} className="[color:hsl(var(--brand))]" />
          <Badge variant="outline" className={meta.tone}>{item.signalLabel}</Badge>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </div>
      </button>

      {open && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Detail label="Price" value={item.price != null ? formatCurrency(item.price) : "—"} />
            <Detail label="P/E" value={item.peRatio != null ? item.peRatio.toFixed(1) : "—"} />
            <Detail label="Analyst Rating" value={item.analystRating ?? "—"} />
            <Detail label="Bullish %" value={item.bullishPct != null ? `${item.bullishPct}%` : "—"} />
            <Detail
              label="52-Week Range"
              value={
                item.week52Low != null && item.week52High != null
                  ? `${formatCurrency(item.week52Low)}–${formatCurrency(item.week52High)}`
                  : "—"
              }
            />
          </div>

          <Section title="Why it fits your portfolio" body={item.whyItFits} />
          <Section title="Bull Case" body={item.bullCase} titleClass="[color:hsl(var(--positive))]" />
          <Section title="Key Risk" body={item.keyRisk} titleClass="[color:hsl(var(--negative))]" />
          <Section title="Technical Signal" body={item.technicalSignal} titleClass="[color:hsl(var(--brand))]" />

          {item.recentAnalystActions.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recent Analyst Actions
              </p>
              <div className="flex flex-wrap gap-1.5">
                {item.recentAnalystActions.map((a, i) => (
                  <Badge key={i} variant="secondary" className="text-[11px]">
                    {a.firm} {a.action}
                    {a.date ? ` (${a.date})` : ""}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="hidden text-right sm:block">
      <p className={cn("font-mono-nums text-sm font-semibold", className)}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono-nums text-sm font-semibold">{value}</p>
    </div>
  );
}

function Section({ title, body, titleClass }: { title: string; body: string; titleClass?: string }) {
  return (
    <div>
      <p className={cn("text-xs font-semibold uppercase tracking-wide text-muted-foreground", titleClass)}>
        {title}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
