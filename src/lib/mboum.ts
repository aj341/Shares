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

/**
 * Daily price history, ascending by date. `monthsBack` trims the series to a
 * recent window (default ~6 months). Returns [] on failure.
 */
export async function getStockHistory(
  symbol: string,
  opts: { interval?: "1d" | "1wk"; monthsBack?: number } = {}
): Promise<MboumCandle[]> {
  const { interval = "1d", monthsBack = 6 } = opts;
  const data = await safe(() =>
    mboumGet<MboumHistoryResponse>("/markets/stock/history", {
      symbol,
      interval,
      diffandsplits: "false",
    })
  );
  if (!data?.body) return [];

  const cutoff = Math.floor(Date.now() / 1000) - monthsBack * 31 * 24 * 60 * 60;

  return Object.values(data.body)
    .filter((c) => c && Number.isFinite(c.close) && c.date_utc >= cutoff)
    .map((c) => ({
      date: c.date,
      dateUtc: c.date_utc,
      close: c.close,
      adjClose: c.adjclose ?? c.close,
    }))
    .sort((a, b) => a.dateUtc - b.dateUtc);
}

/**
 * Alias requested by the data-provider spec. Accepts either a months window
 * (number) or an options object; defaults to ~6 months of daily prices.
 */
export function getHistoricalPrices(
  symbol: string,
  rangeOrOpts: number | { interval?: "1d" | "1wk"; monthsBack?: number } = 6
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
