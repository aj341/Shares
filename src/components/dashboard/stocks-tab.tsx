"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Minus,
  Pencil,
  Receipt,
  Archive,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
// [chart] per-stock intraday 1D live chart
import { IntradayChart } from "@/components/dashboard/intraday-chart";
import { cn, formatCurrency, formatNumber, formatPct, formatUsd } from "@/lib/utils";
import { signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import { sectorFor } from "@/lib/sectors";
import type { DialogType } from "@/components/dashboard/portfolio-dialogs";
import type { Holding, StockTechnicals } from "@/lib/types";

export function StocksTab({
  holdings,
  technicals,
  onSelect,
  onAction,
  refreshKey = 0, // [chart] bumped by the dashboard refresh to re-pull intraday
}: {
  holdings: Holding[];
  technicals: Record<string, StockTechnicals>;
  loading: boolean;
  onSelect: (ticker: string) => void;
  onAction: (type: DialogType, ticker: string) => void;
  refreshKey?: number;
}) {
  const buy = holdings.filter((h) => h.signal === "BUY" || h.signal === "STRONG_BUY").length;
  const hold = holdings.filter((h) => h.signal === "HOLD").length;
  const sell = holdings.filter((h) => h.signal === "SELL" || h.signal === "TRIM").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Individual Holdings</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="[color:hsl(var(--positive))]">{buy} BUY</span>
          <span>{hold} HOLD</span>
          <span className="[color:hsl(var(--negative))]">{sell} TRIM/SELL</span>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {holdings.map((h) => (
          <StockCard
            key={h.ticker}
            holding={h}
            tech={technicals[h.ticker]}
            onSelect={onSelect}
            onAction={onAction}
            refreshKey={refreshKey} // [chart]
          />
        ))}
      </div>
    </div>
  );
}

function StockCard({
  holding: h,
  tech,
  onSelect,
  onAction,
  refreshKey = 0, // [chart]
}: {
  holding: Holding;
  tech?: StockTechnicals;
  onSelect: (ticker: string) => void;
  onAction: (type: DialogType, ticker: string) => void;
  refreshKey?: number;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Card className="overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => onSelect(h.ticker)}
            className="flex items-center gap-3 text-left"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-[11px] font-mono-nums font-bold">
              {h.ticker.slice(0, 4)}
            </span>
            <span>
              <span className="flex items-center gap-2">
                <span className="font-semibold">{h.companyName.split(" ")[0]}</span>
                <Badge variant={signalToVariant(h.signal)} className="text-[10px]">
                  {STATUS_LABELS[h.signal]}
                </Badge>
              </span>
              <span className="block text-xs text-muted-foreground">
                {sectorFor(h.ticker)} · {formatNumber(h.shares, 0)} shares
              </span>
            </span>
          </button>
          <div className="flex items-start gap-1">
            <div className="text-right">
              <p className="font-mono-nums text-lg font-bold">{formatUsd(h.currentPrice)}</p>
              <p className={cn("font-mono-nums text-xs", signedTextClass(h.dayChangePct))}>
                {h.dayChangePct >= 0 ? "▲" : "▼"} {formatPct(Math.abs(h.dayChangePct))}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${h.ticker}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onAction("buy", h.ticker)}>
                  <Plus className="h-4 w-4" /> Add shares
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction("sell", h.ticker)}>
                  <Minus className="h-4 w-4" /> Sell shares
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction("edit", h.ticker)}>
                  <Pencil className="h-4 w-4" /> Edit holding
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction("history", h.ticker)}>
                  <Receipt className="h-4 w-4" /> View transactions
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onAction("archive", h.ticker)}>
                  <Archive className="h-4 w-4" /> Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* [chart] Per-stock intraday 1D live chart — priority placement. */}
        <div className="my-3">
          <IntradayChart symbol={h.ticker} height={132} refreshKey={refreshKey} compact />
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="P&L" value={formatCurrency(h.unrealisedPnl, { sign: true, compact: true })} className={signedTextClass(h.unrealisedPnl)} />
          <Stat label="Value" value={formatCurrency(h.marketValue, { compact: true })} />
          <Stat label="Weight" value={`${formatNumber(h.portfolioWeight, 1)}%`} />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-center border-t py-1.5 text-muted-foreground transition-colors hover:bg-muted/40"
        aria-label={open ? "Collapse metrics" : "Expand metrics"}
      >
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && <KpiCarousel holding={h} tech={tech} />}
    </Card>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <p className={cn("font-mono-nums text-sm font-semibold", className)}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sliding KPI carousel
// ---------------------------------------------------------------------------

function KpiCarousel({ holding: h, tech }: { holding: Holding; tech?: StockTechnicals }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [idx, setIdx] = React.useState(0);

  const slides = buildSlides(h, tech);

  const go = (next: number) => {
    const el = ref.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(slides.length - 1, next));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
    setIdx(clamped);
  };

  return (
    <div className="border-t bg-muted/20">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIdx(Math.round(el.scrollLeft / el.clientWidth));
        }}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {slides.map((s, i) => (
          <div key={i} className="w-full min-w-full snap-center p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {s.title}
            </p>
            {s.content}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-4 pb-3">
        <button
          type="button"
          onClick={() => go(idx - 1)}
          disabled={idx === 0}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label="Previous"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => go(i)}
              aria-label={`Slide ${i + 1}`}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === idx ? "w-4 bg-foreground" : "w-1.5 bg-muted-foreground/40"
              )}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => go(idx + 1)}
          disabled={idx === slides.length - 1}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label="Next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function buildSlides(h: Holding, tech?: StockTechnicals) {
  const factors: string[] = [];
  if (tech?.bullishPct != null) factors.push(`${tech.bullishPct}% analysts bullish`);
  if (tech?.targetUpsidePct != null)
    factors.push(`${tech.targetUpsidePct >= 0 ? "+" : ""}${Math.round(tech.targetUpsidePct)}% analyst upside`);
  if (tech?.rsi != null) factors.push(`RSI ${tech.rsi}`);

  return [
    {
      title: "Momentum",
      content: <RsiBar rsi={tech?.rsi ?? null} />,
    },
    {
      title: "Trend",
      content: (
        <div className="grid grid-cols-2 gap-3">
          <MaCard label="20-Day MA" ma={tech?.ma20 ?? null} side={tech?.priceVsMa20 ?? null} />
          <MaCard label="50-Day MA" ma={tech?.ma50 ?? null} side={tech?.priceVsMa50 ?? null} />
        </div>
      ),
    },
    {
      title: "Valuation & Analysts",
      content: <TargetSlide tech={tech} price={h.currentPrice} />,
    },
    {
      title: "Signal Factors",
      content:
        factors.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {factors.map((f) => (
              <Badge key={f} variant="positive" className="text-[11px]">
                {f}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No analyst signals available.</p>
        ),
    },
    {
      title: "Position",
      content: (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <PosRow label="Entry price" value={formatUsd(h.entryPrice)} />
          <PosRow label="Current price" value={formatUsd(h.currentPrice)} className={signedTextClass(h.currentPrice - h.entryPrice)} />
          <PosRow label="Unrealised P&L" value={formatCurrency(h.unrealisedPnl, { sign: true })} className={signedTextClass(h.unrealisedPnl)} />
          <PosRow label="Return" value={formatPct(h.unrealisedPnlPct, { sign: true })} className={signedTextClass(h.unrealisedPnlPct)} />
          <PosRow label="Cost basis" value={formatCurrency(h.costBasis)} />
          <PosRow label="Score" value={`${h.score}/100`} />
        </div>
      ),
    },
    {
      title: "Latest Announcement",
      content: h.announcements[0] ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge
              variant={
                h.announcements[0].impact === "positive"
                  ? "positive"
                  : h.announcements[0].impact === "negative"
                    ? "negative"
                    : "neutral"
              }
              className="text-[10px]"
            >
              Impact {h.announcements[0].impactScore > 0 ? `+${h.announcements[0].impactScore}` : h.announcements[0].impactScore}
            </Badge>
            <span className="text-xs text-muted-foreground">{h.announcements[0].date}</span>
          </div>
          <p className="text-sm font-medium">{h.announcements[0].title}</p>
          <p className="line-clamp-3 text-xs text-muted-foreground">{h.announcements[0].summary}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No recent announcements.</p>
      ),
    },
  ];
}

function RsiBar({ rsi }: { rsi: number | null }) {
  if (rsi == null)
    return <p className="text-sm text-muted-foreground">RSI unavailable.</p>;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">RSI</span>
        <span className="font-mono-nums font-semibold">{rsi}</span>
      </div>
      <div className="relative h-2 w-full rounded-full bg-gradient-to-r from-[hsl(var(--positive))] via-[hsl(var(--warning))] to-[hsl(var(--negative))]">
        <span
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground"
          style={{ left: `${Math.max(0, Math.min(100, rsi))}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>Oversold</span>
        <span>Overbought</span>
      </div>
    </div>
  );
}

function MaCard({
  label,
  ma,
  side,
}: {
  label: string;
  ma: number | null;
  side: "above" | "below" | null;
}) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono-nums text-sm font-semibold">
        {ma != null ? formatUsd(ma) : "—"}
      </p>
      {side && (
        <p className={cn("text-[11px]", side === "above" ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]")}>
          Price is {side}
        </p>
      )}
    </div>
  );
}

function TargetSlide({ tech, price }: { tech?: StockTechnicals; price: number }) {
  if (!tech || tech.targetMean == null)
    return <p className="text-sm text-muted-foreground">No analyst target available.</p>;
  const upside = tech.targetUpsidePct ?? 0;
  const pct = Math.max(4, Math.min(100, ((price / tech.targetMean) * 100) | 0));
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Analyst Target</span>
          <span className="font-mono-nums font-semibold">
            {formatUsd(tech.targetMean)}{" "}
            <span className={upside >= 0 ? "[color:hsl(var(--positive))]" : "[color:hsl(var(--negative))]"}>
              {upside >= 0 ? "+" : ""}
              {Math.round(upside)}%
            </span>
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-[hsl(var(--positive))]" style={{ width: `${pct}%` }} />
        </div>
        {tech.bullishPct != null && (
          <p className="mt-1 text-[11px] text-muted-foreground">{tech.bullishPct}% bullish</p>
        )}
      </div>
      {tech.peRatio != null && (
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">P/E</span>
          <span className="font-mono-nums font-medium">{tech.peRatio.toFixed(1)}</span>
        </div>
      )}
    </div>
  );
}

function PosRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono-nums font-medium", className)}>{value}</span>
    </div>
  );
}
