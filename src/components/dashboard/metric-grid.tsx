"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { toneTextClass } from "@/lib/ui";
import type { Metric, MetricCategory } from "@/lib/types";

const CATEGORY_ORDER: { key: MetricCategory; label: string }[] = [
  { key: "trend", label: "Trend" },
  { key: "momentum", label: "Momentum" },
  { key: "valuation", label: "Valuation" },
  { key: "fundamental", label: "Fundamental" },
  { key: "risk", label: "Risk" },
  { key: "sentiment", label: "Sentiment" },
];

function StatusDot({ status }: { status: Metric["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        status === "positive"
          ? "bg-[hsl(var(--positive))]"
          : status === "negative"
            ? "bg-[hsl(var(--negative))]"
            : "bg-muted-foreground/50"
      )}
    />
  );
}

export function MetricGrid({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No metrics available for this holding.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {CATEGORY_ORDER.map(({ key, label }) => {
        const items = metrics.filter((m) => m.category === key);
        if (items.length === 0) return null;
        return (
          <Card key={key} className="overflow-hidden">
            <CardContent className="p-0">
              <div className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </div>
              <ul className="divide-y">
                {items.map((m) => (
                  <li
                    key={m.name}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                    title={m.description}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot status={m.status} />
                      <span className="truncate text-sm">{m.name}</span>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-sm font-medium tabular-nums",
                        toneTextClass(m.status)
                      )}
                    >
                      {m.value}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
