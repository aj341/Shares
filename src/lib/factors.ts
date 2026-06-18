import "server-only";
import type { FactorScores, Metric, MetricCategory, RelativeStrength } from "@/lib/types";
import { clamp } from "@/lib/utils";
import {
  annualisedVol,
  computeRelativeStrength,
  momentum12_1,
  type RelativeStrengthRaw,
} from "@/lib/relative-strength";

/**
 * [factors] Composite factor scoring + cross-sectional ranking.
 *
 * ADDITIVE dimension layered beside (never inside) the existing 0-100 score.
 * Each sub-factor is normalised to 0..100 ("higher is better"); the composite
 * is their simple mean over the available sub-factors. Value & quality reuse
 * the statuses already computed by scoring.ts / live-metrics.ts (no new data
 * fetch), so the factor view stays consistent with the metric grid.
 */

const STATUS_POINTS = { positive: 1, neutral: 0.5, negative: 0 } as const;

/** Mean of a metric category's statuses, scaled 0..100; null if no metrics. */
function categoryScore(metrics: Metric[], category: MetricCategory): number | null {
  const inCat = metrics.filter((m) => m.category === category);
  if (inCat.length === 0) return null;
  const pts = inCat.reduce((s, m) => s + STATUS_POINTS[m.status], 0);
  return (pts / inCat.length) * 100;
}

/**
 * Map a raw return/vol figure to a 0..100 sub-factor via a clamped linear
 * scale. `lo` maps to 0, `hi` to 100. For low-vol, pass lo > hi so that lower
 * realised vol scores higher.
 */
function scale(value: number, lo: number, hi: number): number {
  if (hi === lo) return 50;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
}

export type FactorInput = {
  ticker: string;
  /** Adjusted daily closes (ascending). May be empty when history is missing. */
  closes: number[];
  /** Pre-loaded benchmark/ETF closes-by-symbol (from loadBenchmarkBundle). */
  bundle: Record<string, number[]>;
  /** The holding/watchlist 20-metric set (for value & quality reuse). */
  metrics: Metric[];
};

export type FactorBundle = {
  relativeStrengthRaw: RelativeStrengthRaw;
  factors: FactorScores;
};

/**
 * Pure per-name factor computation. Null-safe: missing history collapses the
 * momentum/low-vol sub-factors to null and the composite averages what's left
 * (or is null when nothing is available).
 */
export function computeFactorBundle(input: FactorInput): FactorBundle {
  const { ticker, closes, bundle, metrics } = input;
  const rs = computeRelativeStrength(ticker, closes, bundle);

  // Momentum: 12-1 (or 6m fallback). -20%..+60% -> 0..100.
  const momRaw = momentum12_1(closes);
  const momentum = momRaw != null ? scale(momRaw, -0.2, 0.6) : null;

  // Low-vol: annualised realised vol over ~3m. 80% vol -> 0, 20% vol -> 100.
  const volRaw = annualisedVol(closes, 63);
  const lowVol = volRaw != null ? scale(volRaw, 0.8, 0.2) : null;

  // Value & quality reuse existing metric statuses (no extra fetch).
  const value = categoryScore(metrics, "valuation");
  const quality = categoryScore(metrics, "fundamental");

  const parts = [momentum, lowVol, value, quality].filter(
    (x): x is number => x != null
  );
  const composite =
    parts.length > 0
      ? Math.round(parts.reduce((s, x) => s + x, 0) / parts.length)
      : null;

  const round = (x: number | null) => (x == null ? null : Math.round(x));

  return {
    relativeStrengthRaw: rs,
    factors: {
      momentum: round(momentum),
      lowVol: round(lowVol),
      value: round(value),
      quality: round(quality),
      composite,
      momentumRaw: momRaw,
      volRaw,
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-sectional ranking
// ---------------------------------------------------------------------------

/** Minimal shape a rankable name must expose for the ranker. */
export type RankableInput = {
  ticker: string;
  relativeStrengthRaw: RelativeStrengthRaw;
  factors: FactorScores;
};

export type RankedFactors = {
  /** Final additive RS field carried on the holding / watchlist item. */
  relativeStrength: RelativeStrength;
  factors: FactorScores;
};

/** 1-based rank + percentile for a sorted set; higher metric -> rank 1. */
function rankBy<T>(
  items: T[],
  key: (t: T) => number | null
): Map<number, { rank: number; percentile: number }> {
  // Index items that have a usable value; sort desc; assign dense ranks.
  const withVal = items
    .map((it, i) => ({ i, v: key(it) }))
    .filter((x): x is { i: number; v: number } => x.v != null);
  withVal.sort((a, b) => b.v - a.v);
  const n = withVal.length;
  const out = new Map<number, { rank: number; percentile: number }>();
  withVal.forEach((x, idx) => {
    const rank = idx + 1;
    // Percentile: rank 1 -> ~100, last -> low. 0..100, higher is better.
    const percentile = n > 1 ? Math.round(((n - idx) / n) * 100) : 100;
    out.set(x.i, { rank, percentile });
  });
  return out;
}

/**
 * Rank a combined set (holdings + watchlist) cross-sectionally. Pure: takes the
 * per-name factor bundles, returns rank/percentile keyed back to each input.
 * Names ranked by 6m-vs-QQQ relative strength (primary surfaced rank) AND by
 * composite factor score (secondary). Missing values are left unranked (null).
 */
export function rankCrossSection(items: RankableInput[]): RankedFactors[] {
  const rsRank = rankBy(items, (it) => it.relativeStrengthRaw.vsQqq6m);
  const compRank = rankBy(items, (it) => it.factors.composite);

  return items.map((it, i) => {
    const r = rsRank.get(i) ?? null;
    const c = compRank.get(i) ?? null;
    const raw = it.relativeStrengthRaw;
    return {
      relativeStrength: {
        ret3m: raw.ret3m,
        ret6m: raw.ret6m,
        vsQqq3m: raw.vsQqq3m,
        vsQqq6m: raw.vsQqq6m,
        vsSector3m: raw.vsSector3m,
        vsSector6m: raw.vsSector6m,
        sectorEtf: raw.sectorEtf,
        rank: r?.rank ?? null,
        percentile: r?.percentile ?? null,
        universeSize: items.length,
      },
      factors: {
        ...it.factors,
        compositeRank: c?.rank ?? null,
        compositePercentile: c?.percentile ?? null,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Metric rows (additive — render in the existing MetricGrid)
// ---------------------------------------------------------------------------

const pct = (x: number | null) =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/**
 * Build additive Metric rows from an RS + factors result. Category is "trend"
 * so they render in the existing MetricGrid Trend card without a UI change.
 * Status is derived transparently from the value's sign / magnitude.
 */
export function buildFactorMetrics(
  rs: RelativeStrength,
  f: FactorScores
): Metric[] {
  const rows: Metric[] = [];

  const rsStatus = (v: number | null) =>
    v == null ? "neutral" : v > 0.02 ? "positive" : v < -0.02 ? "negative" : "neutral";

  rows.push({
    name: "Rel. strength 6M vs QQQ",
    value: pct(rs.vsQqq6m),
    category: "trend",
    status: rsStatus(rs.vsQqq6m),
    description:
      rs.vsQqq6m == null
        ? "6-month return vs QQQ unavailable (insufficient history)."
        : `6-month total return ${rs.vsQqq6m >= 0 ? "ahead of" : "behind"} the QQQ benchmark.`,
  });

  rows.push({
    name: "Rel. strength 3M vs QQQ",
    value: pct(rs.vsQqq3m),
    category: "trend",
    status: rsStatus(rs.vsQqq3m),
    description:
      rs.vsQqq3m == null
        ? "3-month return vs QQQ unavailable (insufficient history)."
        : `3-month total return ${rs.vsQqq3m >= 0 ? "ahead of" : "behind"} the QQQ benchmark.`,
  });

  if (rs.sectorEtf && rs.vsSector6m != null) {
    rows.push({
      name: `Rel. strength 6M vs ${rs.sectorEtf}`,
      value: pct(rs.vsSector6m),
      category: "trend",
      status: rsStatus(rs.vsSector6m),
      description: `6-month total return vs the ${rs.sectorEtf} sector ETF.`,
    });
  }

  if (rs.rank != null && rs.universeSize > 1) {
    const top = rs.percentile != null && rs.percentile >= 67;
    const bottom = rs.percentile != null && rs.percentile <= 33;
    rows.push({
      name: "RS rank (book + watchlist)",
      value: `#${rs.rank}/${rs.universeSize}`,
      category: "trend",
      status: top ? "positive" : bottom ? "negative" : "neutral",
      description: `Cross-sectional relative-strength rank across holdings + watchlist (${rs.percentile}th pct).`,
    });
  }

  if (f.composite != null) {
    rows.push({
      name: "Factor composite",
      value: `${f.composite}/100`,
      category: "trend",
      status: f.composite >= 60 ? "positive" : f.composite < 40 ? "negative" : "neutral",
      description:
        "Equal-weight blend of momentum, low-volatility, value and quality sub-factors (0-100).",
    });
  }

  return rows;
}
