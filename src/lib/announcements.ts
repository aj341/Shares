import {
  MOCK_ANALYST,
  MOCK_ANNOUNCEMENTS,
  MOCK_VERDICTS,
  type AnalystView,
} from "@/lib/mock-data";
import * as finnhub from "@/lib/finnhub";
import { headlineKey, triageHeadlines } from "@/lib/news-triage";
import type {
  Announcement,
  AnnouncementType,
  DisagreementRow,
  Signal,
  StatusTone,
  StockVerdict,
} from "@/lib/types";

/**
 * Announcement / verdict engine.
 *
 * Curated mock announcements feed the SCORING engine (stable, documented).
 * For DISPLAY, getLiveAnnouncements pulls real, clickable company news from
 * Finnhub so users can open the full source article.
 */

export function getAnnouncements(ticker: string): Announcement[] {
  return MOCK_ANNOUNCEMENTS[ticker] ?? [];
}

// ---------------------------------------------------------------------------
// Live company news (Finnhub) → Announcement[] with source URLs
// ---------------------------------------------------------------------------

const POS_RE = /\b(beat|beats|surge|soar|jump|rally|record|raise[ds]?|upgrade[ds]?|outperform|growth|strong|win|wins|gain|gains|bullish|breakthrough|approval|expand|accelerat|profit)\w*/gi;
const NEG_RE = /\b(miss|misses|plunge|drop|slump|fall|falls|decline|cut|cuts|downgrade[ds]?|lawsuit|probe|investigat|recall|warn|warning|weak|loss|losses|bearish|layoff|halt|delay|slowdown|risk)\w*/gi;

function classifyType(text: string): AnnouncementType {
  if (/\b(earnings|eps|quarter|revenue|guidance|results)\b/i.test(text)) return "earnings";
  if (/\b(analyst|rating|price target|upgrade|downgrade|initiat|overweight|underweight)\b/i.test(text))
    return "analyst";
  if (/\b(launch|unveil|release|product|partnership|deal|acquisition|acquire)\b/i.test(text))
    return "product";
  if (/\b(sec|filing|8-k|10-q|10-k|prospectus)\b/i.test(text)) return "filing";
  if (/\b(fed|inflation|tariff|interest rate|macro|recession)\b/i.test(text)) return "macro";
  return "other";
}

function scoreImpact(text: string): { impact: StatusTone; impactScore: number } {
  const pos = (text.match(POS_RE) || []).length;
  const neg = (text.match(NEG_RE) || []).length;
  const net = pos - neg;
  const impactScore = Math.max(-3, Math.min(3, Math.round(net / 2)));
  const impact: StatusTone = net > 0 ? "positive" : net < 0 ? "negative" : "neutral";
  return { impact, impactScore };
}

/** Finnhub tags news under the primary listing — map share-class variants. */
const NEWS_SYMBOL_ALIAS: Record<string, string> = { GOOG: "GOOGL" };

/** Real recent company news as Announcement[] (newest first). Empty on failure. */
export async function getLiveAnnouncements(ticker: string): Promise<Announcement[]> {
  if (!finnhub.isFinnhubConfigured()) return [];
  const sym = NEWS_SYMBOL_ALIAS[ticker] ?? ticker;
  const now = new Date();
  const from = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  const news = await finnhub.getCompanyNews(sym, from, to);
  if (!news || news.length === 0) return [];

  const relevant = news.filter((n) => {
    const rel = (n.related || "").toUpperCase().split(/[,\s]+/);
    return rel.includes(sym) || new RegExp(`\\b${sym}\\b`).test(n.headline);
  });
  // Prefer ticker-relevant items; fall back to all news only if none matched.
  const pool = relevant.length > 0 ? relevant : news;

  const seen = new Set<string>();
  const announcements = pool
    .filter((n) => n.headline && (seen.has(n.headline) ? false : (seen.add(n.headline), true)))
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 8)
    .map((n) => {
      const text = `${n.headline} ${n.summary ?? ""}`;
      const { impact, impactScore } = scoreImpact(text);
      return {
        date: new Date(n.datetime * 1000).toISOString().slice(0, 10),
        title: n.headline,
        source: n.source || "News",
        type: classifyType(text),
        url: n.url,
        summary: n.summary?.trim() || n.headline,
        impact,
        impactScore,
      };
    });

  // LLM triage (cached per headline) replaces the regex score wherever it
  // succeeds — the regex above is only the fallback. This score gates the
  // score-cap override and the FULL_SELL trigger, so accuracy matters.
  const triaged = await triageHeadlines(
    ticker,
    announcements.map((a) => ({ url: a.url, title: a.title, summary: a.summary }))
  ).catch(() => null);
  if (triaged) {
    for (const a of announcements) {
      const t = triaged.get(headlineKey(a.url, a.title));
      if (t) {
        a.impactScore = t.impactScore;
        a.impact = t.impactScore > 0 ? "positive" : t.impactScore < 0 ? "negative" : "neutral";
      }
    }
  }
  return announcements;
}

export function getVerdict(ticker: string): StockVerdict {
  return (
    MOCK_VERDICTS[ticker] ?? {
      summaryBullets: ["No recent material announcements detected."],
      verdict: "neutral",
      impactScore: 0,
      thesisUpdate: "No change to thesis.",
      marketReactionView: "No notable market reaction.",
      actionHint: "no_change",
      execCommentary: { hasExecComments: false, tone: "no_signal", keyPoints: [] },
      factAlignment: { financialsSupportStory: "unclear", notes: "Insufficient data." },
      researchStatus: { ourResearchComplete: "no", recommendedFollowUp: ["Begin coverage."] },
    }
  );
}

export function getAnalystView(ticker: string): AnalystView {
  return MOCK_ANALYST[ticker] ?? { consensus: "neutral", targetUpsidePct: null };
}

/** Most negative announcement impact for a ticker (used by the scoring engine). */
export function minAnnouncementImpact(announcements: Announcement[]): number {
  if (announcements.length === 0) return 0;
  return announcements.reduce((min, a) => Math.min(min, a.impactScore), 0);
}

// ---------------------------------------------------------------------------
// Disagreement Scorecard
// ---------------------------------------------------------------------------

/** Map a StatusTone verdict to a numeric axis for comparison. */
function verdictAxis(v: StatusTone): number {
  return v === "positive" ? 1 : v === "negative" ? -1 : 0;
}

function consensusAxis(c: AnalystView["consensus"]): number {
  switch (c) {
    case "bullish":
      return 1;
    case "bearish":
      return -1;
    case "mixed":
    case "neutral":
    default:
      return 0;
  }
}

function signalAxis(signal: Signal): number {
  switch (signal) {
    case "STRONG_BUY":
    case "BUY":
      return 1;
    case "SELL":
    case "TRIM":
      return -1;
    default:
      return 0;
  }
}

export function buildDisagreementRow(args: {
  ticker: string;
  verdict: StockVerdict;
  analyst: AnalystView;
  ourScore: number;
  ourSignal: Signal;
}): DisagreementRow {
  const { ticker, verdict, analyst, ourScore, ourSignal } = args;

  const axes = [
    verdictAxis(verdict.verdict),
    consensusAxis(analyst.consensus),
    signalAxis(ourSignal),
  ];

  // Spread across the three opinion axes drives the disagreement level.
  const spread = Math.max(...axes) - Math.min(...axes);
  const execContradicts =
    verdict.execCommentary.tone === "contradictory" ||
    verdict.execCommentary.tone === "promotional";

  let level: DisagreementRow["disagreementLevel"];
  if (spread >= 2) level = "high";
  else if (spread === 1 || execContradicts) level = "medium";
  else level = "low";

  const notes = buildDisagreementNotes({
    verdict,
    analyst,
    ourSignal,
    level,
  });

  return {
    ticker,
    companyVerdict: verdict.verdict,
    companyImpactScore: verdict.impactScore,
    execTone: verdict.execCommentary.tone,
    analystConsensus: analyst.consensus,
    analystTargetUpsidePct: analyst.targetUpsidePct,
    ourScore,
    ourSignal,
    disagreementLevel: level,
    disagreementNotes: notes,
  };
}

function buildDisagreementNotes(args: {
  verdict: StockVerdict;
  analyst: AnalystView;
  ourSignal: Signal;
  level: DisagreementRow["disagreementLevel"];
}): string {
  const { verdict, analyst, ourSignal, level } = args;
  const parts: string[] = [];

  if (level === "low") {
    parts.push("Company verdict, analysts and our signal broadly agree.");
  } else {
    parts.push(
      `Company verdict ${verdict.verdict}, analysts ${analyst.consensus}, our signal ${ourSignal}.`
    );
  }

  if (analyst.targetUpsidePct !== null && analyst.targetUpsidePct < 0) {
    parts.push("Price sits above the mean analyst target.");
  }

  if (verdict.execCommentary.tone === "promotional") {
    parts.push("Exec tone is promotional — discount management optimism.");
  } else if (verdict.execCommentary.tone === "contradictory") {
    parts.push("Exec commentary contradicts the reported numbers.");
  } else if (verdict.execCommentary.tone === "cautious") {
    parts.push("Management tone is cautious.");
  }

  if (verdict.factAlignment.financialsSupportStory === "no") {
    parts.push("Financials do not yet support the narrative.");
  } else if (verdict.factAlignment.financialsSupportStory === "partly") {
    parts.push("Financials only partly support the narrative.");
  }

  return parts.join(" ");
}
