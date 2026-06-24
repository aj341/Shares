import {
  CATEGORY_WEIGHTS,
  PORTFOLIO_RULES,
  signalFromScore,
} from "@/lib/constants";
import { clamp } from "@/lib/utils";
import type {
  Metric,
  MetricCategory,
  ScoreBreakdown,
  Signal,
} from "@/lib/types";

/**
 * Scoring engine.
 *
 * Each metric scores 1 (positive), 0.5 (neutral) or 0 (negative). A category's
 * sub-score is the mean of its metrics scaled to 0–100. The final score is the
 * weighted sum of category sub-scores using CATEGORY_WEIGHTS (sums to 100),
 * after which the override rules are applied.
 */

const STATUS_POINTS = { positive: 1, neutral: 0.5, negative: 0 } as const;

const ALL_CATEGORIES: MetricCategory[] = [
  "trend",
  "momentum",
  "valuation",
  "fundamental",
  "risk",
  "sentiment",
];

export type ScoreContext = {
  rsi: number | null;
  unrealisedPnlPct: number;
  portfolioWeight: number; // percent (0-100)
  /** Most negative announcement impactScore for the ticker (-3..+3). */
  minAnnouncementImpact: number;
};

export type ScoreResult = {
  score: number;
  signal: Signal;
  breakdown: ScoreBreakdown;
};

function categorySubScore(metrics: Metric[], category: MetricCategory): number {
  const inCat = metrics.filter((m) => m.category === category);
  if (inCat.length === 0) return 50; // neutral default when data is missing
  const points = inCat.reduce((sum, m) => sum + STATUS_POINTS[m.status], 0);
  return (points / inCat.length) * 100;
}

/** Read the numeric RSI(14) value out of the metric set, if present. */
export function extractRsi(metrics: Metric[]): number | null {
  const rsi = metrics.find((m) => m.name === "RSI(14)");
  if (!rsi) return null;
  const n = typeof rsi.value === "number" ? rsi.value : Number(rsi.value);
  return Number.isFinite(n) ? n : null;
}

function fundamentalsNegativeCount(metrics: Metric[]): number {
  return metrics.filter(
    (m) => m.category === "fundamental" && m.status === "negative"
  ).length;
}

function valuationOrFundamentalsNegativeOverall(metrics: Metric[]): boolean {
  const fund = categorySubScore(metrics, "fundamental");
  const val = categorySubScore(metrics, "valuation");
  // "negative overall" ≈ below the neutral midpoint.
  return fund < 45 || val < 45;
}

export function scoreHolding(
  inputMetrics: Metric[],
  ctx: ScoreContext
): ScoreResult {
  // [factors] Exclude additive display-only rows (relative-strength / factor
  // rows) from ALL scoring math so the existing 0-100 score & Signal are
  // unchanged regardless of whether the caller passed display metrics.
  const metrics = inputMetrics.filter((m) => !m.additive);
  const categories = {} as Record<MetricCategory, number>;
  const weighted = {} as Record<MetricCategory, number>;

  for (const cat of ALL_CATEGORIES) {
    const sub = categorySubScore(metrics, cat);
    categories[cat] = Math.round(sub);
    weighted[cat] = (sub * CATEGORY_WEIGHTS[cat]) / 100;
  }

  const rawScore = Math.round(
    ALL_CATEGORIES.reduce((sum, cat) => sum + weighted[cat], 0)
  );

  let score = rawScore;
  const overridesApplied: string[] = [];
  let forceTrim = false;

  const rsi = ctx.rsi;

  // Rule 1: overbought + large gain → reduce 5–10 pts and force TRIM if needed.
  if (rsi !== null && rsi > 75 && ctx.unrealisedPnlPct > 20) {
    score -= 8;
    overridesApplied.push(
      `Overbought (RSI ${rsi} > 75) with +${ctx.unrealisedPnlPct.toFixed(
        1
      )}% gain → −8 pts, bias to TRIM`
    );
    forceTrim = true;
  }

  // Rule 2: oversold but fundamentals/valuation not negative → modest bump.
  if (
    rsi !== null &&
    rsi < 30 &&
    !valuationOrFundamentalsNegativeOverall(metrics)
  ) {
    score += 5;
    overridesApplied.push(
      `Oversold (RSI ${rsi} < 30) with sound fundamentals/valuation → +5 pts`
    );
  }

  // Rule 3: multiple weak fundamentals + negative announcement → cap at 39.
  if (fundamentalsNegativeCount(metrics) >= 2 && ctx.minAnnouncementImpact <= -2) {
    if (score > 39) {
      overridesApplied.push(
        "≥2 negative fundamentals + announcement impact ≤ −2 → score capped at 39"
      );
    }
    score = Math.min(score, 39);
  }

  // Rule 4: over the position cap → cap at 79.
  // [score] SINGLE OWNER of position-size effect. The "Position size vs 35% cap"
  // metric is built as additive (display-only) in live-metrics.ts / mock-data.ts
  // so it no longer feeds the risk sub-score — this hard cap is the only place
  // position weight changes the score, removing the previous double-count.
  const capPct = PORTFOLIO_RULES.maxPositionWeight * 100;
  if (ctx.portfolioWeight > capPct) {
    if (score > 79) {
      overridesApplied.push(
        `Position weight ${ctx.portfolioWeight.toFixed(1)}% > ${capPct}% cap → score capped at 79`
      );
    }
    score = Math.min(score, 79);
  }

  score = clamp(Math.round(score), 0, 100);

  let signal = signalFromScore(score);
  // Forced TRIM: don't let an overbought, over-extended position read as a buy/hold.
  if (forceTrim && (score >= 55 || signal === "STRONG_BUY" || signal === "BUY" || signal === "HOLD")) {
    score = Math.min(score, 54);
    signal = signalFromScore(score);
    overridesApplied.push("Forced signal to TRIM band (≤54)");
  }

  return {
    score,
    signal,
    breakdown: { categories, weighted, rawScore, overridesApplied },
  };
}
