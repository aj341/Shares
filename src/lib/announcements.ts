import {
  MOCK_ANALYST,
  MOCK_ANNOUNCEMENTS,
  MOCK_VERDICTS,
  type AnalystView,
} from "@/lib/mock-data";
import type {
  Announcement,
  DisagreementRow,
  Signal,
  StatusTone,
  StockVerdict,
} from "@/lib/types";

/**
 * Announcement / verdict engine.
 *
 * In mock mode this serves the curated verdicts. The same functions are the
 * integration point for a live provider: synthesize Announcement[] from
 * company-news, then derive a StockVerdict and the Disagreement Scorecard row.
 */

export function getAnnouncements(ticker: string): Announcement[] {
  return MOCK_ANNOUNCEMENTS[ticker] ?? [];
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
