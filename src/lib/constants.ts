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
  { ticker: "MSFT", companyName: "Microsoft Corporation", shares: 15, entryPrice: 461.44 },
  { ticker: "RBLX", companyName: "Roblox Corporation", shares: 30, entryPrice: 89.95 },
  { ticker: "GOOG", companyName: "Alphabet Inc. (Class C)", shares: 50, entryPrice: 351.37 },
  { ticker: "PLTR", companyName: "Palantir Technologies Inc.", shares: 60, entryPrice: 135.66 },
  { ticker: "MDB", companyName: "MongoDB, Inc.", shares: 20, entryPrice: 372.24 },
  { ticker: "NBIS", companyName: "Nebius Group N.V.", shares: 100, entryPrice: 217.04 },
];

/** Cash position tracked in app state (proceeds from the ARM sale live here). */
export const CURRENT_CASH = 33541.78;

// ---------------------------------------------------------------------------
// Portfolio rules
// ---------------------------------------------------------------------------

export const PORTFOLIO_RULES = {
  /** Maximum single-position weight. */
  maxPositionWeight: 0.35,
  /** Cash buffer to retain, as a fraction of total portfolio value. */
  targetCashBufferPct: 0.05,
  /** Whole-share rounding only — no fractional trades. */
  wholeSharesOnly: true,
  /** Ignore trims whose notional value is below this (AUD). */
  minTradeSize: 250,
} as const;

// ---------------------------------------------------------------------------
// Scoring engine config
// ---------------------------------------------------------------------------

export const CATEGORY_WEIGHTS: Record<MetricCategory, number> = {
  trend: 20,
  momentum: 20,
  valuation: 20,
  fundamental: 20,
  risk: 10,
  sentiment: 10,
};

/** Expected metric count per category (20 metrics total). */
export const CATEGORY_METRIC_COUNTS: Record<MetricCategory, number> = {
  trend: 4,
  momentum: 4,
  valuation: 4,
  fundamental: 3,
  risk: 3,
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
