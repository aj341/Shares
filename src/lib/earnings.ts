import "server-only";
import { FINNHUB_BASE_URL } from "@/lib/constants";

/**
 * Earnings-surprise connector (Finnhub).
 *
 * Endpoint: https://finnhub.io/docs/api/company-earnings
 *   GET /stock/earnings?symbol=MSFT
 *   → [{ actual, estimate, period, quarter, surprise, surprisePercent, symbol, year }, ...]
 *     (returned newest-first; one entry per reported quarter)
 *
 * Auth mirrors finnhub.ts: FINNHUB_API_KEY via the `token` query param plus the
 * `X-Finnhub-Token` header. Server-only; returns null on no data / failure so the
 * caller can fall back to the mock layer without throwing.
 */

// ---------------------------------------------------------------------------
// Raw response shape (only the fields we consume)
// ---------------------------------------------------------------------------

type FinnhubEarning = {
  actual: number | null;
  estimate: number | null;
  period: string;
  quarter: number;
  surprise: number | null;
  surprisePercent: number | null;
  symbol: string;
  year: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How many recent quarters to analyse. */
const QUARTERS = 4;
/** Average-surprise thresholds (percent) for the positive / negative verdict. */
const POSITIVE_AVG_PCT = 2;
const NEGATIVE_AVG_PCT = -2;
/** 6 hours — earnings prints are infrequent, so a long revalidate is fine. */
const REVALIDATE_SECONDS = 6 * 60 * 60;

// ---------------------------------------------------------------------------
// Fetch core (mirrors finnhub.ts's safe-fetch style)
// ---------------------------------------------------------------------------

/** Wrap a fetch so transient failures resolve to null instead of throwing. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[earnings] request failed:", (err as Error).message);
    }
    return null;
  }
}

async function fetchEarnings(symbol: string): Promise<FinnhubEarning[]> {
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) throw new Error("FINNHUB_API_KEY is not configured");

  const url = new URL(`${FINNHUB_BASE_URL}/stock/earnings`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", token);

  const res = await fetch(url.toString(), {
    headers: { "X-Finnhub-Token": token, Accept: "application/json" },
    next: { revalidate: REVALIDATE_SECONDS },
  });

  if (!res.ok) {
    throw new Error(`Finnhub earnings request failed: ${symbol} (${res.status})`);
  }
  return (await res.json()) as FinnhubEarning[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EarningsSurprise = {
  status: "positive" | "neutral" | "negative";
  value: string;
};

/**
 * Summarise the last ~4 quarters of earnings surprises for a ticker.
 *
 *  - positive: clear majority beats, or average surprise > ~2%
 *  - negative: clear majority misses, or average surprise < ~-2%
 *  - neutral:  otherwise
 *
 * `value` is a short human string (e.g. "4 beats", "2 misses", "Mixed",
 * "+3.1% avg"). Returns null when there is no data or the fetch fails.
 */
export async function getEarningsSurprise(
  ticker: string
): Promise<EarningsSurprise | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  const raw = await safe(() => fetchEarnings(symbol));
  if (!raw || raw.length === 0) return null;

  // Finnhub returns newest-first; take the most recent N quarters and keep only
  // entries where we can compare an actual against an estimate.
  const recent = raw
    .slice(0, QUARTERS)
    .filter(
      (e): e is FinnhubEarning & { actual: number; estimate: number } =>
        typeof e.actual === "number" && typeof e.estimate === "number"
    );

  if (recent.length === 0) return null;

  let beats = 0;
  let misses = 0;
  let surpriseSum = 0;
  let surpriseCount = 0;

  for (const e of recent) {
    if (e.actual > e.estimate) beats += 1;
    else if (e.actual < e.estimate) misses += 1;

    if (typeof e.surprisePercent === "number") {
      surpriseSum += e.surprisePercent;
      surpriseCount += 1;
    }
  }

  const total = recent.length;
  const avgSurprise = surpriseCount > 0 ? surpriseSum / surpriseCount : null;
  const majority = Math.floor(total / 2) + 1; // strict majority of the window

  const beatMajority = beats >= majority;
  const missMajority = misses >= majority;
  const avgPositive = avgSurprise != null && avgSurprise > POSITIVE_AVG_PCT;
  const avgNegative = avgSurprise != null && avgSurprise < NEGATIVE_AVG_PCT;

  let status: EarningsSurprise["status"];
  if (beatMajority || avgPositive) status = "positive";
  else if (missMajority || avgNegative) status = "negative";
  else status = "neutral";

  // Prefer the most descriptive short label.
  let value: string;
  if (beats === total) {
    value = `${beats} beat${beats === 1 ? "" : "s"}`;
  } else if (misses === total) {
    value = `${misses} miss${misses === 1 ? "" : "es"}`;
  } else if (beatMajority) {
    value = `${beats}/${total} beats`;
  } else if (missMajority) {
    value = `${misses}/${total} misses`;
  } else if (avgSurprise != null) {
    const sign = avgSurprise >= 0 ? "+" : "";
    value = `${sign}${avgSurprise.toFixed(1)}% avg`;
  } else {
    value = "Mixed";
  }

  return { status, value };
}
