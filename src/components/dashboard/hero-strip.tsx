"use client";
// [herostrip] "How am I doing today" — a 5-second mobile glance bar placed at
// the very top of the dashboard. Plain-English, color-coded. Reads data the
// shell already has (portfolio + today's P&L); fetches QQQ + risk mood live and
// degrades gracefully if either is unavailable.
import * as React from "react";
import { formatCurrency } from "@/lib/utils";
import type { PortfolioResponse, PnlByPeriod } from "@/lib/types";

const POS = "[color:hsl(var(--positive))]";
const NEG = "[color:hsl(var(--negative))]";
const WARN = "[color:hsl(var(--warning))]";

function pctStr(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export default function HeroStrip({
  portfolio,
  pnlByPeriod,
}: {
  portfolio: PortfolioResponse;
  pnlByPeriod: PnlByPeriod | null;
}) {
  // Today's P&L: prefer the performance series; else derive from holdings so the
  // strip is never blank while perf is still loading.
  let todayVal = pnlByPeriod?.daily?.value ?? null;
  let todayPct = pnlByPeriod?.daily?.pct ?? null;
  if (todayVal == null || todayPct == null) {
    let prev = 0;
    let cur = 0;
    for (const h of portfolio.holdings) {
      const mv = h.marketValue ?? 0;
      const dc = h.dayChangePct ?? 0;
      cur += mv;
      prev += mv / (1 + dc / 100);
    }
    todayVal = cur - prev;
    todayPct = prev > 0 ? (todayVal / prev) * 100 : 0;
  }

  const investedPct =
    portfolio.totalPortfolioValue > 0
      ? Math.max(0, Math.min(100, (1 - portfolio.cash / portfolio.totalPortfolioValue) * 100))
      : 0;

  const [qqqPct, setQqqPct] = React.useState<number | null>(null);
  const [mood, setMood] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch("/api/research/QQQ")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.holding?.dayChangePct != null) setQqqPct(Number(d.holding.dayChangePct));
      })
      .catch(() => {});
    // Forward-compatible: once the risk governor ships, its level drives mood.
    fetch("/api/risk-governor")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.level) setMood(String(d.level));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const todayUp = (todayVal ?? 0) >= 0;
  const vsMarket = qqqPct != null && todayPct != null ? todayPct - qqqPct : null;
  const beating = vsMarket != null && vsMarket >= 0;

  const moodLabel =
    mood === "high"
      ? "Choppy"
      : mood === "elevated"
      ? "Mixed"
      : mood === "calm"
      ? "Calm"
      : Math.abs(todayPct ?? 0) >= 1.5
      ? "Choppy"
      : "Calm";
  const moodTone = moodLabel === "Calm" ? POS : WARN;

  return (
    <div className="rounded-2xl border border-border/60 bg-card/70 px-3 py-2.5 shadow-sm backdrop-blur">
      <div className="grid grid-cols-4 gap-1.5 text-center sm:gap-3">
        <Stat
          label="Today"
          value={formatCurrency(todayVal ?? 0, { sign: true, whole: true })}
          sub={pctStr(todayPct ?? 0)}
          tone={todayUp ? POS : NEG}
        />
        <Stat
          label="vs Market"
          value={vsMarket == null ? "—" : pctStr(vsMarket)}
          sub={vsMarket == null ? "QQQ n/a" : beating ? "beating" : "lagging"}
          tone={vsMarket == null ? "text-muted-foreground" : beating ? POS : NEG}
        />
        <Stat
          label="Invested"
          value={`${Math.round(investedPct)}%`}
          sub={`${Math.round(100 - investedPct)}% cash`}
          tone="text-foreground"
        />
        <Stat label="Mood" value={moodLabel} sub="market" tone={moodTone} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`truncate text-sm font-bold leading-tight sm:text-base ${tone}`}>{value}</p>
      <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}
