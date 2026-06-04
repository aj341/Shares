import { resolveDataSource } from "@/lib/constants";
import {
  getAnalystView,
  getAnnouncements,
  getVerdict,
  minAnnouncementImpact,
} from "@/lib/announcements";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import { getMockMetrics, MOCK_QUOTES } from "@/lib/mock-data";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import * as finnhub from "@/lib/finnhub";
import type {
  DataSource,
  DerivedPosition,
  Holding,
  Metric,
  PortfolioResponse,
} from "@/lib/types";

/**
 * Assembles the fully-scored portfolio. This is the single place holdings are
 * built; API routes call into here so portfolio / scores / redistribution all
 * see a consistent snapshot.
 */

type Quote = { currentPrice: number; dayChangePct: number };

async function getQuoteFor(ticker: string, source: DataSource): Promise<Quote> {
  if (source === "finnhub") {
    const q = await finnhub.getQuote(ticker);
    if (q && q.c > 0) {
      return { currentPrice: q.c, dayChangePct: q.dp ?? 0 };
    }
  }
  // Mock fallback (also used when a live call returns nothing).
  return MOCK_QUOTES[ticker] ?? { currentPrice: 0, dayChangePct: 0 };
}

/** Replace the "Position size vs 30% cap" metric with one reflecting live weight. */
function withLivePositionSizeMetric(metrics: Metric[], weight: number): Metric[] {
  return metrics.map((m) => {
    if (m.name !== "Position size vs 30% cap") return m;
    const status =
      weight >= 30 ? "negative" : weight >= 25 ? "neutral" : "positive";
    const desc: Record<typeof status, string> = {
      positive: "Comfortably within the 30% single-position cap.",
      neutral: "Approaching the 30% position cap.",
      negative: "At or above the 30% position cap.",
    };
    return {
      ...m,
      value: `${weight.toFixed(1)}%`,
      status,
      description: desc[status],
    };
  });
}

export async function buildPortfolio(): Promise<PortfolioResponse> {
  const source = resolveDataSource();
  const asOf = new Date().toISOString();

  // 0. Active positions + cash derived from the transaction ledger.
  const { positions, cash: currentCash } = await getDerivedPortfolio();

  // 1. Quotes + raw position economics.
  const quotes = await Promise.all(
    positions.map((p) => getQuoteFor(p.ticker, source))
  );

  const base = positions.map((p: DerivedPosition, i: number) => {
    const { currentPrice, dayChangePct } = quotes[i];
    const costBasis = p.shares * p.entryPrice;
    const marketValue = p.shares * currentPrice;
    const unrealisedPnl = marketValue - costBasis;
    const unrealisedPnlPct = costBasis > 0 ? (unrealisedPnl / costBasis) * 100 : 0;
    return {
      position: p,
      currentPrice,
      dayChangePct,
      costBasis,
      marketValue,
      unrealisedPnl,
      unrealisedPnlPct,
    };
  });

  // 2. Portfolio-level aggregates (weight is relative to total incl. cash).
  const totalMarketValue = base.reduce((s, b) => s + b.marketValue, 0);
  const totalCostBasis = base.reduce((s, b) => s + b.costBasis, 0);
  const cash = currentCash;
  const totalPortfolioValue = totalMarketValue + cash;

  // 3. Build, score and enrich each holding.
  const holdings: Holding[] = base.map((b) => {
    const portfolioWeight =
      totalPortfolioValue > 0 ? (b.marketValue / totalPortfolioValue) * 100 : 0;

    const baseMetrics = getMockMetrics(b.position.ticker);
    const metrics = withLivePositionSizeMetric(baseMetrics, portfolioWeight);

    const announcements = getAnnouncements(b.position.ticker);
    const verdict = getVerdict(b.position.ticker);

    const { score, signal } = scoreHolding(metrics, {
      rsi: extractRsi(metrics),
      unrealisedPnlPct: b.unrealisedPnlPct,
      portfolioWeight,
      minAnnouncementImpact: minAnnouncementImpact(announcements),
    });

    return {
      ticker: b.position.ticker,
      companyName: b.position.companyName,
      shares: b.position.shares,
      entryPrice: b.position.entryPrice,
      currentPrice: b.currentPrice,
      dayChangePct: b.dayChangePct,
      costBasis: round2(b.costBasis),
      marketValue: round2(b.marketValue),
      unrealisedPnl: round2(b.unrealisedPnl),
      unrealisedPnlPct: round2(b.unrealisedPnlPct),
      portfolioWeight: round2(portfolioWeight),
      score,
      signal,
      metrics,
      announcements,
      verdict,
    };
  });

  const totalUnrealisedPnl = totalMarketValue - totalCostBasis;
  const totalUnrealisedPnlPct =
    totalCostBasis > 0 ? (totalUnrealisedPnl / totalCostBasis) * 100 : 0;

  return {
    holdings,
    cash: round2(cash),
    totalPortfolioValue: round2(totalPortfolioValue),
    totalCostBasis: round2(totalCostBasis),
    totalUnrealisedPnl: round2(totalUnrealisedPnl),
    totalUnrealisedPnlPct: round2(totalUnrealisedPnlPct),
    asOf,
    source,
  };
}

export { getAnalystView };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
