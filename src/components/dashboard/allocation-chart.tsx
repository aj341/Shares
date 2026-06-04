"use client";

import * as React from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCurrency } from "@/lib/utils";
import type { AllocationSnapshot } from "@/lib/types";

type AllocMode = "pct" | "value";

/** Stable, institutional palette; CASH always renders muted/grey. */
const PALETTE = [
  "hsl(222 70% 58%)",
  "hsl(152 52% 48%)",
  "hsl(199 80% 52%)",
  "hsl(38 80% 55%)",
  "hsl(280 55% 62%)",
  "hsl(12 72% 56%)",
  "hsl(174 52% 46%)",
];
const CASH_COLOR = "hsl(215 16% 55%)";

type LegendDatum = {
  name: string;
  value: number;
  marketValue: number;
  color: string;
};

/** Custom tooltip with explicit popover colours so text is always readable. */
function AllocTooltip({
  active,
  payload,
  mode,
}: {
  active?: boolean;
  payload?: Array<{ payload: LegendDatum }>;
  mode: AllocMode;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: d.color }}
        />
        <span className="font-mono-nums font-semibold text-popover-foreground">
          {d.name}
        </span>
        <span className="font-mono-nums text-muted-foreground">
          {mode === "pct"
            ? `${d.value}%`
            : formatCurrency(d.marketValue, { compact: true })}
        </span>
      </span>
    </div>
  );
}

export function AllocationDonut({
  title,
  data,
}: {
  title: string;
  data: AllocationSnapshot[];
}) {
  const [mode, setMode] = React.useState<AllocMode>("pct");

  // Assign a stable colour per non-cash ticker, grey for cash.
  let paletteIndex = 0;
  const items = data
    .filter((d) => d.weight > 0)
    .map((d) => ({
      name: d.ticker,
      value: Number(d.weight.toFixed(2)),
      marketValue: d.marketValue,
      color: d.ticker === "CASH" ? CASH_COLOR : PALETTE[paletteIndex++ % PALETTE.length],
    }));

  const total = items.reduce((s, d) => s + d.marketValue, 0);

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-16 text-center text-sm text-muted-foreground">
            No allocation data.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
        <div className="flex rounded-md bg-muted p-0.5">
          {(["pct", "value"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                mode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m === "pct" ? "%" : "$"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={items}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={62}
                outerRadius={92}
                paddingAngle={2}
                strokeWidth={0}
                isAnimationActive={false}
              >
                {items.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                cursor={false}
                content={({ active, payload }) => (
                  <AllocTooltip
                    active={active}
                    payload={
                      payload as unknown as Array<{ payload: LegendDatum }> | undefined
                    }
                    mode={mode}
                  />
                )}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Center total */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Total
            </span>
            <span className="font-mono-nums text-lg font-bold">
              {formatCurrency(total, { compact: true })}
            </span>
          </div>
        </div>

        {/* Legend with weights — each entry is a pill so it always reads
            clearly against the card background. */}
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {items.map((d) => (
            <li
              key={d.name}
              className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground"
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: d.color }}
              />
              <span className="font-mono-nums font-semibold">{d.name}</span>
              <span className="font-mono-nums tabular-nums text-muted-foreground">
                {mode === "pct"
                  ? `${d.value}%`
                  : formatCurrency(d.marketValue, { compact: true })}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function AllocationChart({
  before,
  after,
}: {
  before: AllocationSnapshot[];
  after: AllocationSnapshot[];
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <AllocationDonut title="Current allocation" data={before} />
      <AllocationDonut title="Proposed allocation" data={after} />
    </div>
  );
}
