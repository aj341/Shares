"use client";

import * as React from "react";
import { ExternalLink, Zap, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  CatalystDirection,
  CatalystMateriality,
  CatalystType,
  CatalystsResult,
  NewsCatalyst,
} from "@/lib/catalysts";

/**
 * [news] Hard-catalyst feed. Additive panel that reads /api/catalysts and shows
 * ONLY AI-classified hard catalysts (earnings / guidance / M&A / regulatory-legal
 * / major-contract) at high or medium materiality, with type / direction /
 * materiality badges. Self-fetching so the dashboard-shell wiring stays minimal.
 */

const TYPE_LABEL: Record<CatalystType, string> = {
  earnings: "Earnings",
  guidance: "Guidance",
  m_and_a: "M&A",
  regulatory_legal: "Regulatory / Legal",
  major_contract: "Major Contract",
  none: "—",
};

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

const DIR_VARIANT: Record<CatalystDirection, BadgeVariant> = {
  bullish: "positive",
  bearish: "negative",
  neutral: "neutral",
};

const DIR_LABEL: Record<CatalystDirection, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

const MAT_VARIANT: Record<CatalystMateriality, BadgeVariant> = {
  high: "warning",
  medium: "brand",
  low: "neutral",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: CatalystsResult };

export function CatalystFeed() {
  const [state, setState] = React.useState<FetchState>({ status: "loading" });

  const load = React.useCallback(async () => {
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/catalysts", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as CatalystsResult;
      setState({ status: "ready", data });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Triaging news for hard catalysts…
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-6 text-sm text-muted-foreground">
          <span>Catalyst feed unavailable.</span>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 text-xs font-medium [color:hsl(var(--brand))] hover:underline"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  const { catalysts, classified } = state.data;

  if (catalysts.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {classified
            ? "No hard catalysts detected in recent news."
            : "Catalyst triage is offline (news or AI key not configured)."}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {catalysts.map((c) => (
        <CatalystRow key={c.id} item={c} />
      ))}
    </div>
  );
}

function CatalystRow({ item: c }: { item: NewsCatalyst }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md bg-muted p-1.5 text-muted-foreground">
            <Zap className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono-nums text-[10px]">
                {c.ticker}
              </Badge>
              {c.held && (
                <Badge variant="violet" className="text-[10px]">
                  Held
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px]">
                {TYPE_LABEL[c.catalystType]}
              </Badge>
              <Badge variant={DIR_VARIANT[c.direction]} className="text-[10px]">
                {DIR_LABEL[c.direction]}
              </Badge>
              <Badge variant={MAT_VARIANT[c.materiality]} className="text-[10px] capitalize">
                {c.materiality} materiality
              </Badge>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatDate(c.date)}
              </span>
            </div>
            <p className="mt-1 flex items-start gap-1.5 text-sm font-medium">
              {c.headline}
              {c.url && (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 text-muted-foreground hover:text-foreground"
                  title="Open source article"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </p>
            {c.why && (
              <p className={cn("mt-0.5 text-sm text-muted-foreground")}>
                <span className="font-medium text-foreground/70">Why: </span>
                {c.why}
              </p>
            )}
            <div className="mt-1 flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{c.source}</span>
              {c.url && (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium [color:hsl(var(--brand))] hover:underline"
                >
                  Read full article
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
