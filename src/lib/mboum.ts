import "server-only";
import { MBOUM_BASE_URL } from "@/lib/constants";

/**
 * Mboum connector (secondary provider — historical price data).
 *
 * Finnhub's free tier does not expose candles, so Mboum (paid) is our source
 * of truth for price history that powers the performance chart. Quotes still
 * come from Finnhub via DATA_SOURCE; Mboum is used independently for history.
 *
 * Auth: `Authorization: Bearer <MBOUM_API_KEY>` against https://api.mboum.com/v1
 * History: GET /markets/stock/history?symbol=MSFT&interval=1d&diffandsplits=false
 *   -> { meta, body: { "<unix>": { date, date_utc, open, high, low, close, volume, adjclose } } }
 */

export type MboumCandle = {
  date: string; // YYYY-MM-DD
  dateUtc: number; // unix seconds
  close: number;
  adjClose: number;
  volume: number;
};

type MboumHistoryResponse = {
  meta?: Record<string, unknown>;
  body?: Record<
    string,
    {
      date: string;
      date_utc: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      adjclose: number;
    }
  >;
};

function getApiKey(): string | null {
  return process.env.MBOUM_API_KEY?.trim() || null;
}

export function isMboumConfigured(): boolean {
  return getApiKey() !== null;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[mboum] request failed:", (err as Error).message);
    }
    return null;
  }
}

/**
 * Low-level GET against the Mboum API. Public so new endpoints can be added
 * without re-implementing auth. Throws on non-2xx; callers wrap in `safe`.
 */
export async function mboumFetch<T>(
  path: string,
  params: Record<string, string | number> = {},
  revalidate = 60 * 60
): Promise<T> {
  const key = getApiKey();
  if (!key) throw new Error("MBOUM_API_KEY is not configured");

  const url = new URL(`${MBOUM_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`Mboum request failed: ${path} (${res.status})`);
  return (await res.json()) as T;
}

/** Back-compat internal alias. */
const mboumGet = mboumFetch;

/** Mboum wraps numbers as { raw, fmt }; pull the numeric value. */
type RawNum = { raw?: number; fmt?: string } | number | undefined | null;
function num(v: RawNum): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw : null;
}

export type MboumInterval = "1h" | "1d" | "1wk" | "1mo";

type HistoryOpts = {
  interval?: MboumInterval;
  /** Trim to the most recent N months. Ignored when `days` is given. */
  monthsBack?: number;
  /** Trim to the most recent N days (takes precedence over monthsBack). */
  days?: number;
};

/**
 * Price history, ascending by date. Trims the series to a recent window via
 * `days` (preferred for short/intraday ranges) or `monthsBack` (default ~6
 * months). Drops any non-positive / non-finite closes so a stale or
 * in-progress zero-value bar can't rebase the whole series to -100%.
 * Returns [] on failure.
 */
export async function getStockHistory(
  symbol: string,
  opts: HistoryOpts = {}
): Promise<MboumCandle[]> {
  const { interval = "1d", monthsBack = 6, days } = opts;
  const data = await safe(() =>
    mboumGet<MboumHistoryResponse>("/markets/stock/history", {
      symbol,
      interval,
      diffandsplits: "false",
    })
  );
  if (!data?.body) return [];

  const windowSecs =
    (days != null ? days : monthsBack * 31) * 24 * 60 * 60;
  const cutoff = Math.floor(Date.now() / 1000) - windowSecs;

  return Object.values(data.body)
    .filter(
      (c) =>
        c &&
        Number.isFinite(c.close) &&
        c.close > 0 &&
        c.date_utc >= cutoff
    )
    .map((c) => ({
      date: c.date,
      dateUtc: c.date_utc,
      close: c.close,
      adjClose: c.adjclose ?? c.close,
      volume: c.volume ?? 0,
    }))
    .sort((a, b) => a.dateUtc - b.dateUtc);
}

/**
 * Alias requested by the data-provider spec. Accepts either a months window
 * (number) or an options object; defaults to ~6 months of daily prices.
 */
export function getHistoricalPrices(
  symbol: string,
  rangeOrOpts: number | HistoryOpts = 6
): Promise<MboumCandle[]> {
  const opts =
    typeof rangeOrOpts === "number" ? { monthsBack: rangeOrOpts } : rangeOrOpts;
  return getStockHistory(symbol, opts);
}

// ---------------------------------------------------------------------------
// Fundamentals / analyst modules (via /markets/stock/modules)
// ---------------------------------------------------------------------------

function getModule<T>(symbol: string, module: string): Promise<T | null> {
  return safe(() =>
    mboumFetch<{ body?: T }>("/markets/stock/modules", { ticker: symbol, module }, 60 * 60 * 6)
  ).then((r) => r?.body ?? null);
}

export type PriceTargets = {
  high: number | null;
  low: number | null;
  mean: number | null;
  median: number | null;
  current: number | null;
  upsidePct: number | null;
};

export async function getPriceTargets(symbol: string): Promise<PriceTargets | null> {
  const b = await getModule<Record<string, RawNum>>(symbol, "financial-data");
  if (!b) return null;
  const mean = num(b.targetMeanPrice);
  const current = num(b.currentPrice);
  return {
    high: num(b.targetHighPrice),
    low: num(b.targetLowPrice),
    mean,
    median: num(b.targetMedianPrice),
    current,
    upsidePct: mean && current ? ((mean - current) / current) * 100 : null,
  };
}

export type Financials = {
  profitMargin: number | null;
  operatingMargin: number | null;
  revenueGrowth: number | null;
  grossMargin: number | null;
  totalCash: number | null;
  totalDebt: number | null;
};

export async function getFinancials(symbol: string): Promise<Financials | null> {
  const b = await getModule<Record<string, RawNum>>(symbol, "financial-data");
  if (!b) return null;
  return {
    profitMargin: num(b.profitMargins),
    operatingMargin: num(b.operatingMargins),
    revenueGrowth: num(b.revenueGrowth),
    grossMargin: num(b.grossMargins),
    totalCash: num(b.totalCash),
    totalDebt: num(b.totalDebt),
  };
}

export type RevenuePoint = { endDate: string; totalRevenue: number | null };

export async function getRevenue(symbol: string): Promise<RevenuePoint[] | null> {
  type IncomeRow = { endDate?: { fmt?: string }; totalRevenue?: RawNum };
  const b = await getModule<{
    incomeStatementHistory?: { incomeStatementHistory?: IncomeRow[] };
    incomeStatementHistoryQuarterly?: { incomeStatementHistory?: IncomeRow[] };
  }>(symbol, "income-statement");
  if (!b) return null;
  const rows =
    b.incomeStatementHistory?.incomeStatementHistory ??
    b.incomeStatementHistoryQuarterly?.incomeStatementHistory ??
    [];
  return rows.map((r) => ({
    endDate: r.endDate?.fmt ?? "",
    totalRevenue: num(r.totalRevenue),
  }));
}

export type AnalystRatings = {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  consensus: "bullish" | "neutral" | "bearish" | "mixed";
};

export type KeyStats = {
  peRatio: number | null;
  week52High: number | null;
  week52Low: number | null;
};

export async function getKeyStats(symbol: string): Promise<KeyStats | null> {
  const b = await getModule<Record<string, RawNum>>(symbol, "summary-detail");
  if (!b) return null;
  return {
    peRatio: num(b.trailingPE),
    week52High: num(b.fiftyTwoWeekHigh),
    week52Low: num(b.fiftyTwoWeekLow),
  };
}

export type UpgradeDowngrade = { firm: string; action: string; date: string };

/** Real recent analyst rating changes (firm + grade move). Empty on failure. */
export async function getUpgradeDowngrade(symbol: string): Promise<UpgradeDowngrade[]> {
  type Row = {
    epochGradeDate?: number;
    firm?: string;
    toGrade?: string;
    fromGrade?: string;
    action?: string;
  };
  const b = await getModule<{ history?: Row[] }>(symbol, "upgrade-downgrade-history");
  const rows = b?.history ?? [];
  return rows
    .slice(0, 4)
    .map((r) => {
      const date = r.epochGradeDate
        ? new Date(r.epochGradeDate * 1000).toLocaleDateString("en-AU", {
            month: "short",
            year: "numeric",
          })
        : "";
      const verb =
        r.action === "up" ? "upgraded" : r.action === "down" ? "downgraded" : "reiterated";
      const grade = r.toGrade ? ` to ${r.toGrade}` : "";
      return { firm: r.firm ?? "Analyst", action: `${verb}${grade}`, date };
    })
    .filter((r) => r.firm);
}

export async function getAnalystRatings(symbol: string): Promise<AnalystRatings | null> {
  type Trend = {
    period: string;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  };
  const b = await getModule<{ trend?: Trend[] }>(symbol, "recommendation-trend");
  const latest = b?.trend?.find((t) => t.period === "0m") ?? b?.trend?.[0];
  if (!latest) return null;

  const bullish = latest.strongBuy + latest.buy;
  const bearish = latest.sell + latest.strongSell;
  let consensus: AnalystRatings["consensus"];
  if (bullish > bearish * 2 && bullish > latest.hold) consensus = "bullish";
  else if (bearish > bullish) consensus = "bearish";
  else if (latest.hold >= bullish && latest.hold >= bearish) consensus = "neutral";
  else consensus = "mixed";

  return {
    strongBuy: latest.strongBuy,
    buy: latest.buy,
    hold: latest.hold,
    sell: latest.sell,
    strongSell: latest.strongSell,
    consensus,
  };
}

// ---------------------------------------------------------------------------
// [scanner] Movers / screener / economic-events endpoints + OHLC history.
// ADDITIVE: new exports only; nothing above is touched. Every function is
// null-safe (wrapped in `safe`) so a missing key / failed call yields [] / null
// and the scanner degrades gracefully. See src/lib/scanner.ts + econ-calendar.ts.
// ---------------------------------------------------------------------------

/**
 * [scanner] One screener row. Mboum's /markets/screener `body` is an array of
 * Yahoo-style quote objects with NUMERIC fields (unlike /movers which returns
 * formatted strings), so this is our primary candidate source. Only the fields
 * the scanner reads are typed; everything is optional/defensive.
 */
export type MboumScreenerRow = {
  symbol?: string;
  shortName?: string;
  longName?: string;
  displayName?: string;
  marketState?: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  averageDailyVolume3Month?: number;
  averageDailyVolume10Day?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChangePercent?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  marketCap?: number;
  averageAnalystRating?: string;
};

/** Screener "list" presets we use for the Battle List candidate pool. */
export type MboumScreenerList =
  | "day_gainers"
  | "day_losers"
  | "most_actives"
  | "trending"
  | "small_cap_gainers"
  | "growth_technology_stocks";

/**
 * [scanner] Pull a single screener list (cached). Returns [] on any failure or
 * missing key. `revalidate` defaults to 5 min — pre-market candidate sets move
 * but we still cache hard to stay inside Mboum quotas.
 */
export async function getScreenerList(
  list: MboumScreenerList,
  opts: { offset?: number; revalidate?: number } = {}
): Promise<MboumScreenerRow[]> {
  const { offset = 0, revalidate = 5 * 60 } = opts;
  const data = await safe(() =>
    mboumFetch<{ body?: MboumScreenerRow[] }>(
      "/markets/screener",
      { list, offset },
      revalidate
    )
  );
  return Array.isArray(data?.body) ? (data!.body as MboumScreenerRow[]) : [];
}

/**
 * [scanner] OHLC daily history (ascending), including HIGH/LOW so the scanner
 * can compute ATR. Mirrors getStockHistory's windowing + zero-bar guard but
 * keeps high/low/open (getStockHistory drops them). Returns [] on failure.
 */
export type MboumOHLC = {
  date: string;
  dateUtc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export async function getStockHistoryOHLC(
  symbol: string,
  opts: { interval?: MboumInterval; days?: number; monthsBack?: number } = {}
): Promise<MboumOHLC[]> {
  const { interval = "1d", monthsBack = 3, days } = opts;
  const data = await safe(() =>
    mboumGet<MboumHistoryResponse>("/markets/stock/history", {
      symbol,
      interval,
      diffandsplits: "false",
    })
  );
  if (!data?.body) return [];
  const windowSecs = (days != null ? days : monthsBack * 31) * 24 * 60 * 60;
  const cutoff = Math.floor(Date.now() / 1000) - windowSecs;
  return Object.values(data.body)
    .filter(
      (c) =>
        c &&
        Number.isFinite(c.close) &&
        c.close > 0 &&
        c.date_utc >= cutoff
    )
    .map((c) => ({
      date: c.date,
      dateUtc: c.date_utc,
      open: Number.isFinite(c.open) ? c.open : c.close,
      high: Number.isFinite(c.high) ? c.high : c.close,
      low: Number.isFinite(c.low) ? c.low : c.close,
      close: c.close,
      volume: c.volume ?? 0,
    }))
    .sort((a, b) => a.dateUtc - b.dateUtc);
}

/**
 * [scanner] Intraday bars (e.g. 5m/15m) for opening-range context. Mboum's
 * history endpoint only documents 1h+ intervals; we request the finest the
 * account supports and the caller treats absence as "no intraday context"
 * (graceful). Returns [] on failure.
 */
export async function getIntradayBars(
  symbol: string,
  interval: MboumInterval = "1h"
): Promise<MboumOHLC[]> {
  return getStockHistoryOHLC(symbol, { interval, days: 5 });
}

/**
 * [scanner] Raw economic-calendar events from Mboum
 * (/markets/calendar/economic_events). The documented response shape varies by
 * plan, so this returns the loosely-typed rows and the econ-calendar module
 * does the defensive field-mapping. Returns [] on failure / missing key.
 */
export type MboumEconEventRaw = Record<string, unknown>;

export async function getEconomicEventsRaw(): Promise<MboumEconEventRaw[]> {
  const data = await safe(() =>
    mboumFetch<unknown>("/markets/calendar/economic_events", {}, 60 * 60)
  );
  // Mboum may return { body: [...] }, { data: [...] }, or a bare array.
  if (Array.isArray(data)) return data as MboumEconEventRaw[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["body", "data", "events", "result"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as MboumEconEventRaw[];
      // Some feeds nest by date: { "2026-06-24": [...] }.
    }
    // Date-keyed object -> flatten arrays of rows.
    const flat: MboumEconEventRaw[] = [];
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) flat.push(...(v as MboumEconEventRaw[]));
    }
    if (flat.length > 0) return flat;
  }
  return [];
}
