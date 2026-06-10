import { PORTFOLIO_RULES } from "@/lib/constants";
import { minAnnouncementImpact } from "@/lib/announcements";
import type {
  AllocationSnapshot,
  Holding,
  PortfolioResponse,
  RedistributionResponse,
  RedistributionSummary,
  TradeRecommendation,
} from "@/lib/types";

/**
 * Redistribution engine.
 *
 * Decides SELL / TRIM / BUY / HOLD per holding, then allocates available cash
 * (ARM-sale cash first, then trim/sell proceeds) into the best BUY candidates,
 * respecting the 30% position cap, the 5% cash buffer and whole-share rounding.
 */

const { maxPositionWeight, targetCashBufferPct, minTradeSize } = PORTFOLIO_RULES;

type Decision = "FULL_SELL" | "TRIM" | "BUY" | "HOLD";

type Working = {
  holding: Holding;
  decision: Decision;
  sharesAfter: number; // shares remaining after sells/trims (pre-buy)
  proceeds: number;
  realisedPnl: number;
};

function decide(h: Holding): Decision {
  // SAFETY: never recommend trades off degraded (mock-fallback) data.
  if (h.dataQuality === "degraded") return "HOLD";

  const negAnnouncement = minAnnouncementImpact(h.announcements) <= -2;

  // 1. Full sell — broken thesis.
  if (h.score < 40 && (h.verdict.verdict === "negative" || negAnnouncement)) {
    return "FULL_SELL";
  }

  // 2. Trim — weak score, or overbought + large gain + overweight.
  const rsiMetric = h.metrics.find((m) => m.name === "RSI(14)");
  const rsi =
    rsiMetric && typeof rsiMetric.value === "number" ? rsiMetric.value : null;
  const overboughtProfitOverweight =
    rsi !== null &&
    rsi > 75 &&
    h.unrealisedPnlPct > 20 &&
    h.portfolioWeight > maxPositionWeight * 100 * 0.8; // within 80% of cap

  if ((h.score >= 40 && h.score < 55) || overboughtProfitOverweight) {
    return "TRIM";
  }

  // 3. Buy — strong score, constructive verdict, below cap.
  if (
    h.score >= 70 &&
    h.verdict.verdict !== "negative" &&
    h.portfolioWeight < maxPositionWeight * 100
  ) {
    return "BUY";
  }

  return "HOLD";
}

/** Shares to trim: ~30% of the position, whole shares, respecting min trade size. */
function trimShares(h: Holding): number {
  const raw = Math.floor(h.shares * 0.3);
  if (raw <= 0) return 0;
  if (raw * h.currentPrice < minTradeSize) return 0;
  return raw;
}

export function buildRedistribution(
  portfolio: PortfolioResponse,
  opts: { targetCashBufferPct?: number; regimeLabel?: string } = {}
): RedistributionResponse {
  const { holdings, cash, totalPortfolioValue } = portfolio;
  // Regime-aware dynamic buffer (defaults to the static rule).
  const bufferPct = opts.targetCashBufferPct ?? targetCashBufferPct;
  const asOf = new Date().toISOString();

  // --- Before snapshot (holdings + cash, weights sum to ~100%). ---
  const before = buildSnapshots(holdings, cash, totalPortfolioValue);
  const maxWeightBefore = maxWeight(before);

  // --- Phase 1: decide sells / trims, collect proceeds. ---
  const working: Working[] = holdings.map((h) => {
    const decision = decide(h);
    let sharesAfter = h.shares;
    let proceeds = 0;
    let realisedPnl = 0;

    if (decision === "FULL_SELL") {
      sharesAfter = 0;
      proceeds = h.shares * h.currentPrice;
      realisedPnl = proceeds - h.costBasis;
    } else if (decision === "TRIM") {
      const ts = trimShares(h);
      sharesAfter = h.shares - ts;
      proceeds = ts * h.currentPrice;
      realisedPnl = ts * (h.currentPrice - h.entryPrice);
      if (ts === 0) {
        // Trim too small to act on — treat as hold for this cycle.
        return { holding: h, decision: "HOLD", sharesAfter: h.shares, proceeds: 0, realisedPnl: 0 };
      }
    }

    return { holding: h, decision, sharesAfter, proceeds, realisedPnl };
  });

  const recommendations: TradeRecommendation[] = [];
  let totalProceeds = 0;

  for (const w of working) {
    if (w.decision === "FULL_SELL" || (w.decision === "TRIM" && w.proceeds > 0)) {
      const soldShares = w.holding.shares - w.sharesAfter;
      totalProceeds += w.proceeds;
      recommendations.push({
        action: w.decision === "FULL_SELL" ? "SELL" : "TRIM",
        ticker: w.holding.ticker,
        shares: soldShares,
        estimatedPrice: round2(w.holding.currentPrice),
        estimatedProceedsOrCost: round2(w.proceeds),
        estimatedRealisedPnl: round2(w.realisedPnl),
        rationale:
          w.decision === "FULL_SELL"
            ? `Score ${w.holding.score} (SELL) with ${w.holding.verdict.verdict} verdict — exit full position.`
            : `Trim ${soldShares} shares — ${
                w.holding.score < 55
                  ? `weak score ${w.holding.score}`
                  : "overbought with a large gain near the position cap"
              }.`,
      });
    }
  }

  // --- Phase 2: available cash. Regime-aware cash buffer first, then proceeds. ---
  const targetCash = totalPortfolioValue * bufferPct;
  let availableToInvest = Math.max(0, cash - targetCash) + totalProceeds;

  // --- Phase 3: rank BUY candidates and allocate. ---
  const cap = maxPositionWeight * totalPortfolioValue;

  const buyCandidates = working
    .filter((w) => w.decision === "BUY")
    .map((w) => w.holding)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score; // score desc
      if (a.portfolioWeight !== b.portfolioWeight)
        return a.portfolioWeight - b.portfolioWeight; // lower weight first
      return (
        minAnnouncementImpact(b.announcements) -
        minAnnouncementImpact(a.announcements)
      ); // higher announcement impact first
    });

  // Track post-trade market value per ticker for cap + after snapshot.
  const mvAfter = new Map<string, number>();
  for (const w of working) {
    mvAfter.set(w.holding.ticker, w.sharesAfter * w.holding.currentPrice);
  }

  let totalInvested = 0;
  for (const h of buyCandidates) {
    const currentMv = mvAfter.get(h.ticker) ?? 0;
    const headroomToCap = Math.max(0, cap - currentMv);
    const maxByCash = Math.floor(availableToInvest / h.currentPrice);
    const maxByCap = Math.floor(headroomToCap / h.currentPrice);
    const buy = Math.max(0, Math.min(maxByCash, maxByCap));

    if (buy <= 0) continue;
    const cost = buy * h.currentPrice;
    if (cost < minTradeSize) continue; // ignore dust buys

    availableToInvest -= cost;
    totalInvested += cost;
    mvAfter.set(h.ticker, currentMv + cost);

    recommendations.push({
      action: "BUY",
      ticker: h.ticker,
      shares: buy,
      estimatedPrice: round2(h.currentPrice),
      estimatedProceedsOrCost: round2(cost),
      rationale: `Score ${h.score} (${h.signal}); below 30% cap — deploy capital up to cap.`,
    });
  }

  // --- After snapshot. ---
  const newCashBalance = cash + totalProceeds - totalInvested;
  const after: AllocationSnapshot[] = [];
  const newTotal =
    Array.from(mvAfter.values()).reduce((s, v) => s + v, 0) + newCashBalance;

  for (const h of holdings) {
    const mv = mvAfter.get(h.ticker) ?? 0;
    if (mv <= 0) continue; // fully sold — drop from allocation
    after.push({
      ticker: h.ticker,
      companyName: h.companyName,
      marketValue: round2(mv),
      weight: round2(newTotal > 0 ? (mv / newTotal) * 100 : 0),
    });
  }
  after.push({
    ticker: "CASH",
    companyName: "Cash",
    marketValue: round2(newCashBalance),
    weight: round2(newTotal > 0 ? (newCashBalance / newTotal) * 100 : 0),
  });

  const tickersFullySold = working
    .filter((w) => w.decision === "FULL_SELL")
    .map((w) => w.holding.ticker);

  const summary: RedistributionSummary = {
    totalProceeds: round2(totalProceeds),
    totalInvested: round2(totalInvested),
    newCashBalance: round2(newCashBalance),
    maxWeightBefore: round2(maxWeightBefore),
    maxWeightAfter: round2(maxWeight(after)),
    tickersFullySold,
    targetCashBufferPct: bufferPct,
    regimeLabel: opts.regimeLabel,
  };

  // Order: sells, then trims, then buys.
  recommendations.sort((a, b) => rank(a.action) - rank(b.action));

  return { recommendations, before, after, summary, asOf, source: portfolio.source };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSnapshots(
  holdings: Holding[],
  cash: number,
  total: number
): AllocationSnapshot[] {
  const snaps = holdings.map((h) => ({
    ticker: h.ticker,
    companyName: h.companyName,
    marketValue: round2(h.marketValue),
    weight: round2(total > 0 ? (h.marketValue / total) * 100 : 0),
  }));
  snaps.push({
    ticker: "CASH",
    companyName: "Cash",
    marketValue: round2(cash),
    weight: round2(total > 0 ? (cash / total) * 100 : 0),
  });
  return snaps;
}

function maxWeight(snaps: AllocationSnapshot[]): number {
  return snaps
    .filter((s) => s.ticker !== "CASH")
    .reduce((max, s) => Math.max(max, s.weight), 0);
}

function rank(action: TradeRecommendation["action"]): number {
  return action === "SELL" ? 0 : action === "TRIM" ? 1 : 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
