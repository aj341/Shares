"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatPct, formatUsd } from "@/lib/utils";
import { scoreBadgeClass } from "@/lib/ui";
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
    title: "Pullback Entry (timing)",
    tone: "[color:hsl(var(--positive))]",
    chip: "bg-positive-muted [color:hsl(var(--positive))]",
  },
  momentum: {
    title: "Buy on Strength (momentum)",
    tone: "[color:hsl(var(--brand))]",
    chip: "bg-brand-muted [color:hsl(var(--brand))]",
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
  onSelect,
}: {
  data: WatchlistResponse | null;
  loading: boolean;
  /** Open the full research drawer (metrics/announcements/verdict) for a ticker. */
  onSelect?: (ticker: string) => void;
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

  const buckets: WatchlistBucket[] = ["best_entry", "momentum", "neutral", "overbought"];
  const byBucket = (b: WatchlistBucket) =>
    data.items.filter((i) => i.bucket === b).map((i) => i.ticker);

  // [wlfilter] Full ranked set (every scanned, non-held name); falls back to the
  // curated suggestions when the scan hasn't populated it.
  const allItems = data.all?.length ? data.all : data.items;

  // [wlfilter] Sector list built from the full set via sectorFor() (already on
  // item.sector). "All" first, then sectors by descending name count.
  const sectorCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const it of allItems) m.set(it.sector, (m.get(it.sector) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [allItems]);

  const ALL = "All";
  const [sector, setSector] = React.useState<string>(ALL);
  // If a previously selected sector disappears (data refresh), snap back to All.
  React.useEffect(() => {
    if (sector !== ALL && !sectorCounts.some(([name]) => name === sector)) {
      setSector(ALL);
    }
  }, [sector, sectorCounts]);

  // [wlfilter] Sector view: that sector's names from the FULL set, ranked by
  // engine score desc (nulls last) — ALL of them, not the 8 suggestions.
  const sectorItems = React.useMemo(() => {
    if (sector === ALL) return [];
    return allItems
      .filter((i) => i.sector === sector)
      .slice()
      .sort((a, b) => (b.engineScore ?? -1) - (a.engineScore ?? -1));
  }, [sector, allItems]);

  const showingSuggestions = sector === ALL;
  const rows = showingSuggestions ? data.items : sectorItems;

  return (
    <div className="space-y-4">
      {/* Header summary */}
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div>
            <h2 className="text-base font-semibold">Watchlist — Suggested Additions</h2>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Screened Nasdaq names. Buckets show entry TIMING — pullback,
              buy-on-strength (uptrend + BUY-rated), neutral or overbought; the
              Score shows QUALITY on the same 20-metric engine as your holdings
              — 70+ competes for capital. Not financial advice.
            </p>
          </div>
          <div className="flex gap-6 text-right">
            <Summary
              label={showingSuggestions ? "Suggestions" : "In Sector"}
              value={String(showingSuggestions ? data.suggestionsCount : sectorItems.length)}
              className="[color:hsl(var(--brand))]"
            />
            <Summary
              label="Avg Upside"
              value={data.avgUpsidePct != null ? formatPct(data.avgUpsidePct, { sign: true }) : "—"}
              className="[color:hsl(var(--positive))]"
            />
            <Summary label="Universe" value={String(allItems.length)} className="[color:hsl(var(--warning))]" />
          </div>
        </CardContent>
      </Card>

      {/* [wlfilter] Industry / sector filter — mobile-first horizontally
          scrollable pill strip. No wrap, no overflow at ~360px. */}
      <div
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Filter watchlist by sector"
      >
        <SectorPill
          label="All"
          count={data.suggestionsCount}
          active={sector === ALL}
          onClick={() => setSector(ALL)}
        />
        {sectorCounts.map(([name, count]) => (
          <SectorPill
            key={name}
            label={name}
            count={count}
            active={sector === name}
            onClick={() => setSector(name)}
          />
        ))}
      </div>

      {showingSuggestions ? (
        /* Bucket strip (suggestions view only) */
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
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
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{sector}</span> — all{" "}
          {sectorItems.length} screened name{sectorItems.length === 1 ? "" : "s"}, ranked by
          engine score.
        </p>
      )}

      {/* Rows */}
      <div className="space-y-2">
        {rows.length ? (
          rows.map((it) => (
            <WatchRow key={it.ticker} item={it} onSelect={onSelect} />
          ))
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No screened names in {sector} yet.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// [wlfilter] Scrollable sector filter pill (mobile-first, fixed height, no shrink).
function SectorPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-brand-muted [color:hsl(var(--brand))]"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {label}
      <span className="ml-1.5 font-mono-nums opacity-60">{count}</span>
    </button>
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

function WatchRow({
  item,
  onSelect,
}: {
  item: WatchlistItem;
  onSelect?: (ticker: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const meta = BUCKET_META[item.bucket];

  const openResearch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onSelect || busy) return;
    setBusy(true);
    // The shell opens the drawer when the analysis is ready; clear the
    // spinner shortly after either way.
    Promise.resolve(onSelect(item.ticker)).finally(() =>
      setTimeout(() => setBusy(false), 400)
    );
  };

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              role={onSelect ? "button" : undefined}
              onClick={onSelect ? openResearch : undefined}
              className={cn(
                "font-mono-nums font-bold",
                onSelect && "cursor-pointer underline-offset-4 hover:underline"
              )}
              title={onSelect ? "Open full analysis" : undefined}
            >
              {item.ticker}
              {busy && <span className="ml-1 animate-pulse text-xs text-muted-foreground">…</span>}
            </span>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {item.companyName}
            </span>
          </div>
          <p className="truncate text-xs [color:hsl(var(--brand))]">
            {item.subSectors.join(" / ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <Stat
            label="Score"
            value={item.engineScore != null ? `${item.engineScore}` : "—"}
            className={
              item.engineScore != null && item.engineScore >= 70
                ? "[color:hsl(var(--positive))]"
                : item.engineScore != null && item.engineScore < 55
                ? "[color:hsl(var(--negative))]"
                : "[color:hsl(var(--warning))]"
            }
          />
          <Stat label="Price" value={item.price != null ? formatUsd(item.price) : "—"} />
          <Stat
            label="Upside"
            value={item.upsidePct != null ? formatPct(item.upsidePct, { sign: true }) : "—"}
            className={item.upsidePct != null && item.upsidePct >= 0 ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]"}
          />
          <Stat label="RSI" value={item.rsi != null ? String(item.rsi) : "—"} className="[color:hsl(var(--warning))]" />
          <Stat label="Target" value={item.targetMean != null ? formatUsd(item.targetMean) : "—"} className="[color:hsl(var(--brand))]" />
          <span
            className={cn(
              "shrink-0 rounded-md px-2 py-1 text-sm font-bold leading-none font-mono-nums",
              scoreBadgeClass(item.engineScore)
            )}
            title="Quality score / 100 — 70+ competes for capital"
          >
            {item.engineScore != null ? item.engineScore : "—"}
            <span className="ml-0.5 text-[9px] font-normal opacity-70">/100</span>
          </span>
          <Badge variant="outline" className={cn(meta.tone, "hidden sm:inline-flex")}>{item.signalLabel}</Badge>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </div>
      </button>

      {open && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Detail label="Price" value={item.price != null ? formatUsd(item.price) : "—"} />
            <Detail label="P/E" value={item.peRatio != null ? item.peRatio.toFixed(1) : "—"} />
            <Detail label="Analyst Rating" value={item.analystRating ?? "—"} />
            <Detail label="Bullish %" value={item.bullishPct != null ? `${item.bullishPct}%` : "—"} />
            <Detail
              label="52-Week Range"
              value={
                item.week52Low != null && item.week52High != null
                  ? `${formatUsd(item.week52Low)}–${formatUsd(item.week52High)}`
                  : "—"
              }
            />
          </div>

          <Section title="Why it fits your portfolio" body={item.whyItFits} />
          <Section title="Bull Case" body={item.bullCase} titleClass="[color:hsl(var(--positive))]" />
          <Section title="Key Risk" body={item.keyRisk} titleClass="[color:hsl(var(--negative))]" />
          <Section title="Technical Signal" body={item.technicalSignal} titleClass="[color:hsl(var(--brand))]" />

          {onSelect && (
            <button
              type="button"
              onClick={openResearch}
              disabled={busy}
              className="w-full rounded-lg border border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {busy ? "Building full analysis…" : "Open full analysis (metrics · news · verdict) →"}
            </button>
          )}

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
