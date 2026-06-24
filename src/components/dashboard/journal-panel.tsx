"use client";

import * as React from "react";
import { BookOpen, Crosshair, Gauge, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatUsd } from "@/lib/utils";
import { signalToVariant, signedTextClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import { WhatIfPanel } from "@/components/dashboard/whatif-panel"; // [whatif]
import type { Signal } from "@/lib/types";

/**
 * [journal] Trade journal + execution/slippage analytics panel.
 *
 * Read-only view over /api/journal and /api/execution-stats. Mirrors the
 * server shapes structurally (kept local so shared types stay minimal).
 * Honest about sparsity: every table shows sample sizes and a small-sample
 * caveat; missing data renders as an em dash, never a fabricated value.
 */

type TagStats = {
  tag: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  expectancyR: number | null;
  avgReturnPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  avgMaePct: number | null;
  avgMfePct: number | null;
  totalRealised: number;
};

type JournalTrade = {
  id: string;
  ticker: string;
  sector: string;
  entryPrice: number;
  exitPrice: number | null;
  shares: number;
  entryDate: string;
  exitDate: string | null;
  holdDays: number | null;
  entryTimeOfDay: string;
  realisedPnl: number | null;
  realisedReturnPct: number | null;
  outcome: "win" | "loss" | "scratch" | "open";
  signalAtEntry: Signal | null;
  scoreAtEntry: number | null;
  rMultiple: number | null;
  maePct: number | null;
  mfePct: number | null;
  excursionAvailable: boolean;
};

type JournalSummary = {
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  expectancyR: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  totalRealised: number;
  avgHoldDays: number | null;
  avgMaePct: number | null;
  avgMfePct: number | null;
  excursionCoverage: number;
  signalCoverage: number;
};

type JournalResponse = {
  trades: JournalTrade[];
  summary: JournalSummary;
  bySignal: TagStats[];
  bySector: TagStats[];
  byTimeOfDay: TagStats[];
  data: { hasDb: boolean; snapshotsUsed: boolean; excursionUsed: boolean };
};

type SlippageGroup = {
  tag: string;
  fills: number;
  meanBps: number | null;
  medianBps: number | null;
  bestBps: number | null;
  worstBps: number | null;
};

type ExecResponse = {
  overall: SlippageGroup;
  bySignal: SlippageGroup[];
  byTimeOfDay: SlippageGroup[];
  methodology: { reference: string; estimable: string; notEstimable: string };
  data: { hasExcursion: boolean; totalLegs: number };
};

const dash = "—";
function pct(v: number | null, sign = false): string {
  if (v == null) return dash;
  const s = sign && v > 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}
function rMult(v: number | null): string {
  if (v == null) return dash;
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(2)}R`;
}
function num(v: number | null, d = 1): string {
  return v == null ? dash : v.toFixed(d);
}
function bps(v: number | null): string {
  if (v == null) return dash;
  const s = v > 0 ? "+" : "";
  return `${s}${Math.round(v)} bps`;
}

function SignalBadge({ signal }: { signal: Signal }) {
  return <Badge variant={signalToVariant(signal)}>{STATUS_LABELS[signal]}</Badge>;
}

function TagTable({ rows, label }: { rows: TagStats[]; label: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No closed trades to group by {label.toLowerCase()} yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{label}</th>
            <th className="pb-2 px-2 text-right font-medium">n</th>
            <th className="pb-2 px-2 text-right font-medium">Win%</th>
            <th className="pb-2 px-2 text-right font-medium">Exp (R)</th>
            <th className="pb-2 px-2 text-right font-medium">Avg W</th>
            <th className="pb-2 px-2 text-right font-medium">Avg L</th>
            <th className="pb-2 px-2 text-right font-medium">PF</th>
            <th className="pb-2 px-2 text-right font-medium">MAE</th>
            <th className="pb-2 px-2 text-right font-medium">MFE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const known = row.tag in STATUS_LABELS;
            return (
              <tr key={row.tag} className="border-t border-border/50">
                <td className="py-1.5 pr-3">
                  {label === "Signal" && known ? (
                    <SignalBadge signal={row.tag as Signal} />
                  ) : (
                    <span className="font-medium">{row.tag}</span>
                  )}
                </td>
                <td className="px-2 text-right font-mono-nums">{row.trades}</td>
                <td className="px-2 text-right font-mono-nums">{pct(row.winRatePct)}</td>
                <td className={cn("px-2 text-right font-mono-nums", row.expectancyR != null && signedTextClass(row.expectancyR))}>
                  {rMult(row.expectancyR)}
                </td>
                <td className="px-2 text-right font-mono-nums [color:hsl(var(--positive))]">{pct(row.avgWinPct, true)}</td>
                <td className="px-2 text-right font-mono-nums [color:hsl(var(--negative))]">{pct(row.avgLossPct, true)}</td>
                <td className="px-2 text-right font-mono-nums">{num(row.profitFactor, 2)}</td>
                <td className="px-2 text-right font-mono-nums text-muted-foreground">{pct(row.avgMaePct)}</td>
                <td className="px-2 text-right font-mono-nums text-muted-foreground">{pct(row.avgMfePct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SlippageTable({ rows, label }: { rows: SlippageGroup[]; label: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No fills to group by {label.toLowerCase()}.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">{label}</th>
            <th className="pb-2 px-2 text-right font-medium">Fills</th>
            <th className="pb-2 px-2 text-right font-medium">Mean</th>
            <th className="pb-2 px-2 text-right font-medium">Median</th>
            <th className="pb-2 px-2 text-right font-medium">Best</th>
            <th className="pb-2 px-2 text-right font-medium">Worst</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const known = g.tag in STATUS_LABELS;
            return (
              <tr key={g.tag} className="border-t border-border/50">
                <td className="py-1.5 pr-3">
                  {label === "Signal" && known ? (
                    <SignalBadge signal={g.tag as Signal} />
                  ) : (
                    <span className="font-medium">{g.tag}</span>
                  )}
                </td>
                <td className="px-2 text-right font-mono-nums">{g.fills}</td>
                <td className={cn("px-2 text-right font-mono-nums", g.meanBps != null && signedTextClass(-g.meanBps))}>
                  {bps(g.meanBps)}
                </td>
                <td className="px-2 text-right font-mono-nums">{bps(g.medianBps)}</td>
                <td className="px-2 text-right font-mono-nums">{bps(g.bestBps)}</td>
                <td className="px-2 text-right font-mono-nums">{bps(g.worstBps)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-mono-nums text-lg font-bold", tone)}>{value}</p>
    </div>
  );
}

export function JournalPanel() {
  const [journal, setJournal] = React.useState<JournalResponse | null>(null);
  const [exec, setExec] = React.useState<ExecResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [j, e] = await Promise.all([
          fetch("/api/journal", { cache: "no-store" }).then((res) =>
            res.ok ? res.json() : Promise.reject(new Error(`journal ${res.status}`))
          ),
          fetch("/api/execution-stats", { cache: "no-store" }).then((res) =>
            res.ok ? res.json() : Promise.reject(new Error(`exec ${res.status}`))
          ),
        ]);
        if (!active) return;
        setJournal(j);
        setExec(e);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the trade journal.
        </CardContent>
      </Card>
    );
  }
  if (!journal || !exec) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading journal&hellip;</CardContent>
      </Card>
    );
  }

  const s = journal.summary;
  const totalClosed = s.closedTrades;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            Trade Journal &mdash; performance summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {totalClosed === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed round-trip trades yet. Trades appear here once a BUY is
              (partly) closed by a SELL. {s.openTrades} open position
              {s.openTrades === 1 ? "" : "s"} are tracked for live MAE/MFE below.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi label="Closed trades" value={String(totalClosed)} />
              <Kpi label="Win rate" value={pct(s.winRatePct)} />
              <Kpi
                label="Expectancy"
                value={rMult(s.expectancyR)}
                tone={s.expectancyR != null ? signedTextClass(s.expectancyR) : undefined}
              />
              <Kpi label="Avg win" value={pct(s.avgWinPct, true)} tone="[color:hsl(var(--positive))]" />
              <Kpi label="Avg loss" value={pct(s.avgLossPct, true)} tone="[color:hsl(var(--negative))]" />
              <Kpi
                label="Realised"
                value={formatUsd(s.totalRealised, { sign: true })}
                tone={signedTextClass(s.totalRealised)}
              />
              <Kpi label="Payoff (W/L)" value={num(s.payoffRatio, 2)} />
              <Kpi label="Profit factor" value={num(s.profitFactor, 2)} />
              <Kpi label="Avg hold (d)" value={num(s.avgHoldDays, 0)} />
              <Kpi label="Avg MAE" value={pct(s.avgMaePct)} />
              <Kpi label="Avg MFE" value={pct(s.avgMfePct)} />
              <Kpi label="Open" value={String(s.openTrades)} />
            </div>
          )}
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Young, sparse ledger &mdash; treat all figures as indicative, not
              statistically significant. MAE/MFE available for{" "}
              {s.excursionCoverage}/{totalClosed} closed trades; entry signal
              recovered for {s.signalCoverage}/{totalClosed}
              {journal.data.hasDb ? "" : " (no database — signals unavailable)"}.
            </span>
          </p>
        </CardContent>
      </Card>

      {/* [whatif] Sell-decision counterfactual — "what if I hadn't sold?" */}
      <WhatIfPanel />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Crosshair className="h-4 w-4 text-muted-foreground" />
            Edge by tag &mdash; win rate, expectancy &amp; MAE/MFE
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By signal at entry</p>
            <TagTable rows={journal.bySignal} label="Signal" />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By sector</p>
            <TagTable rows={journal.bySector} label="Sector" />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By entry time-of-day</p>
            <TagTable rows={journal.byTimeOfDay} label="Time" />
          </div>
          <p className="text-xs text-muted-foreground">
            Win% = wins / (wins + losses). Expectancy = mean R-multiple
            (R = realised return &divide; the trade&rsquo;s own MAE, the implied
            initial risk). PF = profit factor. MAE/MFE = avg max adverse /
            favourable excursion vs the entry fill, from Mboum daily highs &amp;
            lows.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            Execution &amp; slippage &mdash; fill vs same-day close
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {exec.data.totalLegs === 0 ? (
            <p className="text-sm text-muted-foreground">
              No fills with a same-day reference close yet (needs Mboum history
              for the fill date).
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Kpi label="Fills" value={String(exec.overall.fills)} />
                <Kpi
                  label="Mean slip"
                  value={bps(exec.overall.meanBps)}
                  tone={exec.overall.meanBps != null ? signedTextClass(-exec.overall.meanBps) : undefined}
                />
                <Kpi label="Median slip" value={bps(exec.overall.medianBps)} />
                <Kpi label="Best" value={bps(exec.overall.bestBps)} />
                <Kpi label="Worst" value={bps(exec.overall.worstBps)} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By signal at entry</p>
                <SlippageTable rows={exec.bySignal} label="Signal" />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By entry time-of-day</p>
                <SlippageTable rows={exec.byTimeOfDay} label="Time" />
              </div>
            </>
          )}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">What this can &amp; can&rsquo;t show</p>
            <p className="mt-1">{exec.methodology.reference}</p>
            <p className="mt-1">
              <span className="font-medium text-foreground">Estimable:</span>{" "}
              {exec.methodology.estimable}
            </p>
            <p className="mt-1">
              <span className="font-medium text-foreground">Not estimable:</span>{" "}
              {exec.methodology.notEstimable}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Trade log</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Ticker</th>
                <th className="pb-2 px-2 font-medium">Signal</th>
                <th className="pb-2 px-2 text-right font-medium">Entry</th>
                <th className="pb-2 px-2 text-right font-medium">Exit</th>
                <th className="pb-2 px-2 text-right font-medium">Hold</th>
                <th className="pb-2 px-2 text-right font-medium">Ret%</th>
                <th className="pb-2 px-2 text-right font-medium">R</th>
                <th className="pb-2 px-2 text-right font-medium">MAE</th>
                <th className="pb-2 px-2 text-right font-medium">MFE</th>
              </tr>
            </thead>
            <tbody>
              {journal.trades.map((t) => (
                <tr key={`${t.id}-${t.exitDate ?? "open"}`} className="border-t border-border/50">
                  <td className="py-1.5 pr-3">
                    <span className="font-mono-nums font-semibold">{t.ticker}</span>
                    {t.outcome === "open" && (
                      <Badge variant="neutral" className="ml-2 text-[10px]">open</Badge>
                    )}
                  </td>
                  <td className="px-2">
                    {t.signalAtEntry ? <SignalBadge signal={t.signalAtEntry} /> : <span className="text-muted-foreground">{dash}</span>}
                  </td>
                  <td className="px-2 text-right font-mono-nums">{formatUsd(t.entryPrice)}</td>
                  <td className="px-2 text-right font-mono-nums">{t.exitPrice != null ? formatUsd(t.exitPrice) : dash}</td>
                  <td className="px-2 text-right font-mono-nums">{t.holdDays != null ? `${t.holdDays}d` : dash}</td>
                  <td className={cn("px-2 text-right font-mono-nums", t.realisedReturnPct != null && signedTextClass(t.realisedReturnPct))}>
                    {pct(t.realisedReturnPct, true)}
                  </td>
                  <td className={cn("px-2 text-right font-mono-nums", t.rMultiple != null && signedTextClass(t.rMultiple))}>
                    {rMult(t.rMultiple)}
                  </td>
                  <td className="px-2 text-right font-mono-nums text-muted-foreground">{pct(t.maePct)}</td>
                  <td className="px-2 text-right font-mono-nums text-muted-foreground">{pct(t.mfePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {journal.trades.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No trades in the ledger yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
