import "server-only";
import { FINNHUB_BASE_URL } from "@/lib/constants";

/**
 * Finnhub connector (primary market-data provider).
 *
 * Auth: FINNHUB_API_KEY via the `token` query param (Finnhub also accepts the
 * `X-Finnhub-Token` header — we send both for resilience).
 *
 * Docs:
 *  - Quote:                https://finnhub.io/docs/api/quote
 *  - Company news:         https://finnhub.io/docs/api/company-news
 *  - Recommendation trends:https://finnhub.io/docs/api/recommendation-trends
 *  - Price target:         https://finnhub.io/docs/api/price-target
 *  - Company profile:      https://finnhub.io/docs/api/company-profile2
 *  - Stock candles:        https://finnhub.io/docs/api/stock-candles
 *
 * All functions are server-only. Returning `null` on failure lets the caller
 * fall back to the mock layer without throwing.
 */

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

export type FinnhubQuote = {
  c: number; // current price
  d: number; // change
  dp: number; // percent change
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // timestamp
};

export type FinnhubCompanyNews = {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image?: string;
  related: string;
  source: string;
  summary: string;
  url: string;
};

export type FinnhubRecommendation = {
  buy: number;
  hold: number;
  period: string;
  sell: number;
  strongBuy: number;
  strongSell: number;
  symbol: string;
};

export type FinnhubPriceTarget = {
  lastUpdated: string;
  symbol: string;
  targetHigh: number;
  targetLow: number;
  targetMean: number;
  targetMedian: number;
};

export type FinnhubProfile = {
  country: string;
  currency: string;
  exchange: string;
  finnhubIndustry: string;
  ipo: string;
  logo: string;
  marketCapitalization: number;
  name: string;
  shareOutstanding: number;
  ticker: string;
  weburl: string;
};

export type FinnhubCandles = {
  c: number[]; // close
  h: number[]; // high
  l: number[]; // low
  o: number[]; // open
  s: "ok" | "no_data";
  t: number[]; // timestamps
  v: number[]; // volume
};

// ---------------------------------------------------------------------------
// Fetch core
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  return process.env.FINNHUB_API_KEY?.trim() || null;
}

export function isFinnhubConfigured(): boolean {
  return getApiKey() !== null;
}

class FinnhubError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "FinnhubError";
  }
}

/**
 * Low-level GET against the Finnhub REST API.
 * @param path  endpoint path, e.g. "/quote"
 * @param params query params (token is injected automatically)
 * @param revalidate Next.js ISR revalidate window in seconds (default 60)
 */
async function finnhubGet<T>(
  path: string,
  params: Record<string, string | number> = {},
  revalidate = 60
): Promise<T> {
  const token = getApiKey();
  if (!token) throw new FinnhubError("FINNHUB_API_KEY is not configured");

  const url = new URL(`${FINNHUB_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("token", token);

  const res = await fetch(url.toString(), {
    headers: { "X-Finnhub-Token": token, Accept: "application/json" },
    next: { revalidate },
  });

  if (res.status === 429) {
    throw new FinnhubError("Finnhub rate limit exceeded", 429);
  }
  if (!res.ok) {
    throw new FinnhubError(
      `Finnhub request failed: ${path} (${res.status})`,
      res.status
    );
  }
  return (await res.json()) as T;
}

/** Wrap a fetch so transient failures resolve to null instead of throwing. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[finnhub] request failed:", (err as Error).message);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

export function getQuote(symbol: string): Promise<FinnhubQuote | null> {
  return safe(() => finnhubGet<FinnhubQuote>("/quote", { symbol }, 30));
}

export function getProfile(symbol: string): Promise<FinnhubProfile | null> {
  return safe(() =>
    finnhubGet<FinnhubProfile>("/stock/profile2", { symbol }, 60 * 60 * 24)
  );
}

export function getRecommendationTrends(
  symbol: string
): Promise<FinnhubRecommendation[] | null> {
  return safe(() =>
    finnhubGet<FinnhubRecommendation[]>("/stock/recommendation", { symbol }, 60 * 60)
  );
}

export function getPriceTarget(
  symbol: string
): Promise<FinnhubPriceTarget | null> {
  return safe(() =>
    finnhubGet<FinnhubPriceTarget>("/stock/price-target", { symbol }, 60 * 60)
  );
}

export function getCompanyNews(
  symbol: string,
  fromISO: string,
  toISO: string
): Promise<FinnhubCompanyNews[] | null> {
  return safe(() =>
    finnhubGet<FinnhubCompanyNews[]>(
      "/company-news",
      { symbol, from: fromISO, to: toISO },
      60 * 30
    )
  );
}

export function getCandles(
  symbol: string,
  resolution: "D" | "W" | "60" = "D",
  fromUnix: number,
  toUnix: number
): Promise<FinnhubCandles | null> {
  return safe(() =>
    finnhubGet<FinnhubCandles>(
      "/stock/candle",
      { symbol, resolution, from: fromUnix, to: toUnix },
      60 * 15
    )
  );
}
