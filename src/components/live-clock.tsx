"use client";

import * as React from "react";

/** Live AEST clock with a pulsing "market data" status dot. */
export function LiveClock() {
  const [time, setTime] = React.useState<string>("");

  React.useEffect(() => {
    const tick = () => {
      setTime(
        new Intl.DateTimeFormat("en-AU", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Australia/Sydney",
        }).format(new Date())
      );
    };
    tick();
    const id = setInterval(tick, 1000 * 30);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hidden items-center gap-2 sm:flex">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[hsl(var(--positive))] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[hsl(var(--positive))]" />
      </span>
      <div className="leading-tight">
        <p className="font-mono-nums text-xs font-medium" suppressHydrationWarning>
          {time || "—"}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">AEST</p>
      </div>
    </div>
  );
}
