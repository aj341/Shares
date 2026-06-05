"use client";

import * as React from "react";
import { Sparkles, CalendarClock, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fetchBrief } from "@/lib/client";
import type { DailyBrief } from "@/lib/types";

const STANCE_META: Record<
  DailyBrief["stance"],
  { label: string; cls: string }
> = {
  "risk-on": { label: "Risk-on", cls: "bg-positive-muted [color:hsl(var(--positive))]" },
  neutral: { label: "Neutral", cls: "bg-muted text-muted-foreground" },
  mixed: { label: "Mixed", cls: "bg-warning-muted [color:hsl(var(--warning))]" },
  "risk-off": { label: "Risk-off", cls: "bg-negative-muted [color:hsl(var(--negative))]" },
};

const URGENCY_CLS: Record<string, string> = {
  high: "[color:hsl(var(--negative))]",
  medium: "[color:hsl(var(--warning))]",
  low: "text-muted-foreground",
};

export function DailyBriefCard() {
  const [brief, setBrief] = React.useState<DailyBrief | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    fetchBrief()
      .then((b) => alive && setBrief(b))
      .catch(() => alive && setBrief(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!brief || !brief.hasData) return null;

  const stance = STANCE_META[brief.stance];

  return (
    <Card className="overflow-hidden border-brand/30">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 [color:hsl(var(--brand))]" />
            Today&apos;s Brief
          </CardTitle>
          <p className="mt-1 text-sm font-semibold">{brief.headline}</p>
        </div>
        <Badge className={cn("shrink-0 gap-1", stance.cls)}>{stance.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{brief.summary}</p>

        {brief.watchItems.length > 0 && (
          <div className="space-y-1.5">
            {brief.watchItems.map((w, i) => (
              <div key={`${w.ticker}-${i}`} className="flex items-start gap-2 text-sm">
                <span className="font-mono-nums font-semibold">{w.ticker}</span>
                <span
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-wide",
                    URGENCY_CLS[w.urgency]
                  )}
                >
                  {w.urgency}
                </span>
                <span className="min-w-0 flex-1 text-muted-foreground">{w.note}</span>
              </div>
            ))}
          </div>
        )}

        {brief.catalysts.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" /> Upcoming catalysts
            </p>
            <div className="flex flex-wrap gap-1.5">
              {brief.catalysts.map((c, i) => (
                <Badge key={`${c.ticker}-${i}`} variant="secondary" className="gap-1 text-[11px]">
                  <span className="font-mono-nums font-semibold">{c.ticker}</span>
                  {c.detail}
                  <span className="text-muted-foreground">· {countdown(c.daysAway)}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{brief.disclaimer}</span>
          <span className="flex items-center gap-1">
            <RefreshCw className="h-3 w-3" />
            {brief.source === "llm" ? "AI" : "auto"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function countdown(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days}d`;
}
