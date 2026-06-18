import "server-only";
import { mboumFetch } from "@/lib/mboum";
import { getUpcomingEvents } from "@/lib/events";

/**
 * Earnings catalyst signals (ADDITIVE).
 *
 * Three orthogonal, higher-alpha reframings of earnings data:
 *
 *  1. Earnings calendar — next confirmed report date per ticker, days-until,
 *     and an `inPrePositioningWindow` flag (<= ~5 trading days out). Sourced
 *     from the Finnhub earnings calendar via the existing events layer.
 *
 *  2. Estimate revisions — are FORWARD EPS / revenue estimates being revised UP
 *     or DOWN over recent weeks? This favours estimate *revision* momentum over
 *     a static analyst rating snapshot (the higher-alpha framing). Sourced from
 *     Mboum's `earnings-trend` module (`epsTrend` current vs 7/30/60/90-days-ago
 *     plus `epsRevisions` up/down counts).
 *
 *  3. Post-earnings drift (PEAD) — from the most recent REPORTED quarter, the
 *     earnings surprise % (actual vs estimate). A positive surprise within the
 *     last ~40 trading days biases `drift_up`; a negative one `drift_down`;
 *     otherwise `none`. Sourced from Mboum's `earnings-history` module.
 *
 * Everything is null-safe and graceful: any missing key / data / failure leaves
 * the corresponding field undefined rather than throwing. This module never
 * touches the existing score or Signal math — callers attach the result as an
 * optional `earnings` field for DISPLAY ONLY.
 */

// ---------------------------------------------------------------------------
// Public type (mirrors the optional `earnings` field on Holding / WatchlistItem)
// ---------------------------------------------------------------------------

export type RevisionTrendDirection = "up" | "flat" | "down";
export type PeadSignal = "drift_up" | "drift_down" | "none";

export type EarningsSignal = {
  /** Next confirmed earnings date, YYYY-MM-DD (undefined when none known). */
  nextDate?: string;
  /** Whole calendar days until nextDate (undefined when no nextDate). */
  daysUntil?: number;
  /** True when nextDate is within ~5 trading days (~7 calendar days). */
  inPrePositioningWindow?: boolean;
  /** Most recent reported quarter date, YYYY-MM-DD. */
  lastReportDate?: string;
  /** Surprise % on the last reported quarter (actual vs estimate). */
  lastSurprisePct?: number;
  /** Are forward EPS/revenue estimates being revised up / flat / down? */
  revisionTrend?: RevisionTrendDirection;
  /** PEAD bias derived from the last surprise + its recency. */
  peadSignal?: PeadSignal;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Pre-positioning: <= ~5 trading days out ~= 7 calendar days. */
const PRE_POSITION_CALENDAR_DAYS = 7;
/** PEAD persists for ~40 trading days ~= 60 calendar days post-print. */
const PEAD_WINDOW_CALENDAR_DAYS = 60;
/** Revision-trend significance threshold (fractional drift in mean EPS est). */
const REVISION_EPS_DRIFT = 0.01; // 1% drift in the consensus estimate

const MS_PER_DAY = 86_400_000;

// In-module cache: earnings data barely changes intraday.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const NEGATIVE_TTL_MS = 30 * 60 * 1000; // retry sooner on miss
type CacheEntry = { value: EarningsSignal | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromISO: string, to: Date): number | null {
  const t = Date.parse(`${fromISO}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const today = Date.parse(`${toISODate(to)}T00:00:00Z`);
  return Math.round((t - today) / MS_PER_DAY);
}

/** Mboum wraps numbers as { raw, fmt } | number; pull the numeric value. */
type RawNum = { raw?: number; fmt?: string } | number | undefined | null;
function num(v: RawNum): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw : null;
}

async function moduleBody<T>(ticker: string, module: string): Promise<T | null> {
  try {
    const res = await mboumFetch<{ body?: T }>(
      "/markets/stock/modules",
      { ticker, module },
      60 * 60 * 6
    );
    return res?.body ?? null;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[earnings-signals] ${module} failed:`, (err as Error).message);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Estimate revisions (Mboum earnings-trend module)
// ---------------------------------------------------------------------------

type EpsTrend = {
  current?: RawNum;
  "7daysAgo"?: RawNum;
  "30daysAgo"?: RawNum;
  "60daysAgo"?: RawNum;
  "90daysAgo"?: RawNum;
};
type EpsRevisions = {
  upLast7days?: RawNum;
  upLast30days?: RawNum;
  downLast30days?: RawNum;
  downLast7days?: RawNum;
};
type TrendRow = {
  period?: string; // "0q" | "+1q" | "0y" | "+1y" ...
  epsTrend?: EpsTrend;
  epsRevisions?: EpsRevisions;
};
type EarningsTrendBody = { trend?: TrendRow[] };

/**
 * Classify forward-estimate revision momentum from the current-quarter ("0q")
 * row (falling back to next-quarter / full-year rows when "0q" has no usable
 * data). Two complementary signals are combined:
 *   - epsTrend drift: how the consensus current estimate moved vs 30d ago.
 *   - epsRevisions counts: net analysts raising vs cutting over the last 30d.
 * Returns null when neither is available.
 */
function classifyRevisionTrend(
  body: EarningsTrendBody | null
): RevisionTrendDirection | null {
  const rows = body?.trend ?? [];
  if (rows.length === 0) return null;

  const row =
    rows.find((r) => r.period === "0q") ??
    rows.find((r) => r.period === "+1q") ??
    rows.find((r) => r.period === "0y") ??
    rows[0];
  if (!row) return null;

  let score = 0;
  let signals = 0;

  // (a) epsTrend drift — current consensus vs the 30-day-ago consensus.
  const cur = num(row.epsTrend?.current);
  const ago = num(row.epsTrend?.["30daysAgo"]) ?? num(row.epsTrend?.["60daysAgo"]);
  if (cur != null && ago != null && ago !== 0) {
    const drift = (cur - ago) / Math.abs(ago);
    if (drift > REVISION_EPS_DRIFT) score += 1;
    else if (drift < -REVISION_EPS_DRIFT) score -= 1;
    signals += 1;
  }

  // (b) epsRevisions — net up vs down over the last 30 days.
  const up = num(row.epsRevisions?.upLast30days);
  const down = num(row.epsRevisions?.downLast30days);
  if (up != null || down != null) {
    const net = (up ?? 0) - (down ?? 0);
    if (net > 0) score += 1;
    else if (net < 0) score -= 1;
    signals += 1;
  }

  if (signals === 0) return null;
  if (score > 0) return "up";
  if (score < 0) return "down";
  return "flat";
}

// ---------------------------------------------------------------------------
// 3. Post-earnings drift (Mboum earnings-history module)
// ---------------------------------------------------------------------------

type HistoryRow = {
  quarter?: { fmt?: string }; // report period end date
  epsActual?: RawNum;
  epsEstimate?: RawNum;
  epsDifference?: RawNum;
  surprisePercent?: RawNum;
};
type EarningsHistoryBody = { history?: HistoryRow[] };

/**
 * Most recent reported quarter: its report date + surprise %. Mboum returns the
 * history oldest-first, so we take the last row that has a real actual EPS.
 */
function lastReportedQuarter(
  body: EarningsHistoryBody | null
): { date: string; surprisePct: number } | null {
  const rows = body?.history ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const actual = num(r.epsActual);
    const estimate = num(r.epsEstimate);
    if (actual == null || estimate == null) continue;
    const date = r.quarter?.fmt;
    if (!date) continue;

    // Prefer the API's own surprisePercent; else derive it. surprisePercent
    // from Mboum is a fraction (e.g. 0.12 = +12%); normalise to a percent.
    let surprisePct: number;
    const apiPct = num(r.surprisePercent);
    if (apiPct != null) {
      surprisePct = Math.abs(apiPct) <= 1 ? apiPct * 100 : apiPct;
    } else if (estimate !== 0) {
      surprisePct = ((actual - estimate) / Math.abs(estimate)) * 100;
    } else {
      continue;
    }
    return { date, surprisePct: Math.round(surprisePct * 10) / 10 };
  }
  return null;
}

/** PEAD bias from the last surprise and how recently it printed. */
function peadFrom(
  last: { date: string; surprisePct: number } | null,
  now: Date
): PeadSignal {
  if (!last) return "none";
  const age = daysBetween(last.date, now);
  if (age == null) return "none";
  // age is negative for past dates (date < today); within the drift window?
  if (-age > PEAD_WINDOW_CALENDAR_DAYS) return "none";
  if (last.surprisePct > 0) return "drift_up";
  if (last.surprisePct < 0) return "drift_down";
  return "none";
}

// ---------------------------------------------------------------------------
// 1. Next earnings date (Finnhub calendar via the events layer)
// ---------------------------------------------------------------------------

async function nextEarnings(
  ticker: string,
  now: Date
): Promise<{ date: string; daysUntil: number } | null> {
  // getUpcomingEvents covers a ~90-day horizon and is already safe-fetched.
  const events = await getUpcomingEvents([ticker]).catch(() => []);
  const earnings = events
    .filter((e) => e.type === "earnings" && e.ticker === ticker.toUpperCase())
    .sort((a, b) => a.daysAway - b.daysAway);
  const next = earnings[0];
  if (!next) return null;
  const daysUntil = daysBetween(next.date, now);
  return { date: next.date, daysUntil: daysUntil ?? next.daysAway };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the additive earnings signal for a single ticker. Returns null only
 * when EVERY sub-signal is unavailable; otherwise returns a partially-populated
 * object (each field independently optional). Never throws.
 */
export async function getEarningsSignal(
  ticker: string
): Promise<EarningsSignal | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  const now = Date.now();
  const hit = cache.get(symbol);
  if (hit && hit.expiresAt > now) return hit.value;

  let value: EarningsSignal | null = null;
  try {
    value = await compute(symbol);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[earnings-signals] failed:", (err as Error).message);
    }
    value = null;
  }

  cache.set(symbol, {
    value,
    expiresAt: now + (value ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
  });
  return value;
}

async function compute(symbol: string): Promise<EarningsSignal | null> {
  const now = new Date();

  const [next, trendBody, historyBody] = await Promise.all([
    nextEarnings(symbol, now),
    moduleBody<EarningsTrendBody>(symbol, "earnings-trend"),
    moduleBody<EarningsHistoryBody>(symbol, "earnings-history"),
  ]);

  const out: EarningsSignal = {};

  // 1. Calendar.
  if (next) {
    out.nextDate = next.date;
    out.daysUntil = next.daysUntil;
    out.inPrePositioningWindow =
      next.daysUntil >= 0 && next.daysUntil <= PRE_POSITION_CALENDAR_DAYS;
  }

  // 2. Estimate revisions.
  const revisionTrend = classifyRevisionTrend(trendBody);
  if (revisionTrend) out.revisionTrend = revisionTrend;

  // 3. PEAD from last reported quarter.
  const last = lastReportedQuarter(historyBody);
  if (last) {
    out.lastReportDate = last.date;
    out.lastSurprisePct = last.surprisePct;
    out.peadSignal = peadFrom(last, now);
  }

  // Null only when literally nothing resolved.
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Batch helper — resolve earnings signals for many tickers in parallel and
 * return a ticker->signal map (missing tickers simply absent). Used by the
 * /api/earnings route and the portfolio / watchlist builders.
 */
export async function getEarningsSignals(
  tickers: string[]
): Promise<Map<string, EarningsSignal>> {
  const unique = [
    ...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean)),
  ];
  const entries = await Promise.all(
    unique.map(async (t) => [t, await getEarningsSignal(t)] as const)
  );
  const map = new Map<string, EarningsSignal>();
  for (const [t, sig] of entries) if (sig) map.set(t, sig);
  return map;
}
