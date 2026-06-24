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
import { fetchIntraday } from "@/lib/client";
import type { IntradaySeries } from "@/lib/intraday-chart";

/**
 * [chart] Per-stock INTRADAY 1D live chart (Google-Finance-style "1D" view).
 *
 * Mobile-first: renders cleanly at ~360px wide with no horizontal overflow.
 * - A dashed PREV-CLOSE reference line.
 * - Line/fill colour follows day direction (green above prev close, red below).
 * - Compact header (last price + %change) + tiny axis.
 * - Live: refetches on an interval and whenever `refreshKey` changes (the
 *   dashboard refresh button bumps it). Null-safe empty state on failure.
 */

const REFRESH_MS = 45_000;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Show in the user's locale; HH:mm is enough for a 1D view.
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

export function IntradayChart({
  symbol,
  height = 160,
  refreshKey = 0,
  className,
  compact = false,
}: {
  symbol: string;
  /** Plot height in px (header sits above it). */
  height?: number;
  /** Bump to force an immediate refetch (wire to the dashboard refresh). */
  refreshKey?: number;
  className?: string;
  /** Smaller header/axis for inline card placement. */
  compact?: boolean;
}) {
  const id = React.useId();
  const [series, setSeries] = React.useState<IntradaySeries | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    setLoading(true);

    const run = async () => {
      try {
        const data = await fetchIntraday(symbol);
        if (active) setSeries(data);
      } catch {
        if (active) setSeries(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    const timer = setInterval(() => void run(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [symbol, refreshKey]);

  const up =
    series?.change != null ? series.change >= 0 : true;
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

  // Y domain padded around prevClose so the reference line is always visible.
  const domain = React.useMemo<[number, number] | undefined>(() => {
    if (!hasData) return undefined;
    const prices = chartData.map((d) => d.price);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    if (series?.prevClose != null) {
      min = Math.min(min, series.prevClose);
      max = Math.max(max, series.prevClose);
    }
    const pad = (max - min || max || 1) * 0.04;
    return [min - pad, max + pad];
  }, [chartData, hasData, series]);

  return (
    <div className={cn("w-full", className)}>
      <Header series={series} loading={loading} up={up} compact={compact} />

      {loading && !series ? (
        <Skeleton className="w-full" style={{ height }} />
      ) : !hasData ? (
        <EmptyState height={height} />
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
              {series?.prevClose != null && (
                <ReferenceLine
                  y={series.prevClose}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  ifOverflow="extendDomain"
                />
              )}
              <XAxis
                dataKey="time"
                tickFormatter={fmtTime}
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
                labelFormatter={(l) => fmtTime(String(l))}
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

function Header({
  series,
  loading,
  up,
  compact,
}: {
  series: IntradaySeries | null;
  loading: boolean;
  up: boolean;
  compact: boolean;
}) {
  const last = series?.last;
  const changePct = series?.changePct;
  const change = series?.change;
  const tone = up ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]";

  return (
    <div className="mb-1.5 flex items-end justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            1D
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
            {formatPct(Math.abs(changePct))}) vs prev close
          </p>
        ) : (
          <p className="text-[11px] leading-tight text-muted-foreground">
            vs previous close
          </p>
        )}
      </div>
      {series?.prevClose != null ? (
        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
          prev {formatUsd(series.prevClose)}
        </span>
      ) : null}
    </div>
  );
}

function EmptyState({ height }: { height: number }) {
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center"
      style={{ height }}
    >
      <p className="text-xs font-medium">Intraday chart unavailable</p>
      <p className="max-w-[15rem] px-2 text-[11px] text-muted-foreground">
        No live intraday data for this ticker right now. Quotes and scoring
        continue to work.
      </p>
    </div>
  );
}
