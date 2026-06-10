import "server-only";
import { FINNHUB_BASE_URL } from "@/lib/constants";

/**
 * Upcoming-events radar: earnings dates + ex-dividends for held tickers.
 *
 * Data via Finnhub:
 *  - Earnings calendar:  /calendar/earnings  (date, epsEstimate, hour, quarter, ...)
 *  - Dividend calendar:  /calendar/dividend  (date == ex-date, amount, ...)
 *
 * Notes / observed shapes (verified June 2026 against the live API):
 *  - Future earnings rows have `epsActual: null`; `epsEstimate` may also be null.
 *  - A symbol query can echo a different ticker (e.g. GOOG -> "GOOGL"); we tag
 *    each event with the *requested* ticker so it maps back to the portfolio.
 *  - The dividend endpoint is plan-gated: on a free key /stock/dividend returns
 *    an access error and /calendar/dividend returns `{}`. We use the calendar
 *    endpoint and safe-fetch so dividends simply yield no events when gated,
 *    while earnings continue to work.
 *
 * Server-only. All fetches are wrapped so transient/plan failures resolve to an
 * empty result instead of throwing (mirrors the finnhub.ts `safe()` pattern).
 */

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export type UpcomingEvent = {
  ticker: string;
  type: "earnings" | "dividend";
  date: string;
  detail: string;
  daysAway: number;
};

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

type EarningsRow = {
  date: string;
  symbol: string;
  epsEstimate: number | null;
  epsActual: number | null;
  hour: string;
  quarter: number;
  revenueEstimate: number | null;
  year: number;
};

type EarningsResponse = { earningsCalendar?: EarningsRow[] };

type DividendRow = {
  symbol: string;
  date?: string; // ex-date (calendar/dividend)
  exDate?: string; // ex-date (stock/dividend)
  amount?: number;
  payDate?: string;
  currency?: string;
};

type DividendResponse = { dividendCalendar?: DividendRow[] };

// ---------------------------------------------------------------------------
// Fetch core
// ---------------------------------------------------------------------------

const REVALIDATE = 60 * 60 * 6; // ~6h
const HORIZON_DAYS = 90;
const MAX_EVENTS = 20;

function getApiKey(): string | null {
  return process.env.FINNHUB_API_KEY?.trim() || null;
}

/** Low-level GET; injects the token. Throws on non-OK so `safe()` can catch. */
async function finnhubGet<T>(
  path: string,
  params: Record<string, string>,
  token: string
): Promise<T> {
  const url = new URL(`${FINNHUB_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", token);

  const res = await fetch(url.toString(), {
    headers: { "X-Finnhub-Token": token, Accept: "application/json" },
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) {
    throw new Error(`Finnhub request failed: ${path} (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Wrap a fetch so failures resolve to a fallback value instead of throwing. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[events] request failed:", (err as Error).message);
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for a Date in UTC. */
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days from today (UTC midnight) to the given YYYY-MM-DD. */
function daysFromToday(dateISO: string, todayMs: number): number {
  const target = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(target)) return Number.NaN;
  return Math.round((target - todayMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Per-ticker fetchers
// ---------------------------------------------------------------------------

async function fetchEarnings(
  ticker: string,
  from: string,
  to: string,
  token: string,
  todayMs: number
): Promise<UpcomingEvent[]> {
  const data = await safe<EarningsResponse>(
    () =>
      finnhubGet<EarningsResponse>("/calendar/earnings", { symbol: ticker, from, to }, token),
    {}
  );
  const rows = data.earningsCalendar ?? [];
  const events: UpcomingEvent[] = [];

  for (const row of rows) {
    if (!row?.date) continue;
    const daysAway = daysFromToday(row.date, todayMs);
    if (Number.isNaN(daysAway) || daysAway < 0) continue; // future only

    const quarter =
      typeof row.quarter === "number" ? `Q${row.quarter}` : "Upcoming";
    const eps =
      typeof row.epsEstimate === "number"
        ? `, EPS est ${row.epsEstimate}`
        : "";
    events.push({
      ticker,
      type: "earnings",
      date: row.date,
      detail: `${quarter} earnings${eps}`,
      daysAway,
    });
  }
  return events;
}

async function fetchDividends(
  ticker: string,
  from: string,
  to: string,
  token: string,
  todayMs: number
): Promise<UpcomingEvent[]> {
  const data = await safe<DividendResponse>(
    () =>
      finnhubGet<DividendResponse>("/calendar/dividend", { symbol: ticker, from, to }, token),
    {}
  );
  const rows = data.dividendCalendar ?? [];
  const events: UpcomingEvent[] = [];

  for (const row of rows) {
    const exDate = row?.date ?? row?.exDate;
    if (!exDate) continue;
    const daysAway = daysFromToday(exDate, todayMs);
    if (Number.isNaN(daysAway) || daysAway < 0) continue; // future only

    const amount =
      typeof row.amount === "number" ? `$${row.amount.toFixed(2)}` : "TBD";
    events.push({
      ticker,
      type: "dividend",
      date: exDate,
      detail: `Ex-div ${amount}`,
      daysAway,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Past-window earnings (additive export, used by earnings-risk.ts)
// ---------------------------------------------------------------------------

export type PastEarningsReport = {
  /** Report date YYYY-MM-DD. */
  date: string;
  /** Finnhub report hour: "bmo" | "amc" | "dmh" | "" (unknown). */
  hour: string;
};

/**
 * Past earnings report dates for a ticker over an arbitrary window. Same
 * Finnhub /calendar/earnings endpoint — querying with past dates returns
 * historical report rows. Sorted ascending by date. Empty array when no key
 * is configured or the request fails.
 */
export async function getPastEarningsReports(
  ticker: string,
  from: string,
  to: string
): Promise<PastEarningsReport[]> {
  const token = getApiKey();
  const symbol = ticker.trim().toUpperCase();
  if (!token || !symbol) return [];

  const data = await safe<EarningsResponse>(
    () =>
      finnhubGet<EarningsResponse>(
        "/calendar/earnings",
        { symbol, from, to },
        token
      ),
    {}
  );

  return (data.earningsCalendar ?? [])
    .filter((row) => Boolean(row?.date))
    .map((row) => ({ date: row.date, hour: row.hour ?? "" }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upcoming earnings + ex-dividend events for the given tickers over the next
 * ~90 days. Future-only, sorted ascending by date, capped at ~20.
 * Returns an empty array if no key is configured or all fetches fail.
 */
export async function getUpcomingEvents(
  tickers: string[]
): Promise<UpcomingEvent[]> {
  const token = getApiKey();
  if (!token || tickers.length === 0) return [];

  const now = new Date();
  const todayMs = Date.parse(`${toISODate(now)}T00:00:00Z`);
  const from = toISODate(now);
  const to = toISODate(new Date(now.getTime() + HORIZON_DAYS * 86_400_000));

  const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];

  const perTicker = await Promise.all(
    unique.map(async (ticker) => {
      const [earnings, dividends] = await Promise.all([
        fetchEarnings(ticker, from, to, token, todayMs),
        fetchDividends(ticker, from, to, token, todayMs),
      ]);
      return [...earnings, ...dividends];
    })
  );

  return perTicker
    .flat()
    .sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.ticker.localeCompare(b.ticker)
    )
    .slice(0, MAX_EVENTS);
}
