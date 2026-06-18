import "server-only";
import { getStockHistory, isMboumConfigured } from "@/lib/mboum";

/**
 * [factors] Relative-strength + return primitives.
 *
 * This module is the ADDITIVE cross-sectional dimension's data layer. It is
 * deliberately self-contained and does NOT touch the existing 0-100 score or
 * Signal. It computes trailing total returns from Mboum daily history and the
 * stock-minus-benchmark relative strength used by `factors.ts`.
 *
 * Efficiency: the benchmark (QQQ) and each sector ETF's history is fetched at
 * most once per build via a short-lived in-module cache, so ranking N names
 * costs N + (benchmarks) Mboum history calls, never N x benchmarks.
 */

/** ~Trading-day lookbacks. 63 ~= 3 months, 126 ~= 6 months, 252 ~= 12 months. */
export const DAYS_3M = 63;
export const DAYS_6M = 126;
export const DAYS_12M = 252;
export const DAYS_1M = 21;

/** Static sector -> representative ETF map (additive; QQQ is the fallback). */
export const SECTOR_ETF_BY_TICKER: Record<string, string> = {
  // User's tickers
  GOOG: "XLC", // Communication Services (ad tech)
  GOOGL: "XLC",
  NBIS: "SMH", // AI infrastructure -> semis proxy
  LRCX: "SMH", // Semiconductors
  MSFT: "XLK", // Technology
  MDB: "IGV", // Software
  PLTR: "IGV", // Software
  RBLX: "XLC", // Interactive media / gaming
  // Common large-cap tech / semis
  NVDA: "SMH",
  AVGO: "SMH",
  AMD: "SMH",
  MU: "SMH",
  INTC: "SMH",
  AMAT: "SMH",
  KLAC: "SMH",
  MRVL: "SMH",
  TXN: "SMH",
  ADI: "SMH",
  ASML: "SMH",
  NXPI: "SMH",
  QCOM: "SMH",
  ARM: "SMH",
  AAPL: "XLK",
  ADBE: "IGV",
  INTU: "IGV",
  WDAY: "IGV",
  SNPS: "IGV",
  CDNS: "IGV",
  DDOG: "IGV",
  TEAM: "IGV",
  CRWD: "IGV",
  PANW: "IGV",
  FTNT: "IGV",
  ZS: "IGV",
  META: "XLC",
  NFLX: "XLC",
  AMZN: "XLY", // Consumer discretionary
  BKNG: "XLY",
  ABNB: "XLY",
  MELI: "XLY",
  PDD: "XLY",
  COST: "XLP", // Consumer staples
  AXON: "XLI", // Industrials / defense-adjacent
};

/** The sector ETF for a ticker, or null when unknown (caller falls back to QQQ). */
export function sectorEtfFor(ticker: string): string | null {
  return SECTOR_ETF_BY_TICKER[ticker] ?? null;
}

/** The benchmark every name is measured against. */
export const BENCHMARK = "QQQ";

/** Trailing total return over the last `lookback` trading days; null if short. */
export function trailingReturn(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const from = closes[closes.length - 1 - lookback];
  const to = closes[closes.length - 1];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return (to - from) / from;
}

/**
 * 12-1 momentum (classic): return from ~252 days ago to ~21 days ago, excluding
 * the most recent month to dodge short-term reversal. Falls back to a plain
 * 6-month trailing return when there isn't a full year of history.
 */
export function momentum12_1(closes: number[]): number | null {
  const last = closes.length - 1;
  const startIdx = last - DAYS_12M;
  const endIdx = last - DAYS_1M;
  if (startIdx >= 0 && endIdx > startIdx) {
    const from = closes[startIdx];
    const to = closes[endIdx];
    if (Number.isFinite(from) && Number.isFinite(to) && from > 0) {
      return (to - from) / from;
    }
  }
  return trailingReturn(closes, DAYS_6M);
}

/** Annualised realised volatility from daily simple returns (lower is better). */
export function annualisedVol(closes: number[], n = 63): number | null {
  if (closes.length < n + 1) return null;
  const win = closes.slice(-(n + 1));
  const rets: number[] = [];
  for (let i = 1; i < win.length; i++) {
    if (win[i - 1] > 0) rets.push(win[i] / win[i - 1] - 1);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

// --- Benchmark / ETF history cache -----------------------------------------

const HISTORY_TTL_MS = 10 * 60 * 1000;
const histCache = new Map<string, { closes: number[]; ts: number }>();

/** Closes (ascending) for a benchmark/ETF, cached per-symbol for the build. */
export async function getBenchmarkCloses(symbol: string): Promise<number[]> {
  const hit = histCache.get(symbol);
  if (hit && Date.now() - hit.ts < HISTORY_TTL_MS) return hit.closes;
  if (!isMboumConfigured()) return [];
  const candles = await getStockHistory(symbol, { interval: "1d", monthsBack: 13 }).catch(
    () => []
  );
  const closes = candles.map((c) => c.adjClose);
  if (closes.length > 0) histCache.set(symbol, { closes, ts: Date.now() });
  return closes;
}

/**
 * Pre-fetch the benchmark plus every distinct sector ETF needed for a set of
 * tickers, returning a closes-by-symbol map. Call ONCE per build, then pass the
 * map into `computeFactorBundle` so per-name work touches no extra Mboum calls.
 */
export async function loadBenchmarkBundle(
  tickers: string[]
): Promise<Record<string, number[]>> {
  const symbols = new Set<string>([BENCHMARK]);
  for (const t of tickers) {
    const etf = sectorEtfFor(t);
    if (etf) symbols.add(etf);
  }
  const entries = await Promise.all(
    [...symbols].map(async (s) => [s, await getBenchmarkCloses(s)] as const)
  );
  return Object.fromEntries(entries);
}

export type RelativeStrengthRaw = {
  /** Stock 3M / 6M trailing total return (fraction). */
  ret3m: number | null;
  ret6m: number | null;
  /** Stock return minus QQQ return over the same window (fraction). */
  vsQqq3m: number | null;
  vsQqq6m: number | null;
  /** Stock return minus sector-ETF return (null when no ETF mapped). */
  vsSector3m: number | null;
  vsSector6m: number | null;
  /** The sector ETF used, if any. */
  sectorEtf: string | null;
};

/**
 * Compute relative-strength figures for one name from its own closes plus the
 * pre-loaded benchmark bundle. Pure + null-safe: any missing history yields a
 * null field rather than throwing.
 */
export function computeRelativeStrength(
  ticker: string,
  closes: number[],
  bundle: Record<string, number[]>
): RelativeStrengthRaw {
  const qqq = bundle[BENCHMARK] ?? [];
  const sectorEtf = sectorEtfFor(ticker);
  const sectorCloses = sectorEtf ? bundle[sectorEtf] ?? [] : [];

  const ret3m = trailingReturn(closes, DAYS_3M);
  const ret6m = trailingReturn(closes, DAYS_6M);
  const qqq3m = trailingReturn(qqq, DAYS_3M);
  const qqq6m = trailingReturn(qqq, DAYS_6M);
  const sec3m = trailingReturn(sectorCloses, DAYS_3M);
  const sec6m = trailingReturn(sectorCloses, DAYS_6M);

  const diff = (a: number | null, b: number | null) =>
    a != null && b != null ? a - b : null;

  return {
    ret3m,
    ret6m,
    vsQqq3m: diff(ret3m, qqq3m),
    vsQqq6m: diff(ret6m, qqq6m),
    vsSector3m: sectorEtf ? diff(ret3m, sec3m) : null,
    vsSector6m: sectorEtf ? diff(ret6m, sec6m) : null,
    sectorEtf,
  };
}
