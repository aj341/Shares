// [regime] Compact market-regime / breadth banner. Additive, context-only UI —
// fetches /api/regime and renders the overall posture (risk-on/neutral/risk-off)
// with a short descriptor, QQQ/SPY trend chips, breadth (% of sector ETFs above
// their 50d MA), realized-vol state, and leading/lagging sectors. It NEVER
// changes scores or signals; it sits above the dashboard as orientation.
"use client";

import * as React from "react";
import { Compass, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

type Posture = "risk_on" | "neutral" | "risk_off";

type SectorStrength = {
  etf: string;
  label: string;
  vs50: number | null;
  rs: number | null;
};

type RegimeAssessment = {
  regime: Posture;
  descriptor: string;
  qqqVs50: number | null;
  qqqVs200: number | null;
  spyVs50: number | null;
  spyVs200: number | null;
  realizedVol: number | null;
  realizedVolRising: boolean | null;
  realizedVolPctile: number | null;
  breadthPctAbove50: number | null;
  sectorsCovered: number;
  leadingSectors: SectorStrength[];
  laggingSectors: SectorStrength[];
  asOf: string;
};

const POSTURE_META: Record<
  Posture,
  { label: string; icon: typeof TrendingUp; cls: string }
> = {
  risk_on: {
    label: "Risk-on",
    icon: TrendingUp,
    cls: "[color:hsl(var(--positive))] [background:hsl(var(--positive)/0.12)] [border-color:hsl(var(--positive)/0.30)]",
  },
  neutral: {
    label: "Neutral",
    icon: Minus,
    cls: "[color:hsl(38_92%_45%)] [background:hsl(38_92%_50%/0.12)] [border-color:hsl(38_92%_50%/0.30)]",
  },
  risk_off: {
    label: "Risk-off",
    icon: TrendingDown,
    cls: "[color:hsl(var(--negative))] [background:hsl(var(--negative)/0.12)] [border-color:hsl(var(--negative)/0.30)]",
  },
};

const signed = (v: number | null) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

const signedCls = (v: number | null) =>
  v == null
    ? "text-muted-foreground"
    : v > 0
    ? "[color:hsl(var(--positive))]"
    : v < 0
    ? "[color:hsl(var(--negative))]"
    : "text-muted-foreground";

export function RegimeBanner() {
  const [data, setData] = React.useState<RegimeAssessment | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/regime", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  // Stay silent (additive, non-blocking) if the overlay can't load.
  if (failed) return null;

  if (!data) {
    return (
      <div className="h-[58px] animate-pulse rounded-xl border border-border/60 bg-muted/30" />
    );
  }

  const meta = POSTURE_META[data.regime];
  const Icon = meta.icon;
  const breadth = data.breadthPctAbove50;

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 shadow-sm sm:px-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Compass className="h-4 w-4" />
          Market regime
        </span>

        <span
          className={cn(
            "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
            meta.cls
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {meta.label}
        </span>

        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {data.descriptor}
        </span>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <Chip label="QQQ 50/200d">
            <span className={signedCls(data.qqqVs50)}>{signed(data.qqqVs50)}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className={signedCls(data.qqqVs200)}>{signed(data.qqqVs200)}</span>
          </Chip>
          <Chip label="SPY 50/200d">
            <span className={signedCls(data.spyVs50)}>{signed(data.spyVs50)}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className={signedCls(data.spyVs200)}>{signed(data.spyVs200)}</span>
          </Chip>
          <Chip label="Breadth >50d">
            <span
              className={cn(
                "font-semibold",
                breadth == null
                  ? "text-muted-foreground"
                  : breadth >= 60
                  ? "[color:hsl(var(--positive))]"
                  : breadth <= 40
                  ? "[color:hsl(var(--negative))]"
                  : "[color:hsl(38_92%_45%)]"
              )}
            >
              {breadth == null ? "—" : `${breadth}%`}
            </span>
          </Chip>
          {data.realizedVolPctile != null ? (
            <Chip label="Vol pctile">
              <span
                className={cn(
                  data.realizedVolPctile >= 80
                    ? "[color:hsl(var(--negative))]"
                    : data.realizedVolPctile <= 40
                    ? "[color:hsl(var(--positive))]"
                    : "text-muted-foreground"
                )}
              >
                {data.realizedVolPctile}
                {data.realizedVolRising ? " ↑" : ""}
              </span>
            </Chip>
          ) : null}
        </div>
      </div>

      {(data.leadingSectors.length > 0 || data.laggingSectors.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/40 pt-2 text-[11px]">
          {data.leadingSectors.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Leading</span>
              {data.leadingSectors.map((s) => (
                <SectorChip key={`lead-${s.etf}`} s={s} positive />
              ))}
            </span>
          )}
          {data.laggingSectors.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Lagging</span>
              {data.laggingSectors.map((s) => (
                <SectorChip key={`lag-${s.etf}`} s={s} positive={false} />
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1 rounded-md bg-muted/40 px-1.5 py-0.5 font-mono-nums">
      <span className="text-muted-foreground/80">{label}</span>
      {children}
    </span>
  );
}

function SectorChip({ s, positive }: { s: SectorStrength; positive: boolean }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 font-mono-nums",
        positive
          ? "[color:hsl(var(--positive))] [background:hsl(var(--positive)/0.10)]"
          : "[color:hsl(var(--negative))] [background:hsl(var(--negative)/0.10)]"
      )}
      title={s.label}
    >
      {s.etf}
      {s.rs != null ? ` ${s.rs > 0 ? "+" : ""}${(s.rs * 100).toFixed(1)}%` : ""}
    </span>
  );
}
