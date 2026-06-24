import type { MetricCategory, Signal, DataSource } from "@/lib/types";

/**
 * Static portfolio inputs and engine configuration.
 * Edit POSITIONS / CURRENT_CASH here to reflect the live book.
 */

export type PositionInput = {
  ticker: string;
  companyName: string;
  shares: number;
  entryPrice: number;
};

/** Active Nasdaq holdings. ARM was fully sold and is intentionally excluded. */
export const POSITIONS: PositionInput[] = [
  { ticker: "MSFT", companyName: "Microsoft Corporation", shares: 35, entryPrice: 442.26 },
  { ticker: "RBLX", companyName: "Roblox Corporation", shares: 30, entryPrice: 89.95 },
  { ticker: "GOOG", companyName: "Alphabet Inc. (Class C)", shares: 50, entryPrice: 351.37 },
  { ticker: "PLTR", companyName: "Palantir Technologies Inc.", shares: 60, entryPrice: 135.66 },
  { ticker: "MDB", companyName: "MongoDB, Inc.", shares: 20, entryPrice: 372.24 },
  { ticker: "NBIS", companyName: "Nebius Group N.V.", shares: 100, entryPrice: 217.04 },
];

/** Cash position tracked in app state (proceeds from the ARM sale live here). */
export const CURRENT_CASH = 33541.78;

/** Display currency for portfolio values & cash (US equities stay USD-priced). */
export const DISPLAY_CURRENCY = "AUD";

/**
 * Real multi-currency cash balances (from the broker). Values are the AUD
 * market value of each currency bucket (matching the broker's "Market Value"
 * column), so they sum directly to total cash in AUD. Shown as a combined AUD
 * total everywhere, with the per-currency breakdown in the dedicated Cash
 * section. Edit here to update.
 */
export type CashCurrency = "AUD" | "EUR" | "GBP" | "USD";
export const CASH_BALANCES: { currency: CashCurrency; amountAud: number }[] = [
  { currency: "AUD", amountAud: 793.24 },
  { currency: "EUR", amountAud: 115.65 },
  { currency: "GBP", amountAud: 56.24 },
  { currency: "USD", amountAud: 0 },
];

// ---------------------------------------------------------------------------
// Portfolio rules
// ---------------------------------------------------------------------------

export const PORTFOLIO_RULES = {
  /** Maximum single-position weight. */
  maxPositionWeight: 0.35,
  /** Cash buffer to retain, as a fraction of total portfolio value.
   *  0 = fully invested: deploy all available cash, hold no dry powder. */
  targetCashBufferPct: 0,
  /** Whole-share rounding only — no fractional trades. */
  wholeSharesOnly: true,
  /** Ignore trims whose notional value is below this (AUD). */
  minTradeSize: 250,
  /** [trim-to-target] Weak-scored names (40–54) are trimmed straight DOWN to
   *  this target weight (fraction of total portfolio value) in a SINGLE move,
   *  instead of repeatedly slicing 30%. If already at/under it, hold. */
  weakTrimTargetWeight: 0.05,
} as const;

// ---------------------------------------------------------------------------
// [sizing] Concentration / position-sizing limits
// ---------------------------------------------------------------------------

/**
 * Portfolio-level concentration limits consumed by `assessConcentration`
 * (src/lib/concentration.ts) and, opt-in, by the redistribution engine.
 *
 * All values are FRACTIONS of the TOTAL portfolio (incl. cash) — matching the weights shown on the dashboard. Every
 * default is visible and overridable here. Note: `maxSingleNameWeight` (0.30)
 * is the EFFECTIVE single-name cap the redistribution engine binds to for the
 * BUY gate, the phase-3 position cap and its rationale strings — it is TIGHTER
 * than (and supersedes) PORTFOLIO_RULES.maxPositionWeight (0.35), which now only
 * governs the scoring "over the cap" override and the legacy display metric.
 * [decfix] Reconciled so there is one coherent single-name number (30%).
 */
export const CONCENTRATION_LIMITS = {
  /** Hard cap on any single name (30% of equity). */
  maxSingleNameWeight: 0.30,
  /** Soft warning threshold for a single name (25% of equity). */
  warnSingleName: 0.25,
  /** Hard cap on the top-3 combined weight (65% of equity). */
  maxTop3: 0.65,
  /** Hard cap on any single sector's weight (50% of equity). */
  maxSectorWeight: 0.50,
} as const;

// ---------------------------------------------------------------------------
// Scoring engine config
// ---------------------------------------------------------------------------

// [score] Daily-trader recalibration (2026-06). For a short-term / intraday
// trader, price-based signals dominate: intraday time-series momentum and
// cross-sectional relative strength are the first-order alpha drivers, with
// trend continuation, liquidity/volume and the volatility regime close behind;
// valuation and fundamentals are near-irrelevant at the trade horizon and matter
// only insofar as they generate news / order flow. Sources: Intraday Time Series
// Momentum (CentAUR / ScienceDirect S138641812100001X) -- robust intraday
// momentum alpha, volatility a stronger driver than volume; "The impact of
// intraday momentum on stock returns" (Murdoch) -- intraday momentum explains
// more return variation than high-vol / mid-volume / low-liquidity conditions;
// Interday Cross-Sectional Momentum (SSRN 4934543) -- relative strength as a
// name selector; practitioner consensus on RVOL + liquidity as the primary
// intraday filters (Investors Underground, Maverick Trading, Tickeron). Weights
// still sum to 100.
//
// momentum 35: RSI, MACD, volume-vs-avg, short-term return, + new RVOL, + the
//   relative-strength-vs-QQQ row moved in from trend -- the dominant intraday edge.
// trend 25: trend health, price-vs-52w, volume-trend -- price continuation.
// risk 20: realised vol, drawdown, + new liquidity gate -- volatility regime &
//   tradability. (Position-size double-count removed: see scoring.ts Rule 4.)
// sentiment 10: news flow, analyst-revision momentum -- catalysts drive order flow.
// valuation 5 / fundamental 5: near-irrelevant intraday, kept as a small tilt.
export const CATEGORY_WEIGHTS: Record<MetricCategory, number> = {
  trend: 25,
  momentum: 35,
  valuation: 5,
  fundamental: 5,
  risk: 20,
  sentiment: 10,
};

/** Expected metric count per category (21 scored metrics total). [score]
 *  +RVOL (momentum) and +Liquidity gate (risk) added; "Earnings surprise trend"
 *  moved valuation->fundamental, "Relative strength vs QQQ" moved trend->momentum,
 *  and the position-size row neutralised (Rule-4 cap is the single owner). */
export const CATEGORY_METRIC_COUNTS: Record<MetricCategory, number> = {
  trend: 3,
  momentum: 6,
  valuation: 3,
  fundamental: 4,
  risk: 3, // realised vol, drawdown, liquidity gate (position-size row is additive)
  sentiment: 2,
};

/** Score bands → signal. Ordered high to low; first match wins. */
export const SCORE_BANDS: Array<{ min: number; max: number; signal: Signal }> = [
  { min: 85, max: 100, signal: "STRONG_BUY" },
  { min: 70, max: 84, signal: "BUY" },
  { min: 55, max: 69, signal: "HOLD" },
  { min: 40, max: 54, signal: "TRIM" },
  { min: 0, max: 39, signal: "SELL" },
];

export function signalFromScore(score: number): Signal {
  const clamped = Math.max(0, Math.min(100, score));
  const band = SCORE_BANDS.find((b) => clamped >= b.min && clamped <= b.max);
  return band?.signal ?? "HOLD";
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
export const MBOUM_BASE_URL = "https://api.mboum.com/v1";

/**
 * Selectable performance-chart ranges (client-safe). The server maps each key
 * to a concrete Mboum interval + lookback window in `performance.ts`.
 */
export type PerformanceRangeKey =
  | "1D"
  | "1W"
  | "2W"
  | "1M"
  | "3M"
  | "6M"
  | "1Y"
  | "3Y"
  | "5Y"
  | "10Y";

export const PERFORMANCE_RANGES: { key: PerformanceRangeKey; label: string }[] = [
  { key: "1D", label: "1D" },
  { key: "1W", label: "1W" },
  { key: "2W", label: "2W" },
  { key: "1M", label: "1M" },
  { key: "3M", label: "3M" },
  { key: "6M", label: "6M" },
  { key: "1Y", label: "1Y" },
  { key: "3Y", label: "3Y" },
  { key: "5Y", label: "5Y" },
  { key: "10Y", label: "10Y" },
];

export const DEFAULT_PERFORMANCE_RANGE: PerformanceRangeKey = "6M";

/** Resolved data source. Falls back to mock when no Finnhub key is present. */
export function resolveDataSource(): DataSource {
  const explicit = process.env.DATA_SOURCE?.toLowerCase();
  if (explicit === "finnhub" && process.env.FINNHUB_API_KEY) return "finnhub";
  if (explicit === "mboum" && process.env.MBOUM_API_KEY) return "mboum";
  return "mock";
}

export const STATUS_LABELS: Record<Signal, string> = {
  STRONG_BUY: "Strong Buy",
  BUY: "Buy",
  HOLD: "Hold",
  TRIM: "Trim",
  SELL: "Sell",
};
