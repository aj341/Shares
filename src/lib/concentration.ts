// [sizing] Position-sizing / concentration module.
//
// Pure, null-safe concentration analytics derived from live holdings + weights.
// This is a NEW file (no behaviour change on import). The redistribution engine
// opts in to these limits to avoid funnelling capital into already-concentrated
// names; the UI surfaces the metrics + limit status additively.
//
// Sector classification reuses the existing thematic map in `src/lib/sectors.ts`
// (sectorFor / SECTOR_BY_TICKER). The task brief asked for a small local
// TICKER->sector map, but one already exists and is shared by the Sector
// Allocation panel and risk.ts, so we reuse it rather than duplicate. NOTE for
// integration: the `// [factors]` feature introduces a SECTOR_ETF map -- during
// merge, consolidate SECTOR_BY_TICKER (thematic labels) and SECTOR_ETF
// (benchmark ETF per sector) into one source of truth.

import type { Holding } from "@/lib/types";
import { sectorFor } from "@/lib/sectors";
import { CONCENTRATION_LIMITS } from "@/lib/constants";

/** Per-limit breach status. */
export type ConcentrationStatus = "OK" | "WARN" | "BREACH";

/** Overall portfolio concentration grade (best -> worst). */
export type ConcentrationGrade = "A" | "B" | "C" | "D";

/**
 * Configurable concentration limits. All are fractions of total equity unless
 * noted. Defaults live in constants (CONCENTRATION_LIMITS) and are fully
 * visible/overridable.
 */
export type ConcentrationLimits = {
  /** Hard cap on any single name's weight (e.g. 0.30 = 30%). */
  maxSingleNameWeight: number;
  /** Soft warning threshold for a single name (e.g. 0.25 = 25%). */
  warnSingleName: number;
  /** Hard cap on the top-3 combined weight (e.g. 0.65 = 65%). */
  maxTop3: number;
  /** Hard cap on any single sector's weight (e.g. 0.50 = 50%). */
  maxSectorWeight: number;
};

/** Raw concentration metrics (all weights are FRACTIONS 0..1, equity-relative
 *  unless the field name says otherwise). Null-safe: empty book -> zeros. */
export type ConcentrationMetrics = {
  /** Number of equity names (excludes cash). */
  nameCount: number;
  /** Largest single-name weight as a fraction of EQUITY (excl cash). */
  largestSingleNameWeight: number;
  /** Ticker of the largest name (null when no holdings). */
  largestSingleNameTicker: string | null;
  /** Top-3 combined weight as a fraction of EQUITY. */
  top3Weight: number;
  /** Herfindahl-Hirschman Index over equity weights (0..1). */
  hhi: number;
  /** Effective number of names = 1 / HHI (null when HHI is 0). */
  effectiveNames: number | null;
  /** Cash as a fraction of the TOTAL book (incl cash). */
  cashWeight: number;
  /** Top sector by combined equity weight. */
  topSector: string | null;
  /** Top sector's combined weight as a fraction of EQUITY. */
  topSectorWeight: number;
};

/** One evaluated limit: metric value vs limit, with status + message. */
export type LimitAssessment = {
  key: "singleName" | "top3" | "sector";
  label: string;
  /** Observed value (fraction 0..1). */
  value: number;
  /** The limit that applies (fraction 0..1). */
  limit: number;
  status: ConcentrationStatus;
  /** Human-readable explanation of WHY this is OK/WARN/BREACH. */
  message: string;
  /** The name/sector driving the value (for trim targeting). */
  subject: string | null;
};

export type ConcentrationAssessment = {
  metrics: ConcentrationMetrics;
  limits: ConcentrationLimits;
  assessments: LimitAssessment[];
  /** Worst status across all limits. */
  overallStatus: ConcentrationStatus;
  /** Letter grade derived from HHI + breach count. */
  grade: ConcentrationGrade;
  /** Suggested max $ per name from the single-name risk budget (equity-based). */
  maxDollarsPerName: number;
  /** Human-readable breach/warning lines (empty when all OK). */
  messages: string[];
};

const round = (n: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Compute raw concentration metrics from holdings. `portfolioWeight` on each
 * holding is a PERCENT of the total book (incl cash); we normalise to equity
 * fractions here so single-name / top-3 / HHI are measured over the invested
 * book rather than diluted by cash. Fully null-safe.
 */
export function computeConcentrationMetrics(
  holdings: Holding[]
): ConcentrationMetrics {
  const safe = (holdings ?? []).filter((h) => h && h.marketValue > 0);

  const equityValue = safe.reduce((s, h) => s + h.marketValue, 0);
  // Total book weight is derived from portfolioWeight (% of total incl cash).
  const equityBookPct = safe.reduce((s, h) => s + h.portfolioWeight, 0);
  const cashWeight = Math.max(0, Math.min(1, 1 - equityBookPct / 100));

  if (safe.length === 0 || equityValue <= 0) {
    return {
      nameCount: 0,
      largestSingleNameWeight: 0,
      largestSingleNameTicker: null,
      top3Weight: 0,
      hhi: 0,
      effectiveNames: null,
      cashWeight: round(cashWeight),
      topSector: null,
      topSectorWeight: 0,
    };
  }

  // [total-basis] Weights are a fraction of the TOTAL portfolio (incl cash) =
  // portfolioWeight/100, so the cap matches the weights shown on the dashboard
  // rather than an equity-only (cash-excluded) basis.
  const fracs = safe
    .map((h) => ({ ticker: h.ticker, frac: h.portfolioWeight / 100 }))
    .sort((a, b) => b.frac - a.frac);

  const largest = fracs[0];
  const top3 = fracs.slice(0, 3).reduce((s, x) => s + x.frac, 0);
  const hhi = fracs.reduce((s, x) => s + x.frac * x.frac, 0);

  const bySector = new Map<string, number>();
  for (const h of safe) {
    const sector = sectorFor(h.ticker);
    bySector.set(sector, (bySector.get(sector) ?? 0) + h.portfolioWeight / 100);
  }
  let topSector: string | null = null;
  let topSectorWeight = 0;
  for (const [sector, w] of bySector) {
    if (w > topSectorWeight) {
      topSector = sector;
      topSectorWeight = w;
    }
  }

  return {
    nameCount: safe.length,
    largestSingleNameWeight: round(largest.frac),
    largestSingleNameTicker: largest.ticker,
    top3Weight: round(top3),
    hhi: round(hhi),
    effectiveNames: hhi > 0 ? round(1 / hhi, 2) : null,
    cashWeight: round(cashWeight),
    topSector,
    topSectorWeight: round(topSectorWeight),
  };
}

/** Status for a value against a hard limit + optional soft warn threshold. */
function statusFor(value: number, limit: number, warn?: number): ConcentrationStatus {
  if (value > limit + 1e-9) return "BREACH";
  if (warn != null && value >= warn - 1e-9) return "WARN";
  if (warn == null && value >= limit * 0.9) return "WARN"; // within 90% of cap
  return "OK";
}

const pct = (f: number): string => `${(f * 100).toFixed(1)}%`;

/**
 * Pure assessment: metrics + per-limit status + human-readable messages.
 * Limits are configurable; defaults come from constants.
 */
export function assessConcentration(
  holdings: Holding[],
  limits: ConcentrationLimits = CONCENTRATION_LIMITS,
  /** Total EQUITY value (USD or display ccy) for the $-per-name budget. Optional. */
  totalEquity?: number
): ConcentrationAssessment {
  const metrics = computeConcentrationMetrics(holdings);

  const single: LimitAssessment = {
    key: "singleName",
    label: "Largest single name",
    value: metrics.largestSingleNameWeight,
    limit: limits.maxSingleNameWeight,
    status: statusFor(
      metrics.largestSingleNameWeight,
      limits.maxSingleNameWeight,
      limits.warnSingleName
    ),
    subject: metrics.largestSingleNameTicker,
    message: "",
  };
  single.message =
    single.status === "BREACH"
      ? `${single.subject ?? "Top name"} is ${pct(single.value)} of portfolio, over the ${pct(single.limit)} single-name cap -- trim to reduce idiosyncratic risk.`
      : single.status === "WARN"
        ? `${single.subject ?? "Top name"} is ${pct(single.value)} of portfolio, approaching the ${pct(single.limit)} cap (warn at ${pct(limits.warnSingleName)}).`
        : `Largest name ${pct(single.value)} is within the ${pct(single.limit)} cap.`;

  const top3: LimitAssessment = {
    key: "top3",
    label: "Top-3 combined",
    value: metrics.top3Weight,
    limit: limits.maxTop3,
    status: statusFor(metrics.top3Weight, limits.maxTop3),
    subject: null,
    message: "",
  };
  top3.message =
    top3.status === "BREACH"
      ? `Top 3 names are ${pct(top3.value)} of portfolio, over the ${pct(top3.limit)} limit -- book is highly concentrated.`
      : top3.status === "WARN"
        ? `Top 3 names are ${pct(top3.value)} of portfolio, near the ${pct(top3.limit)} limit.`
        : `Top 3 names ${pct(top3.value)} within the ${pct(top3.limit)} limit.`;

  const sector: LimitAssessment = {
    key: "sector",
    label: "Top sector",
    value: metrics.topSectorWeight,
    limit: limits.maxSectorWeight,
    status: statusFor(metrics.topSectorWeight, limits.maxSectorWeight),
    subject: metrics.topSector,
    message: "",
  };
  sector.message =
    sector.status === "BREACH"
      ? `${sector.subject ?? "Top sector"} is ${pct(sector.value)} of portfolio, over the ${pct(sector.limit)} sector cap -- diversify across themes.`
      : sector.status === "WARN"
        ? `${sector.subject ?? "Top sector"} is ${pct(sector.value)} of portfolio, approaching the ${pct(sector.limit)} sector cap.`
        : `Top sector ${sector.subject ? `(${sector.subject}) ` : ""}${pct(sector.value)} within the ${pct(sector.limit)} cap.`;

  const assessments = [single, top3, sector];

  const overallStatus: ConcentrationStatus = assessments.some((a) => a.status === "BREACH")
    ? "BREACH"
    : assessments.some((a) => a.status === "WARN")
      ? "WARN"
      : "OK";

  // Grade: blend HHI (diversification) with the number of hard breaches.
  const breaches = assessments.filter((a) => a.status === "BREACH").length;
  let grade: ConcentrationGrade;
  if (breaches >= 2 || metrics.hhi >= 0.4) grade = "D";
  else if (breaches === 1 || metrics.hhi >= 0.3) grade = "C";
  else if (metrics.hhi >= 0.2 || overallStatus === "WARN") grade = "B";
  else grade = "A";

  const equity =
    totalEquity ?? (holdings ?? []).reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  const maxDollarsPerName = round(equity * limits.maxSingleNameWeight, 2);

  const messages = assessments
    .filter((a) => a.status !== "OK")
    .map((a) => a.message);

  return {
    metrics,
    limits,
    assessments,
    overallStatus,
    grade,
    maxDollarsPerName,
    messages,
  };
}
