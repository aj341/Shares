"use client";

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

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", { month: "short", day: "2-digit" });
}

export function PerformanceChart({
  data,
  loading,
}: {
  data: PerformanceResponse | null;
  loading: boolean;
}) {
  const title = data?.rangeLabel ?? "6-Month Performance";

  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {data?.hasData ? (
          <span className="text-[11px] text-muted-foreground">
            rebased · % return · via Mboum
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[280px] w-full" />
        ) : !data?.hasData ? (
          <EmptyChart />
        ) : (
          <>
            <Legend tickers={data.tickers} />
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.series} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    minTickGap={48}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}%`}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    width={48}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    labelFormatter={(l) => shortDate(String(l))}
                    formatter={(value: number, name: string) => [
                      `${value > 0 ? "+" : ""}${value}%`,
                      name,
                    ]}
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                      fontSize: 12,
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  {data.tickers.map((t, i) => (
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
        Set <code>MBOUM_API_KEY</code> to load 6-month price history. Quotes and
        scoring continue to work without it.
      </p>
    </div>
  );
}
