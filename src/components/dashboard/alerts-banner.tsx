"use client";

import * as React from "react";
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  Newspaper,
  TrendingDown,
  X,
  Layers,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PortfolioAlert } from "@/lib/types";

const KIND_ICON: Record<PortfolioAlert["kind"], typeof Bell> = {
  signal_change: TrendingDown,
  rsi_extreme: AlertTriangle,
  high_impact_news: Newspaper,
  near_cap: Layers,
};

const SEV_RANK: Record<PortfolioAlert["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function sevClasses(sev: PortfolioAlert["severity"]): string {
  return sev === "critical"
    ? "[color:hsl(var(--negative))]"
    : sev === "warning"
      ? "[color:hsl(var(--warning))]"
      : "text-muted-foreground";
}

export function AlertsBanner({ alerts }: { alerts: PortfolioAlert[] }) {
  const [open, setOpen] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  if (!alerts.length || dismissed) return null;

  const sorted = [...alerts].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const top = sorted[0];
  const maxSev = top.severity;

  return (
    <Card
      className={cn(
        "overflow-hidden border-l-4",
        maxSev === "critical"
          ? "border-l-[hsl(var(--negative))]"
          : maxSev === "warning"
            ? "border-l-[hsl(var(--warning))]"
            : "border-l-[hsl(var(--brand))]"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Bell className={cn("h-4 w-4 shrink-0", sevClasses(maxSev))} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-sm font-medium">
            {alerts.length} alert{alerts.length > 1 ? "s" : ""}
          </span>
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">
            · {top.message}
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss alerts"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <ul className="divide-y border-t">
          {sorted.map((a, i) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <li key={i} className="flex items-center gap-3 px-4 py-2">
                <Icon className={cn("h-4 w-4 shrink-0", sevClasses(a.severity))} />
                <Badge variant="secondary" className="font-mono-nums text-[10px]">
                  {a.ticker}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {a.message}
                </span>
                <span className={cn("shrink-0 text-[10px] uppercase tracking-wide", sevClasses(a.severity))}>
                  {a.severity}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
