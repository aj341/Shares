"use client";

import * as React from "react";
import { CalendarClock, AlertOctagon, Dot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * [scanner] Economic-calendar strip — today's / upcoming high-impact macro
 * events (CPI / FOMC / NFP, ...) plus an intraday "blackout window" warning for
 * opening-range entries. Self-fetches /api/econ-calendar; renders nothing when
 * there is nothing to show (no key + no static fallback), so it is fully
 * additive and never clutters the shell.
 */

type EconEvent = {
  title: string;
  country: string | null;
  impact: "high" | "medium" | "low";
  timeMs: number | null;
  date: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  minutesAway: number | null;
};

type EconCalendar = {
  today: EconEvent[];
  upcomingHighImpact: EconEvent[];
  blackout: {
    active: boolean;
    event: EconEvent | null;
    windowMinutes: number;
  };
  asOf: string;
  source: "mboum" | "static" | "none";
};

function fmtWhen(e: EconEvent): string {
  if (e.timeMs != null) {
    const d = new Date(e.timeMs);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    const day = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return sameDay ? `${time} ET` : `${day} · ${time} ET`;
  }
  return e.date;
}

export function EconCalendarStrip() {
  const [data, setData] = React.useState<EconCalendar | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/econ-calendar", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (failed || !data || data.source === "none") return null;

  const events =
    data.today.length > 0 ? data.today : data.upcomingHighImpact.slice(0, 4);
  if (events.length === 0 && !data.blackout.active) return null;

  return (
    <div className="space-y-2">
      {data.blackout.active && data.blackout.event ? (
        <div className="flex items-center gap-2 rounded-lg border border-[hsl(var(--warning))] bg-warning-muted px-3 py-2 text-xs [color:hsl(var(--warning))]">
          <AlertOctagon className="h-4 w-4 shrink-0" />
          <span className="font-medium">
            Blackout window — {data.blackout.event.title} within ±
            {data.blackout.windowMinutes}m. Avoid fresh opening-range entries
            into the release.
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          {data.today.length > 0 ? "Today" : "Upcoming"}
        </span>
        {events.map((e, i) => (
          <span key={`${e.date}-${e.title}-${i}`} className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
            {i > 0 ? (
              <Dot className="h-3 w-3 text-muted-foreground/50" />
            ) : null}
            <Badge
              variant={
                e.impact === "high"
                  ? "warning"
                  : e.impact === "medium"
                    ? "secondary"
                    : "outline"
              }
              className="font-normal"
            >
              {e.title}
            </Badge>
            <span className="text-muted-foreground">{fmtWhen(e)}</span>
            {e.forecast ? (
              <span className="text-muted-foreground/70">
                (est {e.forecast})
              </span>
            ) : null}
          </span>
        ))}
        <span
          className={cn(
            "ml-auto text-[10px] uppercase tracking-wide text-muted-foreground"
          )}
        >
          {data.source === "mboum" ? "live" : "scheduled"}
        </span>
      </div>
    </div>
  );
}
