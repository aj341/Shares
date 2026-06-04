"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Gauge,
  Link2,
  Loader2,
  Newspaper,
  Scale,
  ScrollText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { analyzeArticle } from "@/lib/client";
import type { ArticleImpactAnalysis } from "@/lib/types";
import type { BadgeVariant } from "@/lib/ui";

const VERDICT_VARIANT: Record<string, BadgeVariant> = {
  positive: "positive",
  negative: "negative",
  neutral: "neutral",
  mixed: "warning",
};
const TONE_LABEL: Record<string, string> = {
  aligned: "Aligned",
  cautious: "Cautious",
  promotional: "Promotional",
  contradictory: "Contradictory",
  no_signal: "No signal",
};
const ALIGN_VARIANT: Record<string, BadgeVariant> = {
  yes: "positive",
  partly: "warning",
  no: "negative",
  unclear: "neutral",
};
const THESIS_LABEL: Record<string, string> = {
  confirming: "Confirming thesis",
  incremental: "Incremental",
  material: "Materially thesis-changing",
  overhyped: "Likely overhyped",
  underappreciated: "Underappreciated",
};

export function ArticleAnalyzer() {
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ArticleImpactAnalysis | null>(null);

  const run = async (overrideTicker?: string) => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await analyzeArticle(url.trim(), overrideTicker);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Newspaper className="h-4 w-4 [color:hsl(var(--brand))]" />
            Article Impact Analyzer
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Paste a news/article URL. We extract it, detect the ticker, contrast the story
            against our data, and return a likely share-price impact. Not financial advice.
          </p>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.example.com/news/article"
                className="pl-9"
              />
            </div>
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Analyze
            </Button>
          </form>
          {error && (
            <p className="mt-3 flex items-center gap-2 rounded-md bg-negative-muted px-3 py-2 text-sm [color:hsl(var(--negative))]">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
            </p>
          )}
        </CardContent>
      </Card>

      {busy && !result && (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading and analyzing the article…
          </CardContent>
        </Card>
      )}

      {result && <Result data={result} onPickTicker={(t) => run(t)} busy={busy} />}
    </div>
  );
}

function Result({
  data,
  onPickTicker,
  busy,
}: {
  data: ArticleImpactAnalysis;
  onPickTicker: (t: string) => void;
  busy: boolean;
}) {
  const ia = data.impactAssessment;
  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{data.source ?? "Source"}</span>
            {data.publishDate && <span>· {new Date(data.publishDate).toLocaleDateString("en-AU")}</span>}
            {data.author && <span>· {data.author}</span>}
            {data.engine === "heuristic" && (
              <Badge variant="outline" className="ml-auto text-[10px]">Heuristic mode</Badge>
            )}
          </div>
          <h3 className="text-lg font-semibold leading-snug">{data.headline}</h3>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Ticker:</span>
            {data.detectedTickers.length === 0 && (
              <span className="text-xs text-muted-foreground">none detected</span>
            )}
            {data.detectedTickers.map((t) => (
              <button key={t} type="button" disabled={busy} onClick={() => onPickTicker(t)}>
                <Badge variant={t === data.selectedTicker ? "brand" : "secondary"} className="font-mono-nums">
                  {t}
                </Badge>
              </button>
            ))}
            <span className="ml-auto flex items-center gap-2">
              <Badge variant={VERDICT_VARIANT[ia.verdict]} className="gap-1">
                <Gauge className="h-3 w-3" />
                Impact {ia.impactScore > 0 ? `+${ia.impactScore}` : ia.impactScore}
              </Badge>
              <Badge variant="outline" className="capitalize">{ia.confidence} confidence</Badge>
              <Badge variant="neutral" className="gap-1">
                <Clock className="h-3 w-3" />
                {ia.timeHorizon.replace("_", " ")}
              </Badge>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Impact assessment */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScrollText className="h-4 w-4 text-muted-foreground" /> Price Impact Assessment
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={VERDICT_VARIANT[ia.verdict]} className="capitalize">{ia.verdict}</Badge>
            <Badge variant="outline" className="capitalize">{ia.expectedMarketSensitivity} sensitivity</Badge>
            <Badge variant="brand" className="capitalize">{ia.actionHint}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{ia.rationale}</p>
        </CardContent>
      </Card>

      {/* Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Article Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            {data.summaryBullets.map((b, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground/60" />
                {b}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Executive sentiment */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm">Executive Sentiment</CardTitle>
            <Badge
              variant={
                data.executiveSentiment.tone === "aligned"
                  ? "positive"
                  : data.executiveSentiment.tone === "contradictory"
                    ? "negative"
                    : data.executiveSentiment.tone === "no_signal"
                      ? "neutral"
                      : "warning"
              }
            >
              {TONE_LABEL[data.executiveSentiment.tone]}
            </Badge>
          </CardHeader>
          <CardContent>
            {!data.executiveSentiment.hasExecComments ? (
              <p className="text-sm text-muted-foreground">No executive commentary detected.</p>
            ) : (
              <ul className="space-y-2">
                {data.executiveSentiment.keyPoints.map((p, i) => (
                  <li key={i} className="text-sm text-muted-foreground">“{p}”</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Story vs financials */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Scale className="h-4 w-4 text-muted-foreground" /> Story vs Financials
            </CardTitle>
            <Badge variant={ALIGN_VARIANT[data.storyVsFinancials.financialsSupportStory]} className="capitalize">
              {data.storyVsFinancials.financialsSupportStory}
            </Badge>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{data.storyVsFinancials.notes}</p>
          </CardContent>
        </Card>
      </div>

      {/* Outside research */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">Outside Research Contrast</CardTitle>
          <Badge variant="violet">{THESIS_LABEL[data.outsideResearch.thesisChange]}</Badge>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide [color:hsl(var(--positive))]">Supporting</p>
            {data.outsideResearch.supportingPoints.length ? (
              <ul className="space-y-1.5">
                {data.outsideResearch.supportingPoints.map((p, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 [color:hsl(var(--positive))]" />
                    {p}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide [color:hsl(var(--negative))]">Conflicting</p>
            {data.outsideResearch.conflictingPoints.length ? (
              <ul className="space-y-1.5">
                {data.outsideResearch.conflictingPoints.map((p, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 [color:hsl(var(--negative))]" />
                    {p}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Follow-up */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recommended Follow-up</CardTitle>
        </CardHeader>
        <CardContent>
          <Separator className="mb-3" />
          <ul className="space-y-1.5">
            {data.followUp.map((f, i) => (
              <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {f}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
