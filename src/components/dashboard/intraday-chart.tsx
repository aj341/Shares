"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatPct, formatUsd } from "@/lib/utils";
// [chartframes] multi-timeframe fetcher replaces the 1D-only fetcher.
import { fetchChart } from "@/lib/client";
import type { ChartSeries, ChartRange } from "@/lib/chart-series";

/**
 * [chart] Per-stock live chart (Google-Finance-style).
 *
 * [chartframes] Now multi-timeframe: a horizontally-scrollable pill row of
 * timeframes (1D · 5D · 1M · 6M · YTD · 1Y · 5Y · Max) sits above the plot.
 * Selecting a pill refetches the matching series and re-renders. The default
 * is 1D, which keeps its original LIVE refresh behaviour (it polls on an
 * interval and on `refreshKey` bumps); longer ranges are static snapshots
 * (cached server-side) and only refetch when re-selected or `refreshKey` bumps.
 *
 * Mobile-first: renders cleanly at ~360px wide with no horizontal overflow.
 * - A dashed REFERENCE line (prev close for 1D; period-start for longer ranges).
 * - Line/fill colour follows the period direction (green up, red down).
 * - Compact header (last price + %change over the selected range) + tiny axis.
 * - Null-safe empty state on failure / when a range has no data.
 */

const REFRESH_MS = 45_000;

// [chartframes] the pill row, in display order. "MAX" renders as "Max".
const RANGE_OPTIONS: { value: ChartRange; label: string }[] = [
  { value: "1D", label: "1D" },
  { value: "5D", label: "5D" },
  { value: "1M", label: "1M" },
  { value: "6M", label: "6M" },
  { value: "YTD", label: "YTD" },
  { value: "1Y", label: "1Y" },
  { value: "5Y", label: "5Y" },
  { value: "MAX", label: "Max" },
];

// [chartframes] format the x-axis tick to suit the selected range's resolution.
function makeTickFormatter(range: ChartRange): (iso: string) => string {
  return (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    if (range === "1D") {
      return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
    }
    if (range === "5D") {
      return d.toLocaleDateString("en-AU", { weekday: "short" });
    }
    if (range === "5Y" || range === "MAX") {
      return d.toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
    }
    // 1M / 6M / YTD / 1Y -> day + month.
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  };
}

// [chartframes] tooltip label formatter (includes the date for non-1D ranges).
function makeLabelFormatter(range: ChartRange): (iso: string) => string {
  return (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    if (range === "1D") {
      return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
    }
    if (range === "5D") {
      return d.toLocaleString("en-AU", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };
}

export function IntradayChart({
  symbol,
  height = 160,
  refreshKey = 0,
  className,
  compact = false,
}: {
  symbol: string;
  /** Plot height in px (header + pills sit above it). */
  height?: number;
  /** Bump to force an immediate refetch (wire to the dashboard refresh). */
  refreshKey?: number;
  className?: string;
  /** Smaller header/axis for inline card placement. */
  compact?: boolean;
}) {
  const id = React.useId();
  // [chartframes] selected timeframe; defaults to 1D.
  const [range, setRange] = React.useState<ChartRange>("1D");
  const [series, setSeries] = React.useState<ChartSeries | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Reset the cached series whenever the symbol changes so we never flash a
  // previous ticker's data into a new card.
  React.useEffect(() => {
    setSeries(null);
  }, [symbol]);

  React.useEffect(() => {
    let active = true;
    setLoading(true);

    const run = async () => {
      try {
        const data = await fetchChart(symbol, range);
        if (active) setSeries(data);
      } catch {
        if (active) setSeries(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    // [chartframes] keep the LIVE poll for 1D only; longer ranges are snapshots.
    const timer =
      range === "1D" ? setInterval(() => void run(), REFRESH_MS) : null;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [symbol, range, refreshKey]);

  const up = series?.change != null ? series.change >= 0 : true;
  const colour = up ? "hsl(var(--positive))" : "hsl(var(--negative))";

  const chartData = React.useMemo(
    () =>
      (series?.points ?? []).map((p) => ({
        time: p.time,
        price: p.price,
      })),
    [series]
  );

  const hasData = !!series?.hasData && chartData.length >= 2;

  const tickFormatter = React.useMemo(() => makeTickFormatter(range), [range]);
  const labelFormatter = React.useMemo(() => makeLabelFormatter(range), [range]);

  // Y domain padded around the reference price so the dashed line is visible.
  const domain = React.useMemo<[number, number] | undefined>(() => {
    if (!hasData) return undefined;
    const prices = chartData.map((d) => d.price);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    if (series?.reference != null) {
      min = Math.min(min, series.reference);
      max = Math.max(max, series.reference);
    }
    const pad = (max - min || max || 1) * 0.04;
    return [min - pad, max + pad];
  }, [chartData, hasData, series]);

  return (
    <div className={cn("w-full", className)}>
      <Header series={series} loading={loading} up={up} compact={compact} range={range} />

      {/* [chartframes] horizontally-scrollable timeframe pill row (mobile-first). */}
      <RangePills range={range} onChange={setRange} />

      {loading && !series ? (
        <Skeleton className="w-full" style={{ height }} />
      ) : !hasData ? (
        <EmptyState height={height} range={range} />
      ) : (
        <div className="w-full" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id={`intraday-${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colour} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={colour} stopOpacity={0} />
                </linearGradient>
              </defs>
              {series?.reference != null && (
                <ReferenceLine
                  y={series.reference}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  ifOverflow="extendDomain"
                />
              )}
              <XAxis
                dataKey="time"
                tickFormatter={tickFormatter}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                minTickGap={compact ? 56 : 44}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                orientation="right"
                domain={domain ?? ["auto", "auto"]}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                width={44}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatUsd(v)}
              />
              <Tooltip
                labelFormatter={(l) => labelFormatter(String(l))}
                formatter={(value: number) => [formatUsd(value), "Price"]}
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                  color: "hsl(var(--popover-foreground))",
                  padding: "4px 8px",
                }}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke={colour}
                strokeWidth={1.75}
                fill={`url(#intraday-${id})`}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// [chartframes] compact, horizontally-scrollable pill row of timeframes.
function RangePills({
  range,
  onChange,
}: {
  range: ChartRange;
  onChange: (r: ChartRange) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Chart timeframe"
      className="-mx-0.5 mb-2 flex gap-1 overflow-x-auto scrollbar-none [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    >
      {RANGE_OPTIONS.map((opt) => {
        const active = opt.value === range;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Header({
  series,
  loading,
  up,
  compact,
  range,
}: {
  series: ChartSeries | null;
  loading: boolean;
  up: boolean;
  compact: boolean;
  range: ChartRange;
}) {
  const last = series?.last;
  const changePct = series?.changePct;
  const change = series?.change;
  const tone = up ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]";
  // [chartframes] label the comparison baseline by range.
  const baseline = range === "1D" ? "vs prev close" : `over ${rangeLabel(range)}`;

  return (
    <div className="mb-1.5 flex items-end justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {rangeLabel(range)}
          </span>
          {last != null ? (
            <span
              className={cn(
                "font-mono-nums font-bold leading-none",
                compact ? "text-base" : "text-lg"
              )}
            >
              {formatUsd(last)}
            </span>
          ) : loading ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </div>
        {changePct != null && change != null ? (
          <p className={cn("font-mono-nums text-xs leading-tight", tone)}>
            {up ? "▲" : "▼"} {formatUsd(Math.abs(change))} (
            {formatPct(Math.abs(changePct))}) {baseline}
          </p>
        ) : (
          <p className="text-[11px] leading-tight text-muted-foreground">
            {baseline}
          </p>
        )}
      </div>
      {series?.reference != null ? (
        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
          {range === "1D" ? "prev" : "start"} {formatUsd(series.reference)}
        </span>
      ) : null}
    </div>
  );
}

// [chartframes] human label for a range value ("MAX" -> "Max").
function rangeLabel(range: ChartRange): string {
  return range === "MAX" ? "Max" : range;
}

function EmptyState({ height, range }: { height: number; range: ChartRange }) {
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center"
      style={{ height }}
    >
      <p className="text-xs font-medium">No {rangeLabel(range)} data</p>
      <p className="max-w-[15rem] px-2 text-[11px] text-muted-foreground">
        No price history for this ticker over the selected range right now.
        Quotes and scoring continue to work.
      </p>
    </div>
  );
}
