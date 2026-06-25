"use client";
// [riskgov] Risk Governor card — monitor + plain-English guidance only.
import * as React from "react";
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type RiskStatus = {
  level: "calm" | "elevated" | "high";
  realizedVolPct: number | null;
  baselineVolPct: number | null;
  drawdownPct: number | null;
  dayPnlPct: number | null;
  suggestedExposurePct: number | null;
  plainNote: string;
};

const META = {
  calm: { label: "Calm", Icon: ShieldCheck, cls: "[color:hsl(var(--positive))]" },
  elevated: { label: "Elevated", Icon: ShieldAlert, cls: "[color:hsl(var(--warning))]" },
  high: { label: "High", Icon: ShieldX, cls: "[color:hsl(var(--negative))]" },
} as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono-nums text-sm font-semibold">{value}</p>
    </div>
  );
}

export function RiskGovernorCard() {
  const [d, setD] = React.useState<RiskStatus | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    fetch("/api/risk-governor", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setD)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  const m = d ? META[d.level] : META.calm;
  const Icon = m.Icon;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={`h-4 w-4 ${m.cls}`} /> Risk governor
          <span className={`ml-auto text-xs font-bold ${m.cls}`}>{d ? m.label : "…"}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-snug text-muted-foreground">
          {d ? d.plainNote : "Reading your equity curve…"}
        </p>
        {d && (
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Vol now" value={d.realizedVolPct != null ? `${d.realizedVolPct}%` : "—"} />
            <Stat label="Usual" value={d.baselineVolPct != null ? `${d.baselineVolPct}%` : "—"} />
            <Stat label="Drawdown" value={d.drawdownPct != null ? `${d.drawdownPct}%` : "—"} />
            <Stat
              label="Suggested"
              value={d.suggestedExposurePct != null ? `${d.suggestedExposurePct}%` : "—"}
            />
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          Guidance only — the governor never blocks a trade or moves money.
        </p>
      </CardContent>
    </Card>
  );
}
