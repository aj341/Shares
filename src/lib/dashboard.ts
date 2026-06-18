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
// [top3] AI "Top 3 Moves Today" — additive policy engine over existing signals.
import { buildTopMoves, type Top3SignalInputs, type TopMovesResponse } from "@/lib/top-moves";
import { sectorFor } from "@/lib/sectors";
import { isDatabaseConfigured, query } from "@/lib/db";
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
/** Sector weight of the existing book, percent by sector name. */
function sectorWeights(portfolio: PortfolioResponse): Map<string, number> {
  const bySector = new Map<string, number>();
  for (const h of portfolio.holdings) {
    const s = sectorFor(h.ticker);
    bySector.set(s, (bySector.get(s) ?? 0) + h.portfolioWeight);
  }
  return bySector;
}

/**
 * Previous-run engine scores per ticker from score_snapshots (anything older
 * than 12h counts as "the previous run"). Empty map without a DB.
 */
async function priorScores(tickers: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!isDatabaseConfigured() || tickers.length === 0) return map;
  try {
    const rows = await query<{ ticker: string; score: string | number }>(
      `SELECT DISTINCT ON (ticker) ticker, score
         FROM score_snapshots
        WHERE ticker = ANY($1) AND captured_at < NOW() - INTERVAL '12 hours'
        ORDER BY ticker, captured_at DESC`,
      [tickers]
    );
    for (const r of rows) map.set(r.ticker, Number(r.score));
  } catch {
    /* no history — confirmation degrades to allow */
  }
  return map;
}

/** Sector weight above which a candidate needs 75 (not 70) to compete. */
const CONCENTRATED_SECTOR_PCT = 40;
/** Previous-run score needed to confirm a fresh BUY-grade signal. */
const CONFIRM_PRIOR_MIN = 67;

export async function buildNewPositionCandidates(
  riskOff: boolean,
  portfolio?: PortfolioResponse
): Promise<NewPositionCandidate[]> {
  if (riskOff) return [];
  const watch = await buildWatchlist().catch(() => null);
  // EVERY watchlist name enters the contest with its engine score — bucket is
  // entry timing, not quality, so it must not gate eligibility (a BUY-grade
  // name in the "neutral" bucket still competes). Redistribution applies the
  // bar; all scores are surfaced via candidatesConsidered.
  const base = (watch?.items ?? []).filter((i) => i.price != null && i.price > 0);
  const sectors = portfolio ? sectorWeights(portfolio) : new Map<string, number>();
  const prior = await priorScores(base.map((i) => i.ticker));

  return base
    .map((i) => {
      // Doubling down on a sector that already dominates the book needs more
      // conviction than a diversifying add.
      const sectorPct = sectors.get(sectorFor(i.ticker)) ?? 0;
      const minBar = sectorPct >= CONCENTRATED_SECTOR_PCT ? 75 : 70;
      // Two-run confirmation: a fresh signal must also have scored >=67 on
      // the previous daily snapshot (no history = cold start, allowed).
      const prev = prior.get(i.ticker);
      const confirmed = prev === undefined || prev >= CONFIRM_PRIOR_MIN;
      return {
        ticker: i.ticker,
        companyName: i.companyName,
        priceUsd: i.price as number,
        rationale: i.whyItFits,
        score: i.engineScore,
        minBar,
        confirmed,
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** Aggregate everything for the /api/dashboard endpoint. */
export async function buildDashboard(): Promise<DashboardResponse> {
  // Engine runs in USD; convert to AUD for display (prices stay USD).
  const [portfolioUsd, regime] = await Promise.all([
    buildPortfolio(),
    getMarketRegime().catch(() => null),
  ]);
  const candidates = await buildNewPositionCandidates(regime?.regime === "risk_off", portfolioUsd);
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


// ---------------------------------------------------------------------------
// [top3] AI "Top 3 Moves Today" — assembles the SAME portfolio + redistribution
// + watchlist the dashboard uses, then runs the deterministic Top-3 policy
// engine over them. ADDITIVE: reuses existing builders, mutates nothing.
//
// INTEGRATOR NOTE: sibling earnings/regime/news/insider signals are wired in
// here by populating the `signals` object below and passing it to buildTopMoves
// (see the Top3SignalInputs interface in src/lib/top-moves.ts). The market
// regime is already available locally, so it is mapped in as the first slot.
// ---------------------------------------------------------------------------
export async function buildTopMovesData(): Promise<TopMovesResponse> {
  const [portfolioUsd, regime, watchlist] = await Promise.all([
    buildPortfolio(),
    getMarketRegime().catch(() => null),
    buildWatchlist().catch(() => null),
  ]);

  const candidates = await buildNewPositionCandidates(
    regime?.regime === "risk_off",
    portfolioUsd
  );
  const redistributionUsd = buildRedistribution(portfolioUsd, {
    targetCashBufferPct: regime?.targetCashBufferPct,
    regimeLabel: regime?.label,
    newPositionCandidates: candidates,
  });

  // [top3] Optional sibling signals. Only `regime` is currently shipped; the
  // earnings/news/insider slots stay undefined until those features land. See
  // the wiring instructions in src/lib/top-moves.ts.
  const signals: Top3SignalInputs = {};
  if (regime?.regime) {
    // Map the engine's "caution" tier onto the Top3 "neutral" posture.
    const r =
      regime.regime === "risk_on"
        ? "risk_on"
        : regime.regime === "risk_off"
          ? "risk_off"
          : "neutral";
    signals.regime = { regime: r, label: regime.label };
  }

  return buildTopMoves({
    holdings: portfolioUsd.holdings,
    redistribution: redistributionUsd,
    watchlist: watchlist?.items ?? [],
    signals,
  });
}
