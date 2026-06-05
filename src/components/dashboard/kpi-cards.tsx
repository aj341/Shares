"use client";

import * as React from "react";
import {
  DollarSign,
  TrendingDown,
  TrendingUp,
  Trophy,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn, formatCurrency, formatPct } from "@/lib/utils";
import { computeInsights } from "@/lib/insights";
import type { PnlByPeriod, PnlPeriod, PortfolioResponse } from "@/lib/types";

type Accent = "brand" | "positive" | "negative" | "warning" | "violet";

const ACCENT: Record<Accent, { text: string; chip: string }> = {
  brand: { text: "[color:hsl(var(--brand))]", chip: "bg-brand-muted [color:hsl(var(--brand))]" },
  positive: {
    text: "[color:hsl(var(--positive))]",
    chip: "bg-positive-muted [color:hsl(var(--positive))]",
  },
  negative: {
    text: "[color:hsl(var(--negative))]",
    chip: "bg-negative-muted [color:hsl(var(--negative))]",
  },
  warning: {
    text: "[color:hsl(var(--warning))]",
    chip: "bg-warning-muted [color:hsl(var(--warning))]",
  },
  violet: { text: "[color:hsl(var(--violet))]", chip: "bg-violet-muted [color:hsl(var(--violet))]" },
};

function CardShell({
  icon: Icon,
  accent,
  children,
  header,
}: {
  icon: LucideIcon;
  accent: Accent;
  children: React.ReactNode;
  header?: React.ReactNode;
}) {
  const a = ACCENT[accent];
  return (
    <Card className="relative overflow-hidden p-5">
      <div className="mb-4 flex items-start justify-between">
        <div className={cn("inline-flex rounded-xl p-2.5", a.chip)}>
          <Icon className="h-5 w-5" />
        </div>
        {header}
      </div>
      {children}
    </Card>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  icon: LucideIcon;
  accent: Accent;
}) {
  return (
    <CardShell icon={icon} accent={accent}>
      <p className={cn("font-mono-nums text-2xl font-bold leading-none sm:text-3xl", ACCENT[accent].text)}>
        {value}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground/80">{label}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </CardShell>
  );
}

const PERIODS: { key: PnlPeriod; label: string }[] = [
  { key: "daily", label: "1D" },
  { key: "weekly", label: "1W" },
  { key: "monthly", label: "1M" },
  { key: "total", label: "Total" },
];

function PnlCard({
  portfolio,
  pnlByPeriod,
}: {
  portfolio: PortfolioResponse;
  pnlByPeriod: PnlByPeriod | null;
}) {
  const [period, setPeriod] = React.useState<PnlPeriod>("daily");

  const value =
    period === "total" || !pnlByPeriod
      ? portfolio.totalUnrealisedPnl
      : pnlByPeriod[period].value;
  const pct =
    period === "total" || !pnlByPeriod
      ? portfolio.totalUnrealisedPnlPct
      : pnlByPeriod[period].pct;

  const up = value >= 0;
  const accent: Accent = up ? "positive" : "negative";
  const subLabel: Record<PnlPeriod, string> = {
    daily: "today",
    weekly: "past week",
    monthly: "past month",
    total: "total return",
  };

  return (
    <CardShell
      icon={up ? TrendingUp : TrendingDown}
      accent={accent}
      header={
        <div className="flex rounded-lg bg-muted p-0.5">
          {PERIODS.map((p) => {
            const disabled = p.key !== "total" && !pnlByPeriod;
            return (
              <button
                key={p.key}
                type="button"
                disabled={disabled}
                onClick={() => setPeriod(p.key)}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                  period === p.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-40"
                )}
                title={disabled ? "Needs Mboum history" : undefined}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      }
    >
      <p className={cn("font-mono-nums text-2xl font-bold leading-none sm:text-3xl", ACCENT[accent].text)}>
        {formatCurrency(value, { sign: true, whole: true })}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground/80">Unrealised P&L</p>
      <p className={cn("mt-0.5 text-xs", ACCENT[accent].text)}>
        {formatPct(pct, { sign: true })} {subLabel[period]}
      </p>
    </CardShell>
  );
}

export function KpiCards({
  portfolio,
  pnlByPeriod,
}: {
  portfolio: PortfolioResponse;
  pnlByPeriod?: PnlByPeriod | null;
}) {
  const i = computeInsights(portfolio);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="Portfolio Value"
        value={formatCurrency(portfolio.totalPortfolioValue, { whole: true })}
        sub={`Cost basis ${formatCurrency(portfolio.totalCostBasis, { whole: true })}`}
        icon={DollarSign}
        accent="brand"
      />
      <PnlCard portfolio={portfolio} pnlByPeriod={pnlByPeriod ?? null} />
      <KpiCard
        label="Win Rate"
        value={`${i.winRatePct}%`}
        sub={`${i.winners} winners / ${i.losers} losers`}
        icon={Trophy}
        accent="warning"
      />
      <KpiCard
        label="Signal Sentiment"
        value={`${i.bullishPct}% Bull`}
        sub={`avg score ${i.avgScore} · ${i.buyTickers.length} buy signals`}
        icon={Sparkles}
        accent="violet"
      />
    </div>
  );
}
