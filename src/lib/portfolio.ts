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
// [exthours] Extended-hours pricing: surface a live pre/post-market print when
// the regular market is closed, instead of leaving the dashboard on the prior
// close. Additive + null-safe; the regular-hours Finnhub path is untouched.
import { getMarketSession } from "@/lib/market-session";
import { getExtendedHoursQuote } from "@/lib/extended-quote";
// [factors] additive cross-sectional dimension
import { loadBenchmarkBundle } from "@/lib/relative-strength";
import { computeFactorBundle, rankCrossSection, buildFactorMetrics } from "@/lib/factors";
// [calibration] Additive conviction overlay (never alters score/signal).
import { getCalibrationCached, convictionForSignal } from "@/lib/calibration";
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
  // [exthours] Set when a live extended-hours print is surfaced (regular market
  // closed). currentPrice/dayChangePct above already reflect it; these carry the
  // provenance through to the Holding for the UI badge. Absent during regular
  // hours and whenever no valid extended print exists.
  session?: "pre" | "regular" | "post" | "closed";
  extendedHours?: { price: number; changePct: number | null; session: "pre" | "post" };
};

async function getQuoteFor(
  ticker: string,
  source: DataSource,
  // [exthours] Current US market session, computed once per build. Only used to
  // decide whether to OVERRIDE the regular-hours price with an extended print.
  clockSession: ReturnType<typeof getMarketSession> = getMarketSession()
): Promise<Quote> {
  if (source === "finnhub") {
    // [exthours] Regular session CLOSED: try a real pre/post-market print first.
    // If found, it becomes the live price (with a session label + extended
    // day-change). If not, we fall straight through to the existing behavior
    // (Finnhub quote / Mboum last close) - so nothing is ever fabricated.
    if (clockSession !== "regular") {
      const ext = await getExtendedHoursQuote(ticker, clockSession).catch(() => null);
      if (ext) {
        return {
          currentPrice: ext.price,
          dayChangePct: ext.changePct ?? 0,
          real: true,
          session: ext.session,
          extendedHours: {
            price: ext.price,
            changePct: ext.changePct,
            session: ext.session,
          },
        };
      }
    }
    const q = await finnhub.getQuote(ticker);
    if (q && q.c > 0) {
      // [exthours] Regular Finnhub quote is UNCHANGED; we only annotate the
      // session so the UI can label pre/post/closed states where no live
      // extended print was available (no extendedHours attached here).
      return { currentPrice: q.c, dayChangePct: q.dp ?? 0, real: true, session: clockSession };
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
          // [exthours] Stale-but-real close: annotate session for the UI badge.
          session: clockSession,
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
  // [exthours] Resolve the US market session ONCE for this build so every
  // holding uses a consistent session and we don't recompute per ticker.
  const clockSession = getMarketSession();

  // 0. Active positions from the ledger; cash from the real broker balances.
  //    Engine works in USD (US equities are USD-priced); we convert to AUD for
  //    display in toAudPortfolio. Cash is the multi-currency broker balance,
  //    summed to USD here so the USD engine (redistribution) stays consistent.
  const [{ positions, state }, fx, brokerCash, calibration] = await Promise.all([
    getDerivedPortfolio(),
    getFxRates(),
    readBrokerCash().catch(() => null),
    // [calibration] Historical conviction overlay; null-safe (no DB/snapshots -> null).
    getCalibrationCached().catch(() => null),
  ]);

  // Cash: prefer the IBKR-synced balances (NATIVE currency → AUD via live FX);
  // fall back to the static CASH_BALANCES (already AUD market values).
  const cashBalances: CashBalance[] = brokerCash
    ? brokerCash.lines.map((b) => ({
        currency: b.currency,
        amountAud: round2(toAud(b.amount, b.currency, fx)),
      }))
    : CASH_BALANCES.map((b) => ({
        currency: b.currency,
        amountAud: round2(b.amountAud),
      }));

  // The broker balance is a periodic snapshot. Layer ledger cash movements
  // (buys, sells, cash adjustments) entered AFTER the last broker sync on top,
  // so a manual entry reflects immediately and the next sync reconciles it
  // away. Ledger amounts are USD (US equities are USD-priced; engine is USD).
  const since = brokerCash?.syncedAt ?? null;
  const ledgerCashDeltaUsd = state.transactions
    .filter((t) => since == null || t.createdAt > since)
    .reduce((sum, t) => sum + (t.netCashImpact ?? 0), 0);
  if (ledgerCashDeltaUsd !== 0) {
    const deltaAud = toAud(ledgerCashDeltaUsd, "USD", fx);
    const usd = cashBalances.find((b) => b.currency === "USD");
    if (usd) usd.amountAud = round2(usd.amountAud + deltaAud);
    else cashBalances.push({ currency: "USD", amountAud: round2(deltaAud) });
  }

  const cashAud = cashBalances.reduce((s, b) => s + b.amountAud, 0);
  const currentCash = cashAud * fx.audToUsd; // USD-equivalent for the engine

  // 1. Quotes + live news (display), fetched in parallel per ticker.
  const [quotes, liveAnnouncements] = await Promise.all([
    Promise.all(positions.map((p) => getQuoteFor(p.ticker, source, clockSession))),
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

  // [factors] Cross-sectional relative-strength + factor dimension.
  // Benchmark/sector-ETF history is fetched ONCE for the whole set; per-holding
  // closes reuse Mboum (cached). All null-safe: any miss leaves fields absent.
  const factorTickers = positions.map((p) => p.ticker);
  const [benchmarkBundle, holdingCloses] = isMboumConfigured()
    ? await Promise.all([
        loadBenchmarkBundle(factorTickers).catch(() => ({} as Record<string, number[]>)),
        Promise.all(
          positions.map((p) =>
            getStockHistory(p.ticker, { interval: "1d", monthsBack: 13 })
              .then((c) => c.map((x) => x.adjClose))
              .catch(() => [] as number[])
          )
        ),
      ])
    : [{} as Record<string, number[]>, positions.map(() => [] as number[])];

  const factorBundles = positions.map((p, i) =>
    computeFactorBundle({
      ticker: p.ticker,
      closes: holdingCloses[i] ?? [],
      bundle: benchmarkBundle,
      metrics: liveMetricsArr[i] ?? [],
    })
  );
  // Rank across the holdings set. (To rank holdings + watchlist TOGETHER, a
  // caller can collect RankableInput[] from both builders and call
  // rankCrossSection once — see report / buildWatchlist for the parallel path.)
  const rankedFactors = rankCrossSection(
    factorBundles.map((fb) => ({
      ticker: "",
      relativeStrengthRaw: fb.relativeStrengthRaw,
      factors: fb.factors,
    }))
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
      // [exthours] Pass-through session + extended-hours provenance (if any).
      session: quotes[i].session,
      extendedHours: quotes[i].extendedHours,
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

    // [factors] Additive metric rows appended for DISPLAY ONLY — they are
    // NOT passed to scoreHolding, so the existing 0-100 score is unchanged.
    const factorMetricRows = degraded
      ? []
      : buildFactorMetrics(rankedFactors[i].relativeStrength, rankedFactors[i].factors);
    const displayMetrics = [...metrics, ...factorMetricRows];

    return {
      ticker: b.position.ticker,
      companyName: b.position.companyName,
      shares: b.position.shares,
      entryPrice: b.position.entryPrice,
      currentPrice: b.currentPrice,
      dayChangePct: b.dayChangePct,
      // [exthours] Additive: surface the session + the extended-hours print that
      // is driving currentPrice/dayChangePct (when the regular market is closed).
      session: b.session,
      extendedHours: b.extendedHours,
      dataQuality,
      costBasis: round2(b.costBasis),
      marketValue: round2(b.marketValue),
      unrealisedPnl: round2(b.unrealisedPnl),
      unrealisedPnlPct: round2(b.unrealisedPnlPct),
      portfolioWeight: round2(portfolioWeight),
      score,
      signal,
      metrics: displayMetrics,
      announcements,
      verdict,
      // [factors] additive — relative strength + factor scores + metric rows.
      relativeStrength: rankedFactors[i].relativeStrength,
      factors: rankedFactors[i].factors,
      // [calibration] Additive overlay. Withheld for degraded holdings (no
      // trustworthy live signal). Defaults to 20-calendar-day horizon. Never
      // affects score/signal above.
      conviction: degraded
        ? undefined
        : convictionForSignal(calibration, signal, score, 20),
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
      // [sizing][integration] concentration weights/grades are FX-invariant;
      // only the $-per-name budget is a money amount and must convert to AUD.
      concentration: d.summary.concentration
        ? {
            ...d.summary.concentration,
            maxDollarsPerName: round2(
              d.summary.concentration.maxDollarsPerName * r
            ),
          }
        : d.summary.concentration,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
