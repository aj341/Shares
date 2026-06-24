import "server-only";
import { mboumFetch } from "@/lib/mboum";
import { getQuote } from "@/lib/finnhub";

/**
 * [chart] Per-stock INTRADAY 1D series (Google-Finance-style "1D" view).
 *
 * Data source of truth for the shape of the day is Mboum's intraday history
 * (`/markets/stock/history?interval=5m`); the live last price and a reliable
 * prev-close come from Finnhub's quote (which already powers the rest of the
 * dashboard). Everything here is additive and read-only — no scoring or
 * redistribution touched.
 *
 * The whole module is null-safe: any upstream failure resolves to an empty,
 * `hasData: false` payload so the UI can render an empty state and never crash.
 */

export type IntradayPoint = {
  /** Unix seconds for the bar (regular-session ordering key). */
  t: number;
  /** ISO timestamp (UTC) — convenient for client-side time formatting. */
  time: string;
  /** Close of the bar (the plotted price). */
  price: number;
  /** True for pre/post-market bars (outside 09:30-16:00 ET). */
  extended: boolean;
};

export type IntradaySeries = {
  symbol: string;
  hasData: boolean;
  /** Ordered (ascending) intraday price points. */
  points: IntradayPoint[];
  /** Today's session open (first regular bar open), null if unknown. */
  open: number | null;
  high: number | null;
  low: number | null;
  /** Prior regular-session close — the dashed reference line. */
  prevClose: number | null;
  /** Live last price (Finnhub quote, else last bar close). */
  last: number | null;
  /** Last - prevClose. */
  change: number | null;
  /** % change vs prevClose. */
  changePct: number | null;
  /** Bar interval actually used ("5m"). */
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

const INTERVAL = "5m";
/** Cache window — keeps live refetches from hammering the upstream APIs. */
const REVALIDATE_SECS = 60;

// --- Eastern-time helpers (regular session = 09:30-16:00 ET) ----------------

function easternMinutesAndDay(at: Date): { minutes: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minutes = hour * 60 + Number(get("minute"));
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return { minutes, ymd };
}

const REGULAR_OPEN = 9 * 60 + 30; // 09:30 ET
const REGULAR_CLOSE = 16 * 60; // 16:00 ET

function isRegular(minutes: number): boolean {
  return minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function empty(symbol: string): IntradaySeries {
  return {
    symbol,
    hasData: false,
    points: [],
    open: null,
    high: null,
    low: null,
    prevClose: null,
    last: null,
    change: null,
    changePct: null,
    interval: INTERVAL,
    asOf: new Date().toISOString(),
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Build today's intraday series for a ticker. Falls back gracefully:
 *  - no Mboum key / failure -> empty (hasData:false)
 *  - Finnhub quote missing -> derive last/prevClose from the bars themselves
 */
export async function getIntradaySeries(symbol: string): Promise<IntradaySeries> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return empty(symbol);

  const [history, quote] = await Promise.all([
    safe(() =>
      mboumFetch<MboumHistory>(
        "/markets/stock/history",
        { symbol: sym, interval: INTERVAL, diffandsplits: "false" },
        REVALIDATE_SECS
      )
    ),
    getQuote(sym), // already null-safe
  ]);

  const bars = history?.body ? Object.values(history.body) : [];
  if (!bars.length) {
    // No intraday bars — still expose the quote summary if we have it so the
    // header can render something useful instead of a hard empty state.
    const prevClose = num(quote?.pc);
    const last = num(quote?.c);
    if (prevClose == null && last == null) return empty(sym);
    const change = last != null && prevClose != null ? last - prevClose : null;
    return {
      ...empty(sym),
      prevClose,
      last,
      change,
      changePct:
        change != null && prevClose ? (change / prevClose) * 100 : null,
    };
  }

  // Clean + sort ascending; drop non-positive/non-finite closes.
  const clean = bars
    .filter(
      (b) => num(b.close) != null && (b.close as number) > 0 && num(b.date_utc) != null
    )
    .sort((a, b) => (a.date_utc as number) - (b.date_utc as number));

  if (!clean.length) return empty(sym);

  // Restrict to the most recent trading day present in the data (today, or the
  // last session if the market hasn't opened yet). We key on the ET calendar
  // day of the final bar so weekends/holidays still render the latest session.
  const lastBar = clean[clean.length - 1];
  const { ymd: targetDay } = easternMinutesAndDay(
    new Date((lastBar.date_utc as number) * 1000)
  );

  const points: IntradayPoint[] = [];
  let open: number | null = null;
  let high: number | null = null;
  let low: number | null = null;

  for (const b of clean) {
    const at = new Date((b.date_utc as number) * 1000);
    const { minutes, ymd } = easternMinutesAndDay(at);
    if (ymd !== targetDay) continue;

    const price = b.close as number;
    const extended = !isRegular(minutes);
    points.push({
      t: b.date_utc as number,
      time: at.toISOString(),
      price,
      extended,
    });

    // OHLC measured over the regular session only.
    if (!extended) {
      if (open == null) open = num(b.open) ?? price;
      const hi = num(b.high) ?? price;
      const lo = num(b.low) ?? price;
      high = high == null ? hi : Math.max(high, hi);
      low = low == null ? lo : Math.min(low, lo);
    }
  }

  if (!points.length) return empty(sym);

  // prevClose: prefer Finnhub's (authoritative).
  const prevClose = num(quote?.pc);
  // last: prefer the live quote; else the final plotted bar.
  const last = num(quote?.c) ?? points[points.length - 1].price;

  const change = last != null && prevClose != null ? last - prevClose : null;
  const changePct =
    change != null && prevClose ? (change / prevClose) * 100 : null;

  return {
    symbol: sym,
    hasData: true,
    points,
    open,
    high,
    low,
    prevClose,
    last,
    change,
    changePct,
    interval: INTERVAL,
    asOf: new Date().toISOString(),
  };
}
