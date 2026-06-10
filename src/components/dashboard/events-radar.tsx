"use client";

import * as React from "react";
import { CalendarClock, Coins, Megaphone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

type UpcomingEvent = {
  ticker: string;
  type: "earnings" | "dividend";
  date: string;
  detail: string;
  daysAway: number;
  /** Avg absolute % move on past earnings prints (earnings events only). */
  avgAbsMovePct?: number;
};

export function EventsRadar() {
  const [events, setEvents] = React.useState<UpcomingEvent[] | null>(null);

  React.useEffect(() => {
    fetch("/api/events", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setEvents([]));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          Event Radar
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events === null ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No upcoming earnings or ex-dividend dates in the next 90 days.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((e, i) => (
              <li key={i} className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2">
                <span className="text-muted-foreground">
                  {e.type === "earnings" ? (
                    <Megaphone className="h-4 w-4" />
                  ) : (
                    <Coins className="h-4 w-4" />
                  )}
                </span>
                <Badge variant="secondary" className="font-mono-nums text-[10px]">
                  {e.ticker}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{e.detail}</span>
                {e.type === "earnings" && typeof e.avgAbsMovePct === "number" && (
                  <span
                    className="shrink-0 text-xs text-amber-600 tabular-nums dark:text-amber-500"
                    title="Average absolute move on recent earnings prints"
                  >
                    ±{e.avgAbsMovePct.toFixed(1)}% hist.
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {e.daysAway === 0 ? "today" : `in ${e.daysAway}d`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
