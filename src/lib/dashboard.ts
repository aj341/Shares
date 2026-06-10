import {
  buildPortfolio,
  getAnalystView,
  toAudPortfolio,
  toAudRedistribution,
} from "@/lib/portfolio";
import {
  buildRedistribution,
  type NewPositionCandidate,
} from "@/lib/redistribution";
import { getMarketRegime } from "@/lib/regime";
import { buildWatchlist } from "@/lib/watchlist";
import { computeLiveMetrics } from "@/lib/live-metrics";
import { buildDisagreementRow } from "@/lib/announcements";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import { minAnnouncementImpact } from "@/lib/announcements";
import { computeInsights } from "@/lib/insights";
import type {
  AnnouncementsResponse,
  DashboardKpis,
  DashboardResponse,
  DisagreementRow,
  PortfolioResponse,
  ScoresResponse,
} from "@/lib/types";

/** Disagreement scorecard rows derived from a built portfolio. */
export function buildDisagreement(
  portfolio: PortfolioResponse
): DisagreementRow[] {
  return portfolio.holdings.map((h) =>
    buildDisagreementRow({
      ticker: h.ticker,
      verdict: h.verdict,
      analyst: getAnalystView(h.ticker),
      ourScore: h.score,
      ourSignal: h.signal,
    })
  );
}

/** Per-ticker scores with full breakdown (recomputed to expose the breakdown). */
export function buildScores(portfolio: PortfolioResponse): ScoresResponse {
  const scores = portfolio.holdings.map((h) => {
    const result = scoreHolding(h.metrics, {
      rsi: extractRsi(h.metrics),
      unrealisedPnlPct: h.unrealisedPnlPct,
      portfolioWeight: h.portfolioWeight,
      minAnnouncementImpact: minAnnouncementImpact(h.announcements),
    });
    return {
      ticker: h.ticker,
      score: result.score,
      signal: result.signal,
      breakdown: result.breakdown,
    };
  });
  return { scores, asOf: portfolio.asOf, source: portfolio.source };
}

export function buildAnnouncements(
  portfolio: PortfolioResponse
): AnnouncementsResponse {
  const byTicker: AnnouncementsResponse["byTicker"] = {};
  for (const h of portfolio.holdings) {
    byTicker[h.ticker] = { announcements: h.announcements, verdict: h.verdict };
  }
  return {
    byTicker,
    disagreement: buildDisagreement(portfolio),
    asOf: portfolio.asOf,
    source: portfolio.source,
  };
}

function buildKpis(portfolio: PortfolioResponse): DashboardKpis {
  const i = computeInsights(portfolio);
  return {
    totalPortfolioValue: portfolio.totalPortfolioValue,
    totalCostBasis: portfolio.totalCostBasis,
    totalUnrealisedPnl: portfolio.totalUnrealisedPnl,
    totalUnrealisedPnlPct: portfolio.totalUnrealisedPnlPct,
    currentCash: portfolio.cash,
    holdingsCount: portfolio.holdings.length,
    winRatePct: i.winRatePct,
    winners: i.winners,
    losers: i.losers,
    avgScore: i.avgScore,
    bullishPct: i.bullishPct,
    mood: i.mood,
    maxConcentration: i.maxConcentration,
    safetyRating: i.safety.score10,
  };
}

/**
 * Top screened watchlist names as new-position candidates for redistribution,
 * each scored on the SAME 20-metric engine as the holdings so they can compete
 * for capital head-to-head. Empty in risk-off regimes — no new positions into
 * a falling market. Exported so the standalone redistribution route reuses it.
 */
export async function buildNewPositionCandidates(
  riskOff: boolean
): Promise<NewPositionCandidate[]> {
  if (riskOff) return [];
  const watch = await buildWatchlist().catch(() => null);
  const shortlist = (watch?.items ?? [])
    .filter((i) => i.price != null && i.price > 0 && i.bucket !== "overbought")
    .slice(0, 3);

  return Promise.all(
    shortlist.map(async (i) => {
      let score: number | null = null;
      try {
        const metrics = await computeLiveMetrics(i.ticker, []);
        if (metrics) {
          score = scoreHolding(metrics, {
            rsi: extractRsi(metrics),
            unrealisedPnlPct: 0,
            portfolioWeight: 0,
            minAnnouncementImpact: 0,
          }).score;
        }
      } catch {
        // Unscored candidates simply don't compete (score stays null).
      }
      return {
        ticker: i.ticker,
        companyName: i.companyName,
        priceUsd: i.price as number,
        rationale: i.whyItFits,
        score,
      };
    })
  );
}

/** Aggregate everything for the /api/dashboard endpoint. */
export async function buildDashboard(): Promise<DashboardResponse> {
  // Engine runs in USD; convert to AUD for display (prices stay USD).
  const [portfolioUsd, regime] = await Promise.all([
    buildPortfolio(),
    getMarketRegime().catch(() => null),
  ]);
  const candidates = await buildNewPositionCandidates(regime?.regime === "risk_off");
  const redistributionUsd = buildRedistribution(portfolioUsd, {
    targetCashBufferPct: regime?.targetCashBufferPct,
    regimeLabel: regime?.label,
    newPositionCandidates: candidates,
  });

  const portfolio = toAudPortfolio(portfolioUsd);
  const redistribution = toAudRedistribution(
    redistributionUsd,
    portfolioUsd.fxUsdToAud
  );
  const disagreement = buildDisagreement(portfolio);

  return {
    // Nested (backward-compatible).
    portfolio,
    redistribution,
    disagreement,
    asOf: portfolio.asOf,
    source: portfolio.source,

    // Normalized top-level aliases.
    currentCash: portfolio.cash,
    totalPortfolioValue: portfolio.totalPortfolioValue,
    holdings: portfolio.holdings,
    beforeAllocations: redistribution.before,
    afterAllocations: redistribution.after,
    tradeRecommendations: redistribution.recommendations,
    redistributionSummary: redistribution.summary,
    disagreementRows: disagreement,
    kpis: buildKpis(portfolio),

    // Currency / cash.
    displayCurrency: portfolio.displayCurrency,
    cashBalances: portfolio.cashBalances,
    fxUsdToAud: portfolio.fxUsdToAud,
    fxLive: portfolio.fxLive,
  };
}
