import "server-only";
import { getStockHistory } from "@/lib/mboum";
import { buildPortfolio } from "@/lib/portfolio";
import { groupBySector } from "@/lib/sectors";
import type { Holding } from "@/lib/types";

/**
 * Portfolio-level risk analytics derived from real Mboum daily history.
 *
 * Benchmark is QQQ (Nasdaq-100 proxy). All return / beta / correlation maths
 * runs on daily simple returns over a ~6-month window. Missing data degrades
 * gracefully to nulls / empty arrays rather than throwing.
 */

const BENCHMARK = "QQQ";
const MONTHS_BACK = 6;

export type RiskAnalysis = {
  benchmark: string;
  relativeStrength: Array<{
    ticker: string;
    sixMonthReturnPct: number | null;
    vsBenchmarkPct: number | null;
  }>;
  portfolioBeta: number | null;
  topConcentration: { ticker: string; weight: number } | null;
  herfindahl: number; // 0-1 concentration index over holding weights (excl cash)
  sectorConcentration: Array<{ sector: string; weight: number }>;
  correlation: { pairs: Array<{ a: string; b: string; corr: number }>; note: string };
};

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Simple daily returns from an ascending close series. */
function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(closes[i])) {
      out.push(closes[i] / prev - 1);
    }
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

function covariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (xs[i] - mx) * (ys[i] - my);
  return acc / (n - 1);
}

/** Pearson correlation over the overlapping prefix of two return series. */
function correlation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const a = xs.slice(0, n);
  const b = ys.slice(0, n);
  const sx = Math.sqrt(variance(a));
  const sy = Math.sqrt(variance(b));
  if (sx === 0 || sy === 0) return null;
  return covariance(a, b) / (sx * sy);
}

/** Total return over the window from first to last close. */
function periodReturnPct(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!(first > 0)) return null;
  return (last / first - 1) * 100;
}

export async function buildRiskAnalysis(): Promise<RiskAnalysis> {
  const portfolio = await buildPortfolio();
  const holdings: Holding[] = portfolio.holdings;

  // Fetch ~6mo daily closes for each holding + the benchmark in parallel.
  const [benchCandles, ...holdingCandles] = await Promise.all([
    getStockHistory(BENCHMARK, { interval: "1d", monthsBack: MONTHS_BACK }),
    ...holdings.map((h) =>
      getStockHistory(h.ticker, { interval: "1d", monthsBack: MONTHS_BACK })
    ),
  ]);

  const benchCloses = benchCandles.map((c) => c.close);
  const benchReturns = dailyReturns(benchCloses);
  const benchVar = variance(benchReturns);
  const benchReturnPct = periodReturnPct(benchCloses);

  // Per-holding series cache (closes + returns), aligned by ticker order.
  const series = holdings.map((h, i) => {
    const closes = holdingCandles[i].map((c) => c.close);
    return { ticker: h.ticker, closes, returns: dailyReturns(closes) };
  });

  // 1. Relative strength: 6mo return and vs-benchmark spread.
  const relativeStrength = series.map((s) => {
    const ret = periodReturnPct(s.closes);
    const vs = ret != null && benchReturnPct != null ? ret - benchReturnPct : null;
    return {
      ticker: s.ticker,
      sixMonthReturnPct: ret != null ? round(ret) : null,
      vsBenchmarkPct: vs != null ? round(vs) : null,
    };
  });

  // 2. Portfolio beta = weight-weighted sum of per-holding betas vs benchmark.
  //    Weights are the fractional invested weights (excl. cash), so beta is
  //    measured over the equity book rather than diluted by the cash drag.
  const investedWeightTotal = holdings.reduce((s, h) => s + h.portfolioWeight, 0);
  let portfolioBeta: number | null = null;
  if (benchVar > 0 && investedWeightTotal > 0) {
    let acc = 0;
    let covered = 0;
    for (let i = 0; i < holdings.length; i++) {
      const s = series[i];
      if (s.returns.length < 2) continue;
      const beta = covariance(s.returns, benchReturns) / benchVar;
      const w = holdings[i].portfolioWeight / investedWeightTotal;
      acc += w * beta;
      covered += w;
    }
    // Only report if we have meaningful coverage of the book.
    portfolioBeta = covered > 0 ? round(acc / covered, 2) : null;
  }

  // 3. Concentration: top holding + Herfindahl over fractional invested weights.
  let topConcentration: { ticker: string; weight: number } | null = null;
  let herfindahl = 0;
  if (investedWeightTotal > 0) {
    const top = holdings.reduce(
      (best, h) => (h.portfolioWeight > best.portfolioWeight ? h : best),
      holdings[0]
    );
    if (top) {
      topConcentration = { ticker: top.ticker, weight: round(top.portfolioWeight) };
    }
    herfindahl = round(
      holdings.reduce((sum, h) => {
        const frac = h.portfolioWeight / investedWeightTotal;
        return sum + frac * frac;
      }, 0),
      4
    );
  }

  // 4. Sector concentration from the thematic sector grouping.
  const sectorConcentration = groupBySector(holdings).map((s) => ({
    sector: s.sector,
    weight: round(s.weight),
  }));

  // 5. Correlation: top few most-correlated holding pairs (Pearson on returns).
  const pairs: Array<{ a: string; b: string; corr: number }> = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const corr = correlation(series[i].returns, series[j].returns);
      if (corr != null) {
        pairs.push({ a: series[i].ticker, b: series[j].ticker, corr: round(corr, 3) });
      }
    }
  }
  pairs.sort((x, y) => y.corr - x.corr);
  const topPairs = pairs.slice(0, 3);

  let note: string;
  if (topPairs.length === 0) {
    note = "Insufficient overlapping history to compute pairwise correlation.";
  } else {
    const high = topPairs.filter((p) => p.corr >= 0.7);
    if (high.length > 0) {
      const names = high.map((p) => `${p.a}/${p.b}`).join(", ");
      note = `High correlation among ${names} — likely shared AI/tech beta, limiting diversification.`;
    } else if (topPairs[0].corr >= 0.4) {
      note = "Moderate co-movement across holdings; diversification benefit is partial.";
    } else {
      note = "Holdings are largely uncorrelated over the window.";
    }
  }

  return {
    benchmark: BENCHMARK,
    relativeStrength,
    portfolioBeta,
    topConcentration,
    herfindahl,
    sectorConcentration,
    correlation: { pairs: topPairs, note },
  };
}
