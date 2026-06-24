import "server-only";
import { mboumFetch, isMboumConfigured } from "@/lib/mboum";
import { getMarketSession } from "@/lib/market-session";

/**
 * [intraday] Intraday technicals + micro-regime overlay.
 *
 * Pure, additive, display-only overlay for the daily-trader workflow. For each
 * symbol it computes — from Mboum intraday OHLC bars — anchored/session VWAP,
 * a short-period ATR (stop distance + VWAP±k·ATR bands), and a per-symbol
 * "micro-regime" (trend_up / trend_down / chop) from a Wilder ADX proxy plus
 * intraday realized volatility. It NEVER touches the 0-100 score or the Signal;
 * callers attach the optional `intraday` field on Holding / WatchlistItem.
 *
 * Null-safe by construction: when Mboum is unconfigured, the market is closed
 * with no fresh bars, or a series is too short, every getter returns `null`
 * (or a null-filled snapshot) and nothing throws. Intraday bars are cached per
 * build (in-module TTL) so the per-symbol fetch stays cheap.
 *
 * Mboum endpoint: GET /markets/stock/history?symbol=&interval=15m&diffandsplits=false
 *   -> { body: { "<unix>": { date, date_utc, open, high, low, close, volume } } }
 * Intervals used: 15m (default) intraday bars; 5m supported via opts.
 */

// ---------------------------------------------------------------------------
// Public types (mirrored structurally in src/lib/types.ts as IntradayOverlay).
// ---------------------------------------------------------------------------

export type MicroRegime = "trend_up" | "trend_down" | "chop";
export type VwapState = "reclaim" | "lose" | "above" | "below" | "at" | null;

export type IntradayOverlay = {
  /** Rolling session VWAP from the most recent intraday bars (null if unknown). */
  vwap: number | null;
  /** VWAP anchored to today's first regular-session bar (today's open). */
  anchoredVwap: number | null;
  /** Signed % distance of last price from anchored VWAP (price above => +). */
  priceVsVwapPct: number | null;
  /** Reclaim/lose/above/below state of price vs anchored VWAP. */
  vwapState: VwapState;
  /** Short-period (Wilder) ATR on intraday bars, in price units. */
  atr: number | null;
  /** ATR as a % of last price. */
  atrPct: number | null;
  /** Suggested stop distance from last price (k·ATR below for longs). */
  suggestedStop: number | null;
  /** VWAP ± k·ATR entry/exhaustion bands (null when inputs missing). */
  bands: { lower: number | null; upper: number | null } | null;
  /** Per-symbol intraday micro-regime. */
  microRegime: MicroRegime | null;
  /** ADX proxy (0-100) backing the micro-regime (diagnostic). */
  adx: number | null;
  /** Intraday realized vol (annualised, from bar log-returns) (diagnostic). */
  realizedVol: number | null;
  /** Interval of the bars used (e.g. "15m"). */
  interval: string;
  /** Number of intraday bars used. */
  bars: number;
};

type Bar = {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

type MboumHistoryRaw = {
  body?: Record<
    string,
    {
      date?: string;
      date_utc?: number;
      open?: number;
      high?: number;
      low?: number;
      close?: number;
      volume?: number;
    }
  >;
};

export type IntradayInterval = "5m" | "15m" | "1h";

export type IntradayOpts = {
  interval?: IntradayInterval;
  /** ATR / ADX lookback in bars (Wilder). */
  period?: number;
  /** Band / stop multiple of ATR. */
  k?: number;
};

const ATR_PERIOD = 14;
const BAND_K = 1.5;
const STOP_K = 1.5;
// A trend needs both directional structure (ADX) AND price displaced from VWAP.
const ADX_TREND_MIN = 22;
const VWAP_TREND_MIN_PCT = 0.15; // |price-vs-vwap| must exceed this to be "trend"

// ---------------------------------------------------------------------------
// Per-build cache (TTL) for intraday bars — keyed by symbol+interval.
// ---------------------------------------------------------------------------

const BAR_TTL_MS = 5 * 60 * 1000;
const barCache = new Map<string, { at: number; bars: Bar[] }>();

function nullOverlay(interval: string): IntradayOverlay {
  return {
    vwap: null,
    anchoredVwap: null,
    priceVsVwapPct: null,
    vwapState: null,
    atr: null,
    atrPct: null,
    suggestedStop: null,
    bands: null,
    microRegime: null,
    adx: null,
    realizedVol: null,
    interval,
    bars: 0,
  };
}

/** Today's date string in US/Eastern (YYYY-MM-DD) — the anchor day. */
function easternDateKey(at: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(at); // en-CA gives YYYY-MM-DD
}

/** Unix seconds -> US/Eastern YYYY-MM-DD. */
function easternDateKeyFromUnix(unixSecs: number): string {
  return easternDateKey(new Date(unixSecs * 1000));
}

async function fetchIntradayBars(
  symbol: string,
  interval: IntradayInterval
): Promise<Bar[]> {
  const key = `${symbol.toUpperCase()}|${interval}`;
  const hit = barCache.get(key);
  if (hit && Date.now() - hit.at < BAR_TTL_MS) return hit.bars;

  let bars: Bar[] = [];
  try {
    const data = await mboumFetch<MboumHistoryRaw>(
      "/markets/stock/history",
      { symbol, interval, diffandsplits: "false" },
      5 * 60 // 5-min revalidate; intraday
    );
    if (data?.body) {
      bars = Object.values(data.body)
        .filter(
          (b) =>
            b &&
            Number.isFinite(b.close) &&
            Number.isFinite(b.high) &&
            Number.isFinite(b.low) &&
            (b.close ?? 0) > 0 &&
            Number.isFinite(b.date_utc)
        )
        .map((b) => ({
          t: b.date_utc as number,
          o: Number.isFinite(b.open) ? (b.open as number) : (b.close as number),
          h: b.high as number,
          l: b.low as number,
          c: b.close as number,
          v: Number.isFinite(b.volume) ? (b.volume as number) : 0,
        }))
        .sort((a, b) => a.t - b.t);
    }
  } catch {
    bars = [];
  }

  barCache.set(key, { at: Date.now(), bars });
  return bars;
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** Typical-price volume-weighted average over the supplied bars. */
function vwapOf(bars: Bar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    const v = b.v > 0 ? b.v : 1; // guard against all-zero volume feeds
    pv += tp * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

/** Wilder ATR over the last `period` true-ranges. */
function wilderAtr(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].c;
    tr.push(
      Math.max(
        cur.h - cur.l,
        Math.abs(cur.h - prevClose),
        Math.abs(cur.l - prevClose)
      )
    );
  }
  if (tr.length < period) return null;
  // Seed with simple average of first `period`, then Wilder-smooth.
  let atr = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return Number.isFinite(atr) ? atr : null;
}

/** Wilder ADX (0-100) over intraday bars; null when too short. */
function wilderAdx(bars: Bar[], period: number): number | null {
  if (bars.length < period * 2 + 1) return null;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const prevClose = bars[i - 1].c;
    tr.push(
      Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - prevClose),
        Math.abs(bars[i].l - prevClose)
      )
    );
  }
  if (tr.length < period * 2) return null;

  const smooth = (arr: number[]): number[] => {
    const out: number[] = [];
    let acc = arr.slice(0, period).reduce((s, x) => s + x, 0);
    out.push(acc);
    for (let i = period; i < arr.length; i++) {
      acc = acc - acc / period + arr[i];
      out.push(acc);
    }
    return out;
  };

  const trS = smooth(tr);
  const pS = smooth(plusDM);
  const mS = smooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const t = trS[i];
    if (t <= 0) {
      dx.push(0);
      continue;
    }
    const pdi = (100 * pS[i]) / t;
    const mdi = (100 * mS[i]) / t;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return Number.isFinite(adx) ? adx : null;
}

/** Annualised realized vol from intraday bar log-returns (rough; diagnostic). */
function realizedVolOf(bars: Bar[], interval: IntradayInterval): number | null {
  if (bars.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0 && bars[i].c > 0) {
      rets.push(Math.log(bars[i].c / bars[i - 1].c));
    }
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance =
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const perBar = Math.sqrt(variance);
  // bars per trading year ~ (6.5h * 60 / minutesPerBar) * 252
  const minutesPerBar = interval === "5m" ? 5 : interval === "15m" ? 15 : 60;
  const barsPerYear = (6.5 * 60) / minutesPerBar * 252;
  return perBar * Math.sqrt(barsPerYear);
}

// ---------------------------------------------------------------------------
// Per-symbol overlay
// ---------------------------------------------------------------------------

/**
 * Compute the intraday overlay for one symbol. Returns a null-filled snapshot
 * (never throws) when Mboum is off, the market has no fresh bars, or the series
 * is too short. `prevAnchoredVwap`/`prevPrice` (optional) let the caller detect
 * a "reclaim"/"lose" cross between two builds; without them we infer state from
 * the prior bar's relationship instead.
 */
export async function getIntradayOverlay(
  symbol: string,
  opts: IntradayOpts = {}
): Promise<IntradayOverlay> {
  const interval = opts.interval ?? "15m";
  const period = opts.period ?? ATR_PERIOD;
  const k = opts.k ?? BAND_K;

  if (!isMboumConfigured()) return nullOverlay(interval);

  const all = await fetchIntradayBars(symbol, interval);
  if (all.length < 2) return nullOverlay(interval);

  // Session bars = today's US/Eastern date; if the market is closed and no bar
  // is dated today, fall back to the most recent available session so the
  // overlay still reports last-known structure (clearly null-safe either way).
  const today = easternDateKey();
  let session = all.filter((b) => easternDateKeyFromUnix(b.t) === today);
  if (session.length === 0) {
    // most-recent available day in the series
    const lastDay = easternDateKeyFromUnix(all[all.length - 1].t);
    session = all.filter((b) => easternDateKeyFromUnix(b.t) === lastDay);
  }
  if (session.length < 2) return nullOverlay(interval);

  const last = session[session.length - 1];
  const price = last.c;

  // Anchored VWAP: anchored to the first bar of the session (≈ today's open).
  const anchoredVwap = vwapOf(session);
  // Rolling session VWAP over the recent window (same as anchored here, but
  // kept distinct so a future windowed VWAP can diverge); use last ~26 bars.
  const rollWindow = session.slice(-Math.min(26, session.length));
  const vwap = vwapOf(rollWindow);

  const priceVsVwapPct =
    anchoredVwap && anchoredVwap > 0
      ? ((price - anchoredVwap) / anchoredVwap) * 100
      : null;

  // VWAP state: compare the last two bars' relationship to anchored VWAP to
  // detect a reclaim (crossed up) / lose (crossed down) vs simply above/below.
  let vwapState: VwapState = null;
  if (anchoredVwap != null) {
    const prev = session[session.length - 2];
    const prevAbove = prev.c >= anchoredVwap;
    const nowAbove = price >= anchoredVwap;
    if (!prevAbove && nowAbove) vwapState = "reclaim";
    else if (prevAbove && !nowAbove) vwapState = "lose";
    else if (nowAbove) vwapState = price === anchoredVwap ? "at" : "above";
    else vwapState = "below";
  }

  // ATR on intraday bars over the full (multi-day) series for stability, then
  // bands/stop relative to the live price and anchored VWAP.
  const atr = wilderAtr(all, period);
  const atrPct = atr != null && price > 0 ? (atr / price) * 100 : null;
  const suggestedStop = atr != null ? price - STOP_K * atr : null;
  const bands =
    anchoredVwap != null && atr != null
      ? { lower: anchoredVwap - k * atr, upper: anchoredVwap + k * atr }
      : null;

  // Micro-regime: ADX (structure) + signed VWAP displacement (direction).
  const adx = wilderAdx(all, period);
  const realizedVol = realizedVolOf(session, interval);
  let microRegime: MicroRegime | null = null;
  if (adx != null && priceVsVwapPct != null) {
    const trending =
      adx >= ADX_TREND_MIN && Math.abs(priceVsVwapPct) >= VWAP_TREND_MIN_PCT;
    if (!trending) microRegime = "chop";
    else microRegime = priceVsVwapPct >= 0 ? "trend_up" : "trend_down";
  }

  const round = (v: number | null, dp = 4): number | null =>
    v == null ? null : Number(v.toFixed(dp));

  return {
    vwap: round(vwap),
    anchoredVwap: round(anchoredVwap),
    priceVsVwapPct: round(priceVsVwapPct, 3),
    vwapState,
    atr: round(atr),
    atrPct: round(atrPct, 3),
    suggestedStop: round(suggestedStop),
    bands: bands
      ? { lower: round(bands.lower), upper: round(bands.upper) }
      : null,
    microRegime,
    adx: round(adx, 2),
    realizedVol: round(realizedVol, 4),
    interval,
    bars: session.length,
  };
}

/**
 * Batch overlays for many symbols. One cached fetch per symbol; all null-safe.
 * Returns a map keyed by UPPER-CASE ticker. Skips work entirely (empty map) and
 * never throws when Mboum is unconfigured.
 */
export async function getIntradayOverlays(
  symbols: string[],
  opts: IntradayOpts = {}
): Promise<Record<string, IntradayOverlay>> {
  const out: Record<string, IntradayOverlay> = {};
  if (!isMboumConfigured() || symbols.length === 0) return out;
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const results = await Promise.all(
    uniq.map((s) =>
      getIntradayOverlay(s, opts).catch(() => nullOverlay(opts.interval ?? "15m"))
    )
  );
  uniq.forEach((s, i) => {
    out[s] = results[i];
  });
  return out;
}

/** True when the US regular session is open (caller convenience). */
export function isIntradayLive(at: Date = new Date()): boolean {
  return getMarketSession(at) === "regular";
}
