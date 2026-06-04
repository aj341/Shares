"use client";

import {
  CheckCircle2,
  CircleSlash,
  ClipboardList,
  ScrollText,
  Scale,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { toneToVariant, type BadgeVariant } from "@/lib/ui";
import type { FactAlignment, ResearchStatus, StockVerdict } from "@/lib/types";

const ACTION_META: Record<
  StockVerdict["actionHint"],
  { label: string; variant: BadgeVariant }
> = {
  buy: { label: "Buy", variant: "positive" },
  hold: { label: "Hold", variant: "neutral" },
  trim: { label: "Trim", variant: "warning" },
  sell: { label: "Sell", variant: "negative" },
  no_change: { label: "No change", variant: "neutral" },
};

function impactLabel(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}

export function VerdictPanel({ verdict }: { verdict: StockVerdict }) {
  const action = ACTION_META[verdict.actionHint];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            Verdict
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={toneToVariant(verdict.verdict)}>
              {verdict.verdict[0].toUpperCase() + verdict.verdict.slice(1)}
            </Badge>
            <Badge variant="outline">Impact {impactLabel(verdict.impactScore)}</Badge>
            <Badge variant={action.variant}>{action.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1.5">
            {verdict.summaryBullets.map((b, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground/60" />
                <span>{b}</span>
              </li>
            ))}
          </ul>

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5" /> Thesis update
              </p>
              <p className="text-sm">{verdict.thesisUpdate}</p>
            </div>
            <div className="space-y-1">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Scale className="h-3.5 w-3.5" /> Market reaction
              </p>
              <p className="text-sm">{verdict.marketReactionView}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <StoryVsFinancials fact={verdict.factAlignment} />
        <ResearchStatusBlock research={verdict.researchStatus} />
      </div>
    </div>
  );
}

const ALIGNMENT_META: Record<
  FactAlignment["financialsSupportStory"],
  { label: string; variant: BadgeVariant }
> = {
  yes: { label: "Supported", variant: "positive" },
  partly: { label: "Partly", variant: "warning" },
  no: { label: "Not supported", variant: "negative" },
  unclear: { label: "Unclear", variant: "neutral" },
};

export function StoryVsFinancials({ fact }: { fact: FactAlignment }) {
  const meta = ALIGNMENT_META[fact.financialsSupportStory];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Scale className="h-4 w-4 text-muted-foreground" />
          Story vs Financials
        </CardTitle>
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{fact.notes}</p>
      </CardContent>
    </Card>
  );
}

const RESEARCH_META: Record<
  ResearchStatus["ourResearchComplete"],
  { label: string; variant: BadgeVariant }
> = {
  yes: { label: "Complete", variant: "positive" },
  partial: { label: "Partial", variant: "warning" },
  no: { label: "Not started", variant: "negative" },
};

export function ResearchStatusBlock({
  research,
}: {
  research: ResearchStatus;
}) {
  const meta = RESEARCH_META[research.ourResearchComplete];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          Research Status
        </CardTitle>
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </CardHeader>
      <CardContent>
        {research.recommendedFollowUp.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 [color:hsl(var(--positive))]" />
            No outstanding follow-ups.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {research.recommendedFollowUp.map((task, i) => (
              <li key={i} className={cn("flex gap-2 text-sm")}>
                <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>{task}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
