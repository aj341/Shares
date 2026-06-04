import {
  getAnalystRatings,
  getKeyStats,
  getPriceTargets,
  getStockHistory,
  isMboumConfigured,
} from "@/lib/mboum";
import type { StockTechnicals } from "@/lib/types";

/**
 * Computes per-stock technicals from real Mboum daily history + modules.
 * RSI(14) uses Wilder's smoothing; MAs are simple moving averages. Everything
 * is sourced/derived — nothing fabricated. Returns nulls when data is absent.
 */

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Wilder's RSI over `period` (default 14). */
function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

const EMPTY = (ticker: string): StockTechnicals => ({
  ticker,
  rsi: null,
  ma20: null,
  ma50: null,
  priceVsMa20: null,
  priceVsMa50: null,
  week52High: null,
  week52Low: null,
  peRatio: null,
  targetMean: null,
  targetUpsidePct: null,
  bullishPct: null,
  analystConsensus: null,
  sparkline: [],
});

export async function buildStockTechnicals(
  ticker: string
): Promise<StockTechnicals> {
  if (!isMboumConfigured()) return EMPTY(ticker);

  const [candles, targets, ratings, stats] = await Promise.all([
    getStockHistory(ticker, { interval: "1d", monthsBack: 13 }),
    getPriceTargets(ticker),
    getAnalystRatings(ticker),
    getKeyStats(ticker),
  ]);

  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1] ?? null;
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const bullishPct = ratings
    ? Math.round(
        ((ratings.strongBuy + ratings.buy) /
          Math.max(
            1,
            ratings.strongBuy + ratings.buy + ratings.hold + ratings.sell + ratings.strongSell
          )) *
          100
      )
    : null;

  return {
    ticker,
    rsi: rsi(closes, 14),
    ma20: ma20 ? round2(ma20) : null,
    ma50: ma50 ? round2(ma50) : null,
    priceVsMa20: last != null && ma20 != null ? (last >= ma20 ? "above" : "below") : null,
    priceVsMa50: last != null && ma50 != null ? (last >= ma50 ? "above" : "below") : null,
    week52High: stats?.week52High ?? (closes.length ? round2(Math.max(...closes)) : null),
    week52Low: stats?.week52Low ?? (closes.length ? round2(Math.min(...closes)) : null),
    peRatio: stats?.peRatio ?? null,
    targetMean: targets?.mean ?? null,
    targetUpsidePct: targets?.upsidePct != null ? round2(targets.upsidePct) : null,
    bullishPct,
    analystConsensus: ratings?.consensus ?? null,
    sparkline: closes.slice(-40).map((c) => round2(c)),
  };
}

export async function buildStocksTechnicals(
  tickers: string[]
): Promise<Record<string, StockTechnicals>> {
  const results = await Promise.all(tickers.map((t) => buildStockTechnicals(t)));
  const byTicker: Record<string, StockTechnicals> = {};
  results.forEach((r) => (byTicker[r.ticker] = r));
  return byTicker;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
