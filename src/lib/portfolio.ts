import { resolveDataSource, CASH_BALANCES, DISPLAY_CURRENCY } from "@/lib/constants";
import { getFxRates, toAud } from "@/lib/fx";
import { readBrokerCash } from "@/lib/broker-cash";
import {
  getAnalystView,
  getAnnouncements,
  getLiveAnnouncements,
  getVerdict,
  minAnnouncementImpact,
} from "@/lib/announcements";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import { getMockMetrics, MOCK_QUOTES } from "@/lib/mock-data";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { computeLiveMetrics } from "@/lib/live-metrics";
import { buildLiveVerdict } from "@/lib/verdict";
import { enhanceVerdict, getCachedEnhancedVerdict } from "@/lib/verdict-llm";
import { getStockHistory, isMboumConfigured } from "@/lib/mboum";
import * as finnhub from "@/lib/finnhub";
import type {
  Announcement,
  CashBalance,
  DataSource,
  DerivedPosition,
  Holding,
  Metric,
  PortfolioResponse,
  RedistributionResponse,
  StockVerdict,
} from "@/lib/types";

/**
 * Assembles the fully-scored portfolio. This is the single place holdings are
 * built; API routes call into here so portfolio / scores / redistribution all
 * see a consistent snapshot.
 */

type Quote = {
  currentPrice: number;
  dayChangePct: number;
  /** True when the price came from a real feed (Finnhub, or Mboum last close). */
  real: boolean;
};

async function getQuoteFor(ticker: string, source: DataSource): Promise<Quote> {
  if (source === "finnhub") {
    const q = await finnhub.getQuote(ticker);
    if (q && q.c > 0) {
      return { currentPrice: q.c, dayChangePct: q.dp ?? 0, real: true };
    }
    // Finnhub failed: prefer a REAL (slightly stale) Mboum close over mock.
    if (isMboumConfigured()) {
      const candles = await getStockHistory(ticker, { interval: "1d", days: 10 }).catch(
        () => []
      );
      if (candles.length > 0) {
        const last = candles[candles.length - 1];
        const prev = candles.length > 1 ? candles[candles.length - 2] : null;
        return {
          currentPrice: last.close,
          dayChangePct: prev ? ((last.close - prev.close) / prev.close) * 100 : 0,
          real: true,
        };
      }
    }
  }
  if (source === "mock") {
    const mock = MOCK_QUOTES[ticker] ?? { currentPrice: 0, dayChangePct: 0 };
    return { ...mock, real: false };
  }
  // Live mode with BOTH feeds down: never fabricate a price — zero values
  // plus the degraded flag make the failure explicit in the UI.
  return { currentPrice: 0, dayChangePct: 0, real: false };
}

/** Explicit error verdict for live mode when real data is unavailable. */
function unavailableVerdict(): StockVerdict {
  return {
    summaryBullets: [
      "Live data unavailable — this holding is NOT being rated.",
      "No mock or stale values are used; the score and signal are withheld.",
    ],
    verdict: "neutral",
    impactScore: 0,
    thesisUpdate: "Data error — rating withheld until live feeds recover.",
    marketReactionView: "Unavailable.",
    actionHint: "no_change",
    execCommentary: { hasExecComments: false, tone: "no_signal", keyPoints: [] },
    factAlignment: { financialsSupportStory: "unclear", notes: "Live data unavailable." },
    researchStatus: { ourResearchComplete: "no", recommendedFollowUp: ["Retry when feeds recover."] },
  };
}

/** Replace the "Position size vs 35% cap" metric with one reflecting live weight. */
function withLivePositionSizeMetric(metrics: Metric[], weight: number): Metric[] {
  return metrics.map((m) => {
    if (m.name !== "Position size vs 35% cap") return m;
    const status =
      weight >= 35 ? "negative" : weight >= 30 ? "neutral" : "positive";
    const desc: Record<typeof status, string> = {
      positive: "Comfortably within the 35% single-position cap.",
      neutral: "Approaching the 35% position cap.",
      negative: "At or above the 35% position cap.",
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

  // 0. Active positions from the ledger; cash from the real broker balances.
  //    Engine works in USD (US equities are USD-priced); we convert to AUD for
  //    display in toAudPortfolio. Cash is the multi-currency broker balance,
  //    summed to USD here so the USD engine (redistribution) stays consistent.
  const [{ positions }, fx, brokerCash] = await Promise.all([
    getDerivedPortfolio(),
    getFxRates(),
    readBrokerCash().catch(() => null),
  ]);

  // Cash: prefer the IBKR-synced balances (NATIVE currency → AUD via live FX);
  // fall back to the static CASH_BALANCES (already AUD market values).
  const cashBalances: CashBalance[] = brokerCash
    ? brokerCash.map((b) => ({
        currency: b.currency,
        amountAud: round2(toAud(b.amount, b.currency, fx)),
      }))
    : CASH_BALANCES.map((b) => ({
        currency: b.currency,
        amountAud: round2(b.amountAud),
      }));
  const cashAud = cashBalances.reduce((s, b) => s + b.amountAud, 0);
  const currentCash = cashAud * fx.audToUsd; // USD-equivalent for the engine

  // 1. Quotes + live news (display), fetched in parallel per ticker.
  const [quotes, liveAnnouncements] = await Promise.all([
    Promise.all(positions.map((p) => getQuoteFor(p.ticker, source))),
    Promise.all(
      positions.map((p) =>
        source === "finnhub"
          ? getLiveAnnouncements(p.ticker).catch(() => [] as Announcement[])
          : Promise.resolve<Announcement[]>([])
      )
    ),
  ]);

  // 1b. Live scoring metrics from real data (Mboum) — null → mock fallback.
  const liveMetricsArr = await Promise.all(
    positions.map((p, i) =>
      isMboumConfigured()
        ? computeLiveMetrics(
            p.ticker,
            liveAnnouncements[i].map((a) => a.impactScore)
          ).catch(() => null)
        : Promise.resolve<Metric[] | null>(null)
    )
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
  const holdings: Holding[] = base.map((b, i) => {
    const portfolioWeight =
      totalPortfolioValue > 0 ? (b.marketValue / totalPortfolioValue) * 100 : 0;

    const isMockMode = source === "mock";
    const liveMetrics = liveMetricsArr[i];

    // Data provenance. In live mode mock data is NEVER used — a failed feed
    // is an explicit ERROR state (no metrics, no score, no signal), because a
    // rating built on mock inputs is worse than no rating.
    const dataQuality: Holding["dataQuality"] = isMockMode
      ? "mock"
      : quotes[i].real && liveMetrics
      ? "live"
      : "degraded";
    const degraded = dataQuality === "degraded";

    const baseMetrics =
      liveMetrics ?? (isMockMode ? getMockMetrics(b.position.ticker) : []);
    const metrics = degraded
      ? []
      : withLivePositionSizeMetric(baseMetrics, portfolioWeight);

    // Mock announcements only in mock mode; live mode shows real news or none.
    const announcements = isMockMode
      ? getAnnouncements(b.position.ticker)
      : liveAnnouncements[i];

    const scored = degraded
      ? { score: 0, signal: "HOLD" as const }
      : scoreHolding(metrics, {
          rsi: extractRsi(metrics),
          unrealisedPnlPct: b.unrealisedPnlPct,
          portfolioWeight,
          minAnnouncementImpact: minAnnouncementImpact(announcements),
        });
    const score = scored.score;
    const signal = scored.signal;

    // Verdict derived from live metrics + news; if a cached Claude-deepened
    // verdict exists use it, otherwise serve the deterministic one now and warm
    // the LLM cache in the background (non-blocking) for the next build.
    let verdict: StockVerdict;
    if (liveMetrics) {
      const base = buildLiveVerdict({
        ticker: b.position.ticker,
        metrics,
        score,
        signal,
        announcements,
      });
      const cached = getCachedEnhancedVerdict(b.position.ticker, score);
      if (cached) {
        verdict = cached;
      } else {
        verdict = base;
        void enhanceVerdict({
          ticker: b.position.ticker,
          metrics,
          score,
          signal,
          announcements,
          base,
        }).catch(() => {});
      }
    } else if (isMockMode) {
      verdict = getVerdict(b.position.ticker);
    } else {
      // Live mode without live metrics: explicit error verdict, never mock.
      verdict = unavailableVerdict();
    }

    return {
      ticker: b.position.ticker,
      companyName: b.position.companyName,
      shares: b.position.shares,
      entryPrice: b.position.entryPrice,
      currentPrice: b.currentPrice,
      dayChangePct: b.dayChangePct,
      dataQuality,
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

  // NOTE: numbers here are USD (engine currency). The display layer
  // (toAudPortfolio) converts value/P&L/cash to AUD; per-share prices stay USD.
  return {
    holdings,
    cash: round2(cash),
    totalPortfolioValue: round2(totalPortfolioValue),
    totalCostBasis: round2(totalCostBasis),
    totalUnrealisedPnl: round2(totalUnrealisedPnl),
    totalUnrealisedPnlPct: round2(totalUnrealisedPnlPct),
    asOf,
    source,
    displayCurrency: "USD",
    cashBalances,
    fxUsdToAud: fx.usdToAud,
    fxLive: fx.live,
  };
}

export { getAnalystView };

/**
 * Convert a USD-engine portfolio into the AUD display shape: value, cost basis,
 * P&L and cash are converted to AUD; per-share prices (currentPrice/entryPrice)
 * stay in USD, matching the broker. Percentages and weights are unchanged.
 */
export function toAudPortfolio(p: PortfolioResponse): PortfolioResponse {
  const r = p.fxUsdToAud;
  return {
    ...p,
    cash: round2(p.cash * r),
    totalPortfolioValue: round2(p.totalPortfolioValue * r),
    totalCostBasis: round2(p.totalCostBasis * r),
    totalUnrealisedPnl: round2(p.totalUnrealisedPnl * r),
    // totalUnrealisedPnlPct is a ratio — unchanged.
    holdings: p.holdings.map((h) => ({
      ...h,
      // currentPrice + entryPrice intentionally stay in USD.
      costBasis: round2(h.costBasis * r),
      marketValue: round2(h.marketValue * r),
      unrealisedPnl: round2(h.unrealisedPnl * r),
    })),
    displayCurrency: DISPLAY_CURRENCY,
  };
}

/**
 * Convert a USD redistribution plan to AUD for display. Money amounts convert;
 * per-share estimatedPrice stays USD and share counts are unchanged.
 */
export function toAudRedistribution(
  d: RedistributionResponse,
  usdToAud: number
): RedistributionResponse {
  const r = usdToAud;
  return {
    ...d,
    recommendations: d.recommendations.map((rec) => ({
      ...rec,
      // estimatedPrice stays USD (per-share); proceeds/cost convert.
      estimatedProceedsOrCost: round2(rec.estimatedProceedsOrCost * r),
      estimatedRealisedPnl:
        rec.estimatedRealisedPnl != null
          ? round2(rec.estimatedRealisedPnl * r)
          : rec.estimatedRealisedPnl,
    })),
    before: d.before.map((a) => ({ ...a, marketValue: round2(a.marketValue * r) })),
    after: d.after.map((a) => ({ ...a, marketValue: round2(a.marketValue * r) })),
    summary: {
      ...d.summary,
      totalProceeds: round2(d.summary.totalProceeds * r),
      totalInvested: round2(d.summary.totalInvested * r),
      newCashBalance: round2(d.summary.newCashBalance * r),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
