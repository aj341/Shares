import "server-only";
import { extractArticle } from "@/lib/article-extractor";
import { detectTickers } from "@/lib/ticker-detection";
import { analyzeArticleWithLLM, isLlmConfigured, type LlmAnalysis } from "@/lib/llm";
import { buildPortfolio } from "@/lib/portfolio";
import { getAnnouncements, getVerdict, minAnnouncementImpact } from "@/lib/announcements";
import { buildStockTechnicals } from "@/lib/technicals";
import { isMboumConfigured } from "@/lib/mboum";
import { saveAnalysis, listAnalyses } from "@/lib/analyzer-store";
import type {
  ArticleImpactAnalysis,
  ExtractedArticle,
  Holding,
  ImpactScore,
  StockTechnicals,
} from "@/lib/types";

/**
 * Article Impact Analyzer pipeline:
 * extract → detect ticker → gather the app's existing research data
 * (scoring, verdict, announcements, Mboum analyst targets + technicals) →
 * synthesize a structured verdict via Claude (if configured) or a transparent
 * heuristic. Reuses existing research modules; nothing fabricated.
 */

type Ctx = {
  holding: Holding | null;
  tech: StockTechnicals | null;
  verdictAlignment: "yes" | "partly" | "no" | "unclear";
  contextString: string;
};

async function gatherContext(ticker: string): Promise<Ctx> {
  const [portfolio, tech] = await Promise.all([
    buildPortfolio().catch(() => null),
    isMboumConfigured() ? buildStockTechnicals(ticker).catch(() => null) : Promise.resolve(null),
  ]);
  const holding = portfolio?.holdings.find((h) => h.ticker === ticker) ?? null;
  const verdict = getVerdict(ticker);
  const announcements = getAnnouncements(ticker);

  const lines: string[] = [];
  if (holding) {
    lines.push(
      `Held position: ${holding.shares} shares, score ${holding.score}/100, signal ${holding.signal}, ` +
        `weight ${holding.portfolioWeight}%, unrealised ${holding.unrealisedPnlPct}%.`
    );
    lines.push(`Our verdict: ${verdict.verdict} (impact ${verdict.impactScore}). ${verdict.thesisUpdate}`);
    lines.push(
      `Story-vs-financials (ours): ${verdict.factAlignment.financialsSupportStory} — ${verdict.factAlignment.notes}`
    );
    const neg = holding.metrics.filter((m) => m.status === "negative").map((m) => m.name);
    const pos = holding.metrics.filter((m) => m.status === "positive").map((m) => m.name);
    lines.push(`Positive metrics: ${pos.slice(0, 5).join(", ") || "none"}.`);
    lines.push(`Negative metrics: ${neg.slice(0, 5).join(", ") || "none"}.`);
  } else {
    lines.push(`${ticker} is not currently held in the portfolio.`);
  }
  if (tech) {
    lines.push(
      `Technicals: RSI ${tech.rsi ?? "n/a"}, price vs 20d MA ${tech.priceVsMa20 ?? "n/a"}, ` +
        `vs 50d MA ${tech.priceVsMa50 ?? "n/a"}.`
    );
    lines.push(
      `Analyst: target ${tech.targetMean ?? "n/a"} (${tech.targetUpsidePct ?? "n/a"}% upside), ` +
        `consensus ${tech.analystConsensus ?? "n/a"}, ${tech.bullishPct ?? "n/a"}% bullish.`
    );
  }
  if (announcements.length) {
    lines.push(
      `Recent announcements: ` +
        announcements
          .slice(0, 3)
          .map((a) => `${a.title} (impact ${a.impactScore})`)
          .join("; ")
    );
  }

  return {
    holding,
    tech,
    verdictAlignment: holding ? verdict.factAlignment.financialsSupportStory : "unclear",
    contextString: lines.join("\n"),
  };
}

export async function analyzeArticle(
  url: string,
  overrideTicker?: string
): Promise<ArticleImpactAnalysis> {
  const article = await extractArticle(url);
  const detection = detectTickers(article.headline, article.body);
  const selectedTicker = (overrideTicker || detection.primary || "").toUpperCase();

  const createdAt = new Date().toISOString();
  const head: Pick<
    ArticleImpactAnalysis,
    "url" | "canonicalUrl" | "source" | "headline" | "publishDate" | "author" | "detectedTickers" | "selectedTicker" | "createdAt"
  > = {
    url: article.url,
    canonicalUrl: article.canonicalUrl,
    source: article.source,
    headline: article.headline,
    publishDate: article.publishDate,
    author: article.author,
    detectedTickers: detection.detected,
    selectedTicker,
    createdAt,
  };

  if (!selectedTicker) {
    // No ticker found — return a low-confidence neutral shell.
    return {
      ...head,
      summaryBullets: summarize(article.body),
      executiveSentiment: detectExecSentiment(article.body),
      storyVsFinancials: { financialsSupportStory: "unclear", notes: "No company/ticker detected in the article." },
      outsideResearch: { thesisChange: "incremental", supportingPoints: [], conflictingPoints: [] },
      impactAssessment: {
        verdict: "neutral",
        impactScore: 0,
        timeHorizon: "short_term",
        expectedMarketSensitivity: "low",
        confidence: "low",
        actionHint: "watch",
        rationale: "No specific ticker could be identified, so no stock-level impact can be assessed.",
      },
      followUp: ["Specify the ticker manually if the article discusses a holding."],
      engine: "heuristic",
    };
  }

  const ctx = await gatherContext(selectedTicker);

  // Prefer LLM synthesis when configured; fall back to heuristic.
  let body: LlmAnalysis | null = null;
  if (isLlmConfigured()) {
    body = await analyzeArticleWithLLM({
      ticker: selectedTicker,
      headline: article.headline,
      source: article.source,
      articleBody: article.body,
      context: ctx.contextString,
    });
  }

  if (body) {
    return { ...head, ...body, impactAssessment: clampImpact(body.impactAssessment), engine: "llm" };
  }

  return { ...head, ...heuristicAnalysis(article, selectedTicker, ctx), engine: "heuristic" };
}

// ---------------------------------------------------------------------------
// Heuristic fallback (transparent, sourced)
// ---------------------------------------------------------------------------

const POSITIVE = /\b(record|surge|soar|beat|beats|growth|strong|expand|accelerat|raised|upgrade|outperform|bullish|win|wins|breakthrough|profit|gain)\w*/gi;
const NEGATIVE = /\b(miss|misses|fall|falls|plunge|drop|decline|weak|cut|cuts|downgrade|lawsuit|probe|recall|warn|warning|loss|losses|slow|slowdown|risk|bearish|layoff)\w*/gi;
const CAUTION = /\b(caution|uncertain|headwind|pressure|challeng|soften|slow)\w*/gi;
const PROMO = /\b(revolutionary|unprecedented|game-?changer|massive|explosive|skyrocket|record-breaking)\w*/gi;

function count(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

function summarize(body: string): string[] {
  const sentences = body
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 320);
  const scored = sentences.map((s) => ({
    s,
    score: count(s, POSITIVE) + count(s, NEGATIVE) + (/\d/.test(s) ? 1 : 0) + (/%|\$/.test(s) ? 1 : 0),
  }));
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.s);
}

function detectExecSentiment(body: string): ArticleImpactAnalysis["executiveSentiment"] {
  const sentences = body.split(/(?<=[.!?])\s+/);
  const execRe = /\b(CEO|CFO|COO|chief executive|chief financial|founder|president|chairman|spokesperson)\b/i;
  const quoteish = /[""].{15,}["”]|\bsaid\b|\bsaid in\b|\btold\b|\baccording to\b/i;
  const execLines = sentences.filter((s) => execRe.test(s) && (quoteish.test(s) || /said|added|noted/i.test(s)));
  const hasExecComments = execLines.length > 0;
  const text = execLines.join(" ");
  const promo = count(text, PROMO) + count(text, POSITIVE);
  const caution = count(text, CAUTION) + count(text, NEGATIVE);
  let tone: ArticleImpactAnalysis["executiveSentiment"]["tone"] = "no_signal";
  if (hasExecComments) {
    if (count(text, PROMO) >= 1) tone = "promotional";
    else if (caution > promo) tone = "cautious";
    else if (promo > 0 && caution > 0) tone = "contradictory";
    else tone = "aligned";
  }
  return { hasExecComments, tone, keyPoints: execLines.slice(0, 3).map((s) => s.trim()) };
}

function heuristicAnalysis(
  article: ExtractedArticle,
  ticker: string,
  ctx: Ctx
): LlmAnalysis {
  const pos = count(article.body, POSITIVE);
  const neg = count(article.body, NEGATIVE);
  const net = pos - neg;
  const verdict: ArticleImpactAnalysis["impactAssessment"]["verdict"] =
    pos > 0 && neg > 0 && Math.abs(net) <= 2 ? "mixed" : net > 1 ? "positive" : net < -1 ? "negative" : "neutral";
  const impactScore = clampScore(Math.round(net / 3));

  const supporting: string[] = [];
  const conflicting: string[] = [];
  if (ctx.tech?.targetUpsidePct != null) {
    (ctx.tech.targetUpsidePct >= 0 ? supporting : conflicting).push(
      `Analyst mean target implies ${ctx.tech.targetUpsidePct >= 0 ? "+" : ""}${Math.round(ctx.tech.targetUpsidePct)}% vs current price.`
    );
  }
  if (ctx.tech?.rsi != null) {
    if (ctx.tech.rsi > 70) conflicting.push(`RSI ${ctx.tech.rsi} — already overbought, limits near-term upside.`);
    else if (ctx.tech.rsi < 35) supporting.push(`RSI ${ctx.tech.rsi} — oversold, room to recover.`);
  }
  if (ctx.holding) {
    supporting.push(`Our model scores ${ticker} ${ctx.holding.score}/100 (${ctx.holding.signal}).`);
  }

  const thesisChange: ArticleImpactAnalysis["outsideResearch"]["thesisChange"] =
    Math.abs(net) >= 5 ? "material" : count(article.body, PROMO) >= 2 ? "overhyped" : Math.abs(net) >= 2 ? "incremental" : "confirming";

  return {
    summaryBullets: summarize(article.body),
    executiveSentiment: detectExecSentiment(article.body),
    storyVsFinancials: {
      financialsSupportStory: ctx.verdictAlignment,
      notes: ctx.holding
        ? `Based on our existing data for ${ticker} (score ${ctx.holding.score}, ${ctx.holding.signal}). ${getVerdict(ticker).factAlignment.notes}`
        : `${ticker} is not held, so this is judged on market data only — treat as unclear.`,
    },
    outsideResearch: { thesisChange, supportingPoints: supporting, conflictingPoints: conflicting },
    impactAssessment: {
      verdict,
      impactScore,
      timeHorizon: Math.abs(net) >= 5 ? "medium_term" : "short_term",
      expectedMarketSensitivity: Math.abs(impactScore) >= 2 ? "high" : Math.abs(impactScore) === 1 ? "medium" : "low",
      confidence: "low", // heuristic mode is intentionally conservative
      actionHint: verdict === "positive" ? "watch" : verdict === "negative" ? "trim" : "hold",
      rationale: `Heuristic read: article tone is ${verdict} (${pos} positive vs ${neg} negative signals). ${
        ctx.holding ? `Cross-checked against our ${ctx.holding.signal} signal.` : "Ticker not held."
      } Enable ANTHROPIC_API_KEY for a deeper, reasoned analysis.`,
    },
    followUp: [
      "Monitor the next earnings call for confirmation.",
      "Confirm any guidance revision implied by the article.",
      "Watch margin and demand commentary from management.",
      "Compare with peer commentary and analyst reactions.",
    ],
  };
}

// helpers --------------------------------------------------------------------

function clampScore(n: number): ImpactScore {
  return Math.max(-3, Math.min(3, n)) as ImpactScore;
}

function clampImpact(
  a: ArticleImpactAnalysis["impactAssessment"]
): ArticleImpactAnalysis["impactAssessment"] {
  return { ...a, impactScore: clampScore(Math.round(a.impactScore)) };
}

// ---------------------------------------------------------------------------
// History — persisted to Postgres when available, with an in-memory fallback
// (so it still works locally without a DB).
// ---------------------------------------------------------------------------

const HISTORY: ArticleImpactAnalysis[] = [];

export async function recordHistory(a: ArticleImpactAnalysis): Promise<void> {
  HISTORY.unshift(a);
  if (HISTORY.length > 25) HISTORY.length = 25;
  await saveAnalysis(a).catch(() => {});
}

export async function getHistory(): Promise<ArticleImpactAnalysis[]> {
  const db = await listAnalyses(25).catch(() => [] as ArticleImpactAnalysis[]);
  return db.length ? db : HISTORY;
}
