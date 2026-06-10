"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn, formatCurrency, formatNumber, formatPct, formatUsd } from "@/lib/utils";
import { scoreColorClass, signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import { MetricGrid } from "@/components/dashboard/metric-grid";
import { AnnouncementsTimeline } from "@/components/dashboard/announcements-timeline";
import { VerdictPanel } from "@/components/dashboard/verdict-panel";
import { ExecutiveSentiment } from "@/components/dashboard/executive-sentiment";
import type { Holding } from "@/lib/types";

export function StockDetailSheet({
  holding,
  open,
  onOpenChange,
}: {
  holding: Holding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto p-0">
        {holding ? (
          <DetailBody holding={holding} />
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            Select a holding to view detail.
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn("text-sm font-semibold tabular-nums", className)}>
        {value}
      </p>
    </div>
  );
}

function DetailBody({ holding: h }: { holding: Holding }) {
  // shares === 0 marks a research view (watchlist name, not held).
  const held = h.shares > 0;
  return (
    <>
      <SheetHeader>
        <div className="flex items-start justify-between gap-3 pr-8">
          <div>
            <SheetTitle className="flex items-center gap-2 text-xl">
              {h.ticker}
              <Badge variant={signalToVariant(h.signal)}>
                {STATUS_LABELS[h.signal]}
              </Badge>
              {!held && (
                <Badge variant="outline" className="text-[10px]">
                  WATCHLIST · NOT HELD
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription>{h.companyName}</SheetDescription>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">
              {formatUsd(h.currentPrice)}
            </p>
            <p className={cn("text-xs tabular-nums", signedTextClass(h.dayChangePct))}>
              {formatPct(h.dayChangePct, { sign: true })} today
            </p>
          </div>
        </div>

        {held ? (
          <div className="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-4">
            <Stat label="Shares" value={formatNumber(h.shares, 0)} />
            <Stat label="Entry" value={formatUsd(h.entryPrice)} />
            <Stat label="Mkt value" value={formatCurrency(h.marketValue, { compact: true })} />
            <Stat label="Weight" value={`${formatNumber(h.portfolioWeight, 1)}%`} />
            <Stat
              label="Unreal. P&L"
              value={formatCurrency(h.unrealisedPnl, { sign: true, compact: true })}
              className={signedTextClass(h.unrealisedPnl)}
            />
            <Stat
              label="Return"
              value={formatPct(h.unrealisedPnlPct, { sign: true })}
              className={signedTextClass(h.unrealisedPnlPct)}
            />
            <Stat
              label="Score"
              value={`${h.score}/100`}
              className={scoreColorClass(h.score)}
            />
            <Stat label="Cost basis" value={formatCurrency(h.costBasis, { compact: true })} />
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stat
              label="Score"
              value={`${h.score}/100`}
              className={scoreColorClass(h.score)}
            />
            <Stat label="Signal" value={STATUS_LABELS[h.signal]} />
            <Stat label="Day move" value={formatPct(h.dayChangePct, { sign: true })} className={signedTextClass(h.dayChangePct)} />
          </div>
        )}
      </SheetHeader>

      <div className="space-y-6 p-6">
        <VerdictPanel verdict={h.verdict} />

        <ExecutiveSentiment exec={h.verdict.execCommentary} />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Metrics</h3>
          <MetricGrid metrics={h.metrics} />
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Announcements</h3>
          <AnnouncementsTimeline announcements={h.announcements} />
        </section>
      </div>
    </>
  );
}
