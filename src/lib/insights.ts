import type { Holding, PortfolioResponse, Signal } from "@/lib/types";

/**
 * Client-safe derived metrics for the overview panels (Safety Rating,
 * Portfolio Pulse, KPI sentiment). Everything here is computed from the
 * already-built portfolio — no new data and nothing fabricated.
 */

export type Mood = "Bullish" | "Neutral" | "Bearish";

export type PortfolioInsights = {
  winRatePct: number;
  winners: number;
  losers: number;
  avgScore: number;
  bullishPct: number; // share of holdings on a BUY/STRONG_BUY signal
  mood: Mood;
  best: { ticker: string; pnlPct: number } | null;
  worst: { ticker: string; pnlPct: number } | null;
  buyTickers: string[];
  sellTickers: string[];
  maxConcentration: number;
  safety: { score10: number; label: string; tone: "positive" | "warning" | "negative" };
};

const isBullish = (s: Signal) => s === "BUY" || s === "STRONG_BUY";
const isBearish = (s: Signal) => s === "SELL" || s === "TRIM";

export function computeInsights(p: PortfolioResponse): PortfolioInsights {
  const hs = p.holdings;
  const n = hs.length || 1;

  const winners = hs.filter((h) => h.unrealisedPnl > 0).length;
  const losers = hs.filter((h) => h.unrealisedPnl < 0).length;
  const avgScore = Math.round(hs.reduce((s, h) => s + h.score, 0) / n);
  const bullishCount = hs.filter((h) => isBullish(h.signal)).length;
  const bullishPct = Math.round((bullishCount / n) * 100);

  const sorted = [...hs].sort((a, b) => b.unrealisedPnlPct - a.unrealisedPnlPct);
  const best = sorted[0]
    ? { ticker: sorted[0].ticker, pnlPct: sorted[0].unrealisedPnlPct }
    : null;
  const worst = sorted[sorted.length - 1]
    ? {
        ticker: sorted[sorted.length - 1].ticker,
        pnlPct: sorted[sorted.length - 1].unrealisedPnlPct,
      }
    : null;

  const maxConcentration = hs.reduce((m, h) => Math.max(m, h.portfolioWeight), 0);

  const mood: Mood =
    avgScore >= 70 ? "Bullish" : avgScore >= 50 ? "Neutral" : "Bearish";

  return {
    winRatePct: Math.round((winners / n) * 100),
    winners,
    losers,
    avgScore,
    bullishPct,
    mood,
    best,
    worst,
    buyTickers: hs.filter((h) => isBullish(h.signal)).map((h) => h.ticker),
    sellTickers: hs.filter((h) => isBearish(h.signal)).map((h) => h.ticker),
    maxConcentration,
    safety: safetyRating(avgScore, maxConcentration),
  };
}

/**
 * Portfolio safety, 0–10. Anchored on the average score, penalised for
 * single-name concentration above the 30% cap territory.
 */
function safetyRating(
  avgScore: number,
  maxConcentration: number
): { score10: number; label: string; tone: "positive" | "warning" | "negative" } {
  let s = avgScore / 10;
  if (maxConcentration > 30) s -= 1.5;
  else if (maxConcentration > 25) s -= 0.7;
  s = Math.max(0, Math.min(10, Math.round(s * 10) / 10));

  const label =
    s >= 7.5 ? "Strong" : s >= 6 ? "Moderate" : s >= 4 ? "Caution" : "Elevated risk";
  const tone = s >= 6 ? "positive" : s >= 4 ? "warning" : "negative";
  return { score10: s, label, tone };
}

/** Group holdings by signal for the "Today's Signals" panel. */
export function groupBySignal(holdings: Holding[]): {
  buy: Holding[];
  hold: Holding[];
  trimSell: Holding[];
} {
  return {
    buy: holdings.filter((h) => isBullish(h.signal)),
    hold: holdings.filter((h) => h.signal === "HOLD"),
    trimSell: holdings.filter((h) => h.signal === "TRIM" || h.signal === "SELL"),
  };
}
