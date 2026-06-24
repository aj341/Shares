// [intraday] Intraday technicals + micro-regime panel. Additive, context-only
// UI — fetches /api/intraday and renders, per holding, the anchored-VWAP state
// (reclaim / lose / above / below), price-vs-VWAP %, ATR% with suggested stop,
// the VWAP±k·ATR bands, and the micro-regime (trend up/down / chop). It NEVER
// changes scores or signals; it is daily-trader orientation only and stays
// silent (renders nothing) when the overlay is unavailable.
"use client";

import * as React from "react";
import { Activity, TrendingUp, TrendingDown, Waves } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type MicroRegime = "trend_up" | "trend_down" | "chop";
type VwapState = "reclaim" | "lose" | "above" | "below" | "at" | null;

type Overlay = {
  vwap: number | null;
  anchoredVwap: number | null;
  priceVsVwapPct: number | null;
  vwapState: VwapState;
  atr: number | null;
  atrPct: number | null;
  suggestedStop: number | null;
  bands: { lower: number | null; upper: number | null } | null;
  microRegime: MicroRegime | null;
  adx: number | null;
  realizedVol: number | null;
  interval: string;
  bars: number;
};

type IntradayResponse = {
  session: "pre" | "regular" | "post" | "closed";
  interval: string;
  asOf: string;
  byTicker: Record<string, Overlay>;
};

const REGIME_META: Record<
  MicroRegime,
  { label: string; icon: typeof TrendingUp; cls: string }
> = {
  trend_up: {
    label: "Trend up",
    icon: TrendingUp,
    cls: "[color:hsl(var(--positive))] [background:hsl(var(--positive)/0.12)] [border-color:hsl(var(--positive)/0.30)]",
  },
  trend_down: {
    label: "Trend down",
    icon: TrendingDown,
    cls: "[color:hsl(var(--negative))] [background:hsl(var(--negative)/0.12)] [border-color:hsl(var(--negative)/0.30)]",
  },
  chop: {
    label: "Chop",
    icon: Waves,
    cls: "[color:hsl(38_92%_45%)] [background:hsl(38_92%_50%/0.12)] [border-color:hsl(38_92%_50%/0.30)]",
  },
};

function vwapStateChip(state: VwapState) {
  if (state == null) return <span className="text-muted-foreground">—</span>;
  const map: Record<NonNullable<VwapState>, string> = {
    reclaim: "[color:hsl(var(--positive))]",
    above: "[color:hsl(var(--positive))]",
    at: "text-muted-foreground",
    lose: "[color:hsl(var(--negative))]",
    below: "[color:hsl(var(--negative))]",
  };
  const labels: Record<NonNullable<VwapState>, string> = {
    reclaim: "Reclaim",
    above: "Above",
    at: "At",
    lose: "Lose",
    below: "Below",
  };
  return (
    <span className={cn("font-semibold", map[state])}>{labels[state]}</span>
  );
}

const pct = (v: number | null) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const pctCls = (v: number | null) =>
  v == null
    ? "text-muted-foreground"
    : v > 0
    ? "[color:hsl(var(--positive))]"
    : v < 0
    ? "[color:hsl(var(--negative))]"
    : "text-muted-foreground";
const px = (v: number | null) => (v == null ? "—" : v.toFixed(2));

export function IntradayPanel() {
  const [data, setData] = React.useState<IntradayResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/intraday-overlay", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  if (!data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> Intraday technicals
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-24 animate-pulse rounded-lg bg-muted/30" />
        </CardContent>
      </Card>
    );
  }

  const rows = Object.entries(data.byTicker)
    .filter(([, o]) => o && (o.anchoredVwap != null || o.atr != null))
    .sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" /> Intraday technicals
          <span className="ml-auto text-[11px] font-normal text-muted-foreground">
            VWAP · ATR · micro-regime · {data.interval} bars
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No intraday bars available
            {data.session === "closed" ? " (market closed)" : ""}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pl-2 pr-3 font-medium">Ticker</th>
                  <th className="px-3 py-2 font-medium">Regime</th>
                  <th className="px-3 py-2 font-medium">VWAP</th>
                  <th className="px-3 py-2 font-medium">vs VWAP</th>
                  <th className="px-3 py-2 font-medium">ATR%</th>
                  <th className="px-3 py-2 font-medium">Stop</th>
                  <th className="px-3 py-2 font-medium">Bands (L / U)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([ticker, o]) => {
                  const regime = o.microRegime
                    ? REGIME_META[o.microRegime]
                    : null;
                  const Icon = regime?.icon;
                  return (
                    <tr
                      key={ticker}
                      className="border-b border-border/30 last:border-0"
                    >
                      <td className="py-2 pl-2 pr-3 font-semibold">{ticker}</td>
                      <td className="px-3 py-2">
                        {regime && Icon ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                              regime.cls
                            )}
                          >
                            <Icon className="h-3 w-3" />
                            {regime.label}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono-nums">
                        {vwapStateChip(o.vwapState)}
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          {px(o.anchoredVwap)}
                        </span>
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 font-mono-nums",
                          pctCls(o.priceVsVwapPct)
                        )}
                      >
                        {pct(o.priceVsVwapPct)}
                      </td>
                      <td className="px-3 py-2 font-mono-nums text-muted-foreground">
                        {o.atrPct == null ? "—" : `${o.atrPct.toFixed(2)}%`}
                      </td>
                      <td className="px-3 py-2 font-mono-nums text-muted-foreground">
                        {px(o.suggestedStop)}
                      </td>
                      <td className="px-3 py-2 font-mono-nums text-[11px] text-muted-foreground">
                        {o.bands
                          ? `${px(o.bands.lower)} / ${px(o.bands.upper)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
