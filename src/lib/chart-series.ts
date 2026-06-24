import "server-only";
import { mboumFetch } from "@/lib/mboum";
import { getQuote } from "@/lib/finnhub";
import { getIntradaySeries, type IntradaySeries } from "@/lib/intraday-chart";

/**
 * [chartframes] Multi-timeframe per-stock chart engine (Google-Finance style).
 *
 * ADDITIVE: this module is brand new and only *reads* price data. It does not
 * touch scoring, redistribution, or the existing 1D intraday engine — in fact
 * the "1D" range delegates straight to `getIntradaySeries` so the live 1D view
 * keeps its exact existing behaviour (5m bars, Finnhub prevClose, etc.).
 *
 * Ranges map to Mboum intervals and a trim window:
 *   1D  -> 5m   (today only; delegated to the intraday engine)
 *   5D  -> 30m  (last 5 calendar days)
 *   1M  -> 1d   (last ~31 days)
 *   6M  -> 1d   (last ~6 months)
 *   YTD -> 1d   (from Jan 1 of the current year)
 *   1Y  -> 1d   (last ~12 months)
 *   5Y  -> 1wk  (last ~5 years)
 *   Max -> 1mo  (everything Mboum returns)
 *
 * Every path is null-safe: any upstream failure resolves to an empty
 * `hasData:false` payload so the UI renders an empty state and never crashes.
 */

export const CHART_RANGES = [
  "1D",
  "5D",
  "1M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "MAX",
] as const;

export type ChartRange = (typeof CHART_RANGES)[number];

/** Intervals the Mboum history endpoint accepts (superset of MboumInterval). */
type ChartInterval = "5m" | "15m" | "30m" | "1d" | "1wk" | "1mo";

type RangeConfig = {
  interval: ChartInterval;
  /** Cache TTL (seconds) — shorter for fast-moving short ranges. */
  ttl: number;
  /** Trim window in days from "now". `null` for YTD (computed) / MAX (none). */
  days: number | null;
};

const RANGE_CONFIG: Record<Exclude<ChartRange, "1D">, RangeConfig> = {
  "5D": { interval: "30m", ttl: 60, days: 5 },
  "1M": { interval: "1d", ttl: 300, days: 31 },
  "6M": { interval: "1d", ttl: 300, days: 186 },
  YTD: { interval: "1d", ttl: 300, days: null },
  "1Y": { interval: "1d", ttl: 300, days: 372 },
  "5Y": { interval: "1wk", ttl: 300, days: 366 * 5 },
  MAX: { interval: "1mo", ttl: 300, days: null },
};

export type ChartPoint = {
  /** Unix seconds for the bar (ordering key). */
  t: number;
  /** ISO timestamp (UTC) for client-side formatting. */
  time: string;
  /** Close of the bar (the plotted price). */
  price: number;
};

export type ChartSeries = {
  symbol: string;
  range: ChartRange;
  hasData: boolean;
  /** Ordered (ascending) price points within the window. */
  points: ChartPoint[];
  /** First price in the window (period start). */
  open: number | null;
  /** Last price in the window. */
  last: number | null;
  /**
   * Reference price for the dashed baseline:
   *  - 1D  -> prior regular-session close (from the intraday engine)
   *  - else -> the period-start price (first bar in the window)
   */
  reference: number | null;
  /** last - reference. */
  change: number | null;
  /** % change vs reference. */
  changePct: number | null;
  /** Bar interval actually used. */
  interval: string;
  /** ISO timestamp this payload was assembled. */
  asOf: string;
};

type MboumBar = {
  date?: string;
  date_utc?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
};

type MboumHistory = {
  meta?: Record<string, unknown>;
  body?: Record<string, MboumBar>;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Normalise an arbitrary string into a known range; defaults to "1D". */
export function normalizeRange(raw: string | null | undefined): ChartRange {
  const v = (raw ?? "").trim().toUpperCase();
  return (CHART_RANGES as readonly string[]).includes(v)
    ? (v as ChartRange)
    : "1D";
}

function emptySeries(symbol: string, range: ChartRange, interval: string): ChartSeries {
  return {
    symbol,
    range,
    hasData: false,
    points: [],
    open: null,
    last: null,
    reference: null,
    change: null,
    changePct: null,
    interval,
    asOf: new Date().toISOString(),
  };
}

/** Adapt the existing 1D intraday payload into the unified ChartSeries shape. */
function fromIntraday(s: IntradaySeries): ChartSeries {
  return {
    symbol: s.symbol,
    range: "1D",
    hasData: s.hasData,
    points: s.points.map((p) => ({ t: p.t, time: p.time, price: p.price })),
    open: s.open,
    last: s.last,
    // Reference for 1D is the prior-session close (the existing dashed line).
    reference: s.prevClose,
    change: s.change,
    changePct: s.changePct,
    interval: s.interval,
    asOf: s.asOf,
  };
}

/** Start-of-year cutoff (unix seconds) for YTD. */
function startOfYearSecs(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), 0, 1) / 1000);
}

/**
 * Build a multi-timeframe series for a ticker + range. 1D delegates to the
 * existing intraday engine; all other ranges pull the mapped Mboum interval,
 * trim to the window, and rebase change off the period-start price.
 */
export async function getChartSeries(
  symbol: string,
  range: ChartRange
): Promise<ChartSeries> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return emptySeries(symbol, range, "");

  if (range === "1D") {
    return fromIntraday(await getIntradaySeries(sym));
  }

  const cfg = RANGE_CONFIG[range];
  const history = await safe(() =>
    mboumFetch<MboumHistory>(
      "/markets/stock/history",
      { symbol: sym, interval: cfg.interval, diffandsplits: "false" },
      cfg.ttl
    )
  );

  const bars = history?.body ? Object.values(history.body) : [];
  if (!bars.length) return emptySeries(sym, range, cfg.interval);

  // Clean + sort ascending; drop non-positive / non-finite closes so a stale
  // zero-value bar can't rebase the whole series.
  const clean = bars
    .filter(
      (b) => num(b.close) != null && (b.close as number) > 0 && num(b.date_utc) != null
    )
    .sort((a, b) => (a.date_utc as number) - (b.date_utc as number));

  if (!clean.length) return emptySeries(sym, range, cfg.interval);

  // Compute the trim cutoff (unix seconds).
  let cutoff = 0;
  if (range === "YTD") {
    cutoff = startOfYearSecs();
  } else if (cfg.days != null) {
    cutoff = Math.floor(Date.now() / 1000) - cfg.days * 24 * 60 * 60;
  }
  // MAX -> cutoff 0 (keep everything).

  const windowed = clean.filter((b) => (b.date_utc as number) >= cutoff);
  // If the window emptied (e.g. very early in the year for YTD), fall back to
  // the full clean series so we never show an empty chart for a live ticker.
  const used = windowed.length >= 2 ? windowed : clean;

  const points: ChartPoint[] = used.map((b) => ({
    t: b.date_utc as number,
    time: new Date((b.date_utc as number) * 1000).toISOString(),
    price: b.close as number,
  }));

  if (points.length < 2) return emptySeries(sym, range, cfg.interval);

  const open = points[0].price;
  // Prefer the live Finnhub last so the header agrees with the rest of the app;
  // fall back to the final bar close.
  const quote = await getQuote(sym); // null-safe
  const last = num(quote?.c) ?? points[points.length - 1].price;

  // Reference for longer ranges is the period-start price.
  const reference = open;
  const change = last != null && reference != null ? last - reference : null;
  const changePct =
    change != null && reference ? (change / reference) * 100 : null;

  return {
    symbol: sym,
    range,
    hasData: true,
    points,
    open,
    last,
    reference,
    change,
    changePct,
    interval: cfg.interval,
    asOf: new Date().toISOString(),
  };
}
