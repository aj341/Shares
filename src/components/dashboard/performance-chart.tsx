"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCurrency } from "@/lib/utils";
import { fetchPerformance } from "@/lib/client";
import {
  DEFAULT_PERFORMANCE_RANGE,
  PERFORMANCE_RANGES,
  type PerformanceRangeKey,
} from "@/lib/constants";
import type { PerformanceResponse } from "@/lib/types";

const PALETTE = [
  "hsl(222 80% 62%)",
  "hsl(152 55% 50%)",
  "hsl(199 85% 55%)",
  "hsl(38 85% 58%)",
  "hsl(280 60% 65%)",
  "hsl(12 75% 60%)",
  "hsl(174 55% 48%)",
];

const INTRADAY: PerformanceRangeKey[] = ["1D"];
const LONG: PerformanceRangeKey[] = ["3Y", "5Y", "10Y"];

/** Date/time tick formatter that adapts to the selected range. */
function makeFormatter(range: PerformanceRangeKey) {
  const opts: Intl.DateTimeFormatOptions = INTRADAY.includes(range)
    ? { hour: "2-digit", minute: "2-digit" }
    : LONG.includes(range)
    ? { month: "short", year: "2-digit" }
    : { month: "short", day: "2-digit" };
  return (value: string): string => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString("en-AU", opts).replace(",", "");
  };
}

export function PerformanceChart({
  data,
  loading,
}: {
  data: PerformanceResponse | null;
  loading: boolean;
}) {
  const [range, setRange] = React.useState<PerformanceRangeKey>(
    DEFAULT_PERFORMANCE_RANGE
  );
  // Series for non-default ranges, fetched on demand. The default range uses
  // the `data` prop the shell already loaded (and which also feeds the KPIs).
  const [override, setOverride] = React.useState<PerformanceResponse | null>(null);
  const [rangeLoading, setRangeLoading] = React.useState(false);

  const selectRange = React.useCallback((key: PerformanceRangeKey) => {
    setRange(key);
    if (key === DEFAULT_PERFORMANCE_RANGE) {
      setOverride(null);
      return;
    }
    setRangeLoading(true);
    setOverride(null);
    fetchPerformance(key)
      .then((res) => setOverride(res))
      .catch(() => setOverride(null))
      .finally(() => setRangeLoading(false));
  }, []);

  // "%" (rebased return) is the default; "$" shows absolute AUD value.
  const [mode, setMode] = React.useState<"pct" | "value">("pct");

  const isDefault = range === DEFAULT_PERFORMANCE_RANGE;
  const active = isDefault ? data : override;
  const busy = isDefault ? loading : rangeLoading;
  const fmt = React.useMemo(() => makeFormatter(range), [range]);

  const isValue = mode === "value";
  const chartData = isValue ? active?.seriesValue ?? [] : active?.series ?? [];
  const yTick = (v: number) =>
    isValue ? formatCurrency(v, { compact: true }) : `${v > 0 ? "+" : ""}${v}%`;
  const tipValue = (value: number) =>
    isValue ? formatCurrency(value) : `${value > 0 ? "+" : ""}${value}%`;

  const title = active?.rangeLabel ?? "Performance";

  return (
    <Card className="h-full">
      <CardHeader className="space-y-2 pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            {title}
          </CardTitle>
          {active?.hasData ? (
            <span className="text-[11px] text-muted-foreground">
              {isValue ? "market value · A$" : "rebased · % return"} · via Mboum
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <RangeToggle value={range} onChange={selectRange} disabled={rangeLoading} />
          <ModeToggle value={mode} onChange={setMode} />
        </div>
      </CardHeader>
      <CardContent>
        {busy ? (
          <Skeleton className="h-[280px] w-full" />
        ) : !active?.hasData ? (
          <EmptyChart />
        ) : (
          <>
            <Legend tickers={active.tickers} />
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={fmt}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    minTickGap={48}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={yTick}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    width={isValue ? 60 : 48}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    labelFormatter={(l) => fmt(String(l))}
                    formatter={(value: number, name: string) => [tipValue(value), name]}
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                      fontSize: 12,
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  {active.tickers.map((t, i) => (
                    <Line
                      key={t}
                      type="monotone"
                      dataKey={t}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="Portfolio"
                    stroke="hsl(var(--foreground))"
                    strokeWidth={3}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RangeToggle({
  value,
  onChange,
  disabled,
}: {
  value: PerformanceRangeKey;
  onChange: (key: PerformanceRangeKey) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {PERFORMANCE_RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
          disabled={disabled}
          aria-pressed={value === r.key}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium font-mono-nums transition-colors",
            "disabled:opacity-50",
            value === r.key
              ? "bg-primary text-primary-foreground"
              : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function ModeToggle({
  value,
  onChange,
}: {
  value: "pct" | "value";
  onChange: (m: "pct" | "value") => void;
}) {
  const opts: { key: "pct" | "value"; label: string }[] = [
    { key: "pct", label: "%" },
    { key: "value", label: "A$" },
  ];
  return (
    <div className="flex rounded-lg bg-muted p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
            value === o.key
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ tickers }: { tickers: string[] }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <LegendItem label="Portfolio" color="hsl(var(--foreground))" bold />
      {tickers.map((t, i) => (
        <LegendItem key={t} label={t} color={PALETTE[i % PALETTE.length]} />
      ))}
    </div>
  );
}

function LegendItem({
  label,
  color,
  bold,
}: {
  label: string;
  color: string;
  bold?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span
        className={
          bold
            ? "font-mono-nums font-semibold text-foreground"
            : "font-mono-nums text-muted-foreground"
        }
      >
        {label}
      </span>
    </span>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center gap-1 text-center">
      <p className="text-sm font-medium">Performance history unavailable</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Set <code>MBOUM_API_KEY</code> to load price history, or this range has no
        data. Quotes and scoring continue to work without it.
      </p>
    </div>
  );
}
