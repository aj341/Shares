import "server-only";
import {
  getScreenerList,
  getStockHistoryOHLC,
  getIntradayBars,
  isMboumConfigured,
  type MboumScreenerRow,
  type MboumScreenerList,
  type MboumOHLC,
} from "@/lib/mboum";
import { getMarketSession, type MarketSession } from "@/lib/market-session";
import { sectorFor } from "@/lib/sectors";
import { buildWatchlist } from "@/lib/watchlist";
import { getInsiderOverlays, type InsiderOverlay } from "@/lib/insider";
import type { FactorScores, RelativeStrength, WatchlistItem } from "@/lib/types";

/**
 * [scanner] "Today's Battle List" — pre-market gap + opening-range scanner.
 *
 * DESIGN: a DETERMINISTIC, ADDITIVE day-trading scanner. It pulls Mboum's
 * screener lists (day_gainers / day_losers / most_actives / trending), computes
 * gap % vs prior close, gap-vs-ATR, pre-market RVOL and pre-market $-volume,
 * then CROSS-REFERENCES each candidate against the app's EXISTING additive
 * factor / relative-strength rank and insider cluster-buy overlay so a gapping
 * name that ALSO scores well on the slow signals (or has insider buying) floats
 * to the top. Opening-range context (where price sits vs the first bar's range)
 * is layered when intraday bars exist.
 *
 * It NEVER touches the 0-100 score or BUY/HOLD/SELL Signal math: it reads the
 * additive `factors` / `relativeStrength` / `insider` fields the watchlist
 * already computes and the insider overlay, and blends them into a SEPARATE
 * "battle score". Everything degrades gracefully: missing keys/data yield an
 * empty list, and any per-name failure is swallowed.
 */

// ---------------------------------------------------------------------------
// Tunables (env-overridable)
// ---------------------------------------------------------------------------

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Minimum absolute gap % (vs prior close) to be a candidate at all. */
export const SCANNER_MIN_GAP_PCT = envNum("SCANNER_MIN_GAP_PCT", 2);
/** Minimum pre-market $-volume (USD) to keep a candidate (liquidity floor). */
export const SCANNER_MIN_DOLLAR_VOL = envNum("SCANNER_MIN_DOLLAR_VOL", 1_000_000);
/** How many ranked names to return. */
export const SCANNER_TOP_N = envNum("SCANNER_TOP_N", 20);
/** ATR lookback (trading days). */
export const SCANNER_ATR_DAYS = envNum("SCANNER_ATR_DAYS", 14);
/** Max distinct names we'll pull OHLC/intraday for (Mboum quota guard). */
export const SCANNER_ENRICH_LIMIT = envNum("SCANNER_ENRICH_LIMIT", 12);

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export type ScannerDirection = "up" | "down";

export type OpeningRange = {
  /** First-bar high / low used as the opening range. */
  high: number;
  low: number;
  /** Where the latest price sits: "above" / "inside" / "below" the range. */
  position: "above" | "inside" | "below";
  /** Bar interval label, e.g. "1h" (finest Mboum returned). */
  interval: string;
};

export type BattleCandidate = {
  ticker: string;
  companyName: string;
  sector: string;
  direction: ScannerDirection;
  /** Which screener list(s) surfaced this name. */
  lists: string[];
  /** Last/pre-market price used for the gap. */
  price: number | null;
  priorClose: number | null;
  /** Gap % vs prior close (signed). */
  gapPct: number | null;
  /** Gap expressed in ATRs (|gap$| / ATR). Bigger = more extended. */
  gapAtr: number | null;
  /** Pre-market (or current) relative volume vs 3M average daily volume. */
  rvol: number | null;
  /** Pre-market $-volume (price * volume). */
  dollarVol: number | null;
  /** Opening-range context (null until intraday bars exist). */
  openingRange: OpeningRange | null;

  // --- Cross-referenced ADDITIVE app signals (read-only, never recomputed) ---
  /** Cross-sectional RS percentile from the watchlist factor engine (0-100). */
  rsPercentile: number | null;
  /** Factor composite (0-100) from the watchlist factor engine. */
  factorComposite: number | null;
  /** Insider cluster-buy overlay signal for this name. */
  insiderSignal: InsiderOverlay["signal"] | null;

  /** Catalyst tag from company news, when available (else null). */
  catalyst: string | null;

  /** The blended 0-100 "battle score" used for ranking (transparency). */
  battleScore: number;
  /** Why this name ranks where it does (deterministic, human-readable). */
  reasons: string[];
};

export type ScannerResponse = {
  candidates: BattleCandidate[];
  session: MarketSession;
  asOf: string;
  /** Echo of the thresholds in effect (panel footnote). */
  thresholds: {
    minGapPct: number;
    minDollarVol: number;
    atrDays: number;
    topN: number;
  };
  source: "mboum" | "none";
  disclaimer: string;
};

const DISCLAIMER =
  "Deterministic day-trading scanner over public market data; blends gap/RVOL with the app's own additive factor/insider signals. General information, not financial advice.";

const EMPTY = (session: MarketSession): ScannerResponse => ({
  candidates: [],
  session,
  asOf: new Date().toISOString(),
  thresholds: {
    minGapPct: SCANNER_MIN_GAP_PCT,
    minDollarVol: SCANNER_MIN_DOLLAR_VOL,
    atrDays: SCANNER_ATR_DAYS,
    topN: SCANNER_TOP_N,
  },
  source: "none",
  disclaimer: DISCLAIMER,
});

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function fin(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function companyNameOf(r: MboumScreenerRow): string {
  return r.longName || r.shortName || r.displayName || r.symbol || "";
}

/** Wilder-style ATR from daily OHLC (true range), null if insufficient bars. */
export function computeAtr(bars: MboumOHLC[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    if (Number.isFinite(tr)) trs.push(tr);
  }
  if (trs.length < n) return null;
  const recent = trs.slice(-n);
  const atr = recent.reduce((s, x) => s + x, 0) / recent.length;
  return atr > 0 ? atr : null;
}

// ---------------------------------------------------------------------------
// 1. Pull screener lists -> raw candidate pool (deduped, gap-screened)
// ---------------------------------------------------------------------------

type RawCandidate = {
  row: MboumScreenerRow;
  ticker: string;
  lists: Set<string>;
  price: number | null;
  priorClose: number | null;
  gapPct: number | null;
  direction: ScannerDirection;
  rvol: number | null;
  dollarVol: number | null;
};

/** Resolve the "live" price for the gap: pre-market > post-market > regular. */
function livePrice(r: MboumScreenerRow, session: MarketSession): number | null {
  if (session === "pre") return fin(r.preMarketPrice) ?? fin(r.regularMarketPrice);
  if (session === "post")
    return fin(r.postMarketPrice) ?? fin(r.regularMarketPrice);
  return fin(r.regularMarketPrice);
}

/** The volume to use for RVOL: regular-session volume (pre-market often partial). */
function liveVolume(r: MboumScreenerRow): number | null {
  return fin(r.regularMarketVolume);
}

function rawFromRow(
  r: MboumScreenerRow,
  list: string,
  session: MarketSession
): RawCandidate | null {
  const ticker = (r.symbol ?? "").toUpperCase();
  if (!ticker) return null;

  const price = livePrice(r, session);
  const priorClose = fin(r.regularMarketPreviousClose);

  // Gap %: prefer explicit pre/post change pct; else derive vs prior close.
  let gapPct: number | null = null;
  if (session === "pre") gapPct = fin(r.preMarketChangePercent);
  else if (session === "post") gapPct = fin(r.postMarketChangePercent);
  if (gapPct == null && price != null && priorClose != null && priorClose > 0) {
    gapPct = ((price - priorClose) / priorClose) * 100;
  }
  // During regular/closed sessions, fall back to the day change.
  if (gapPct == null) gapPct = fin(r.regularMarketChangePercent);

  const vol = liveVolume(r);
  const avgVol = fin(r.averageDailyVolume3Month) ?? fin(r.averageDailyVolume10Day);
  const rvol = vol != null && avgVol != null && avgVol > 0 ? vol / avgVol : null;
  const dollarVol = price != null && vol != null ? price * vol : null;

  return {
    row: r,
    ticker,
    lists: new Set([list]),
    price,
    priorClose,
    gapPct,
    direction: (gapPct ?? 0) >= 0 ? "up" : "down",
    rvol,
    dollarVol,
  };
}

async function buildRawPool(
  lists: MboumScreenerList[],
  session: MarketSession
): Promise<RawCandidate[]> {
  const results = await Promise.all(
    lists.map((l) => getScreenerList(l).then((rows) => ({ l, rows })))
  );
  const byTicker = new Map<string, RawCandidate>();
  for (const { l, rows } of results) {
    for (const r of rows) {
      const cand = rawFromRow(r, l, session);
      if (!cand) continue;
      const existing = byTicker.get(cand.ticker);
      if (existing) {
        existing.lists.add(l);
        // Keep the richer row (prefer one with a usable gap/price).
        if (existing.gapPct == null && cand.gapPct != null) {
          existing.gapPct = cand.gapPct;
          existing.direction = cand.direction;
        }
        if (existing.price == null) existing.price = cand.price;
        if (existing.rvol == null) existing.rvol = cand.rvol;
        if (existing.dollarVol == null) existing.dollarVol = cand.dollarVol;
      } else {
        byTicker.set(cand.ticker, cand);
      }
    }
  }
  // Gap + liquidity screen.
  return [...byTicker.values()].filter((c) => {
    const gapOk = c.gapPct != null && Math.abs(c.gapPct) >= SCANNER_MIN_GAP_PCT;
    const liqOk = c.dollarVol == null || c.dollarVol >= SCANNER_MIN_DOLLAR_VOL;
    return gapOk && liqOk;
  });
}

// ---------------------------------------------------------------------------
// 2. Cross-reference: watchlist factor/RS map + insider overlay
// ---------------------------------------------------------------------------

type AppSignals = {
  rsPercentile: number | null;
  factorComposite: number | null;
};

function appSignalsFromWatchlist(
  items: WatchlistItem[]
): Map<string, AppSignals> {
  const map = new Map<string, AppSignals>();
  for (const it of items) {
    const rs: RelativeStrength | undefined = it.relativeStrength;
    const f: FactorScores | undefined = it.factors;
    map.set(it.ticker.toUpperCase(), {
      rsPercentile: rs?.percentile ?? null,
      factorComposite: f?.composite ?? null,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 3. Per-name enrichment: ATR (gap-vs-ATR) + opening range
// ---------------------------------------------------------------------------

function openingRangeFrom(
  bars: MboumOHLC[],
  lastPrice: number | null,
  interval: string
): OpeningRange | null {
  if (bars.length === 0 || lastPrice == null) return null;
  // First bar of the (most recent) session approximates the opening range.
  const first = bars[bars.length >= 1 ? Math.max(0, bars.length - 7) : 0];
  const orBar = first ?? bars[0];
  const high = fin(orBar.high);
  const low = fin(orBar.low);
  if (high == null || low == null) return null;
  const position =
    lastPrice > high ? "above" : lastPrice < low ? "below" : "inside";
  return { high, low, position, interval };
}

// ---------------------------------------------------------------------------
// 4. Blend into the deterministic "battle score"
// ---------------------------------------------------------------------------

/**
 * Battle score (0-100): a transparent weighted blend.
 *  - momentum/extension: gap magnitude (capped) + gap-vs-ATR.
 *  - participation: RVOL (capped).
 *  - slow-signal confirmation: factor composite + RS percentile.
 *  - insider kicker: cluster/notable open-market buying.
 *  - opening-range confirmation: breaking the range in the gap's direction.
 * Higher = more "in play" AND better confirmed by the app's own signals.
 */
function scoreCandidate(c: BattleCandidate): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  const gapMag = c.gapPct != null ? Math.min(Math.abs(c.gapPct), 15) / 15 : 0; // 0..1
  const gapAtr = c.gapAtr != null ? Math.min(c.gapAtr, 4) / 4 : 0; // 0..1
  const rvol = c.rvol != null ? Math.min(c.rvol, 5) / 5 : 0; // 0..1
  const factor = c.factorComposite != null ? c.factorComposite / 100 : 0.5;
  const rs = c.rsPercentile != null ? c.rsPercentile / 100 : 0.5;

  // Momentum component aligns with direction: longs reward strong factor/RS,
  // shorts reward weak factor/RS (a weak name gapping down is a cleaner short).
  const slowAlign = c.direction === "up" ? (factor + rs) / 2 : 1 - (factor + rs) / 2;

  let insiderKick = 0;
  if (c.insiderSignal === "cluster_buy") insiderKick = 1;
  else if (c.insiderSignal === "notable_buy") insiderKick = 0.6;
  else if (c.insiderSignal === "selling") insiderKick = c.direction === "down" ? 0.4 : 0;

  let orKick = 0;
  if (c.openingRange) {
    if (c.direction === "up" && c.openingRange.position === "above") orKick = 1;
    else if (c.direction === "down" && c.openingRange.position === "below")
      orKick = 1;
    else if (c.openingRange.position === "inside") orKick = 0.3;
  }

  const score =
    28 * gapMag +
    16 * gapAtr +
    22 * rvol +
    18 * slowAlign +
    8 * insiderKick +
    8 * orKick;

  // Reasons (deterministic, only when meaningful).
  if (c.gapPct != null)
    reasons.push(
      `${c.gapPct >= 0 ? "+" : ""}${c.gapPct.toFixed(1)}% gap${c.gapAtr != null ? ` (${c.gapAtr.toFixed(1)} ATR)` : ""}`
    );
  if (c.rvol != null && c.rvol >= 1.5)
    reasons.push(`${c.rvol.toFixed(1)}x relative volume`);
  if (c.factorComposite != null && c.factorComposite >= 60)
    reasons.push(`strong factor composite (${c.factorComposite}/100)`);
  if (c.rsPercentile != null && c.rsPercentile >= 66)
    reasons.push(`top-third relative strength (${Math.round(c.rsPercentile)}th pct)`);
  if (c.insiderSignal === "cluster_buy") reasons.push("insider cluster buying");
  else if (c.insiderSignal === "notable_buy") reasons.push("notable insider buy");
  if (c.openingRange)
    reasons.push(`price ${c.openingRange.position} the opening range`);
  if (c.catalyst) reasons.push(`catalyst: ${c.catalyst}`);

  return { score: Math.round(Math.min(100, Math.max(0, score)) * 10) / 10, reasons };
}

// ---------------------------------------------------------------------------
// 5. Optional catalyst tagging (best-effort; never blocks the build)
// ---------------------------------------------------------------------------

async function catalystMap(tickers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (tickers.length === 0) return out;
  try {
    // Reuse the existing AI-triaged hard-catalyst pipeline when available.
    const mod = await import("@/lib/catalysts");
    const fetchNews = (mod as { fetchTickerNews?: (t: string, d?: number) => Promise<Array<{ headline?: string }>> })
      .fetchTickerNews;
    if (typeof fetchNews !== "function") return out;
    await Promise.all(
      tickers.slice(0, SCANNER_ENRICH_LIMIT).map(async (t) => {
        const news = await fetchNews(t, 2).catch(() => []);
        const head = news?.[0]?.headline;
        if (head && head.trim()) {
          out.set(t, head.trim().slice(0, 120));
        }
      })
    );
  } catch {
    // Catalyst tagging is optional — ignore any failure.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

const DEFAULT_LISTS: MboumScreenerList[] = [
  "day_gainers",
  "day_losers",
  "most_actives",
  "trending",
];

const TTL_MS = 60 * 1000; // 60s — intraday scanner; cache hard but stay fresh.
let CACHE: { ts: number; data: ScannerResponse } | null = null;

export async function buildScanner(
  opts: { lists?: MboumScreenerList[]; withCatalysts?: boolean } = {}
): Promise<ScannerResponse> {
  const session = getMarketSession();
  if (!isMboumConfigured()) return EMPTY(session);

  if (CACHE && Date.now() - CACHE.ts < TTL_MS && !opts.lists) return CACHE.data;

  const lists = opts.lists ?? DEFAULT_LISTS;

  // 1. Raw, gap-screened candidate pool from the screener lists.
  const raw = await buildRawPool(lists, session);
  if (raw.length === 0) {
    const empty = { ...EMPTY(session), source: "mboum" as const };
    if (!opts.lists) CACHE = { ts: Date.now(), data: empty };
    return empty;
  }

  // Rank a preliminary shortlist by |gap| * rvol so we only ENRICH the top set
  // (ATR/OHLC/intraday/insider are per-name Mboum calls — quota-bounded).
  const prelim = [...raw].sort((a, b) => {
    const ga = Math.abs(a.gapPct ?? 0) * (a.rvol ?? 1);
    const gb = Math.abs(b.gapPct ?? 0) * (b.rvol ?? 1);
    return gb - ga;
  });
  const enrichSet = prelim.slice(0, SCANNER_ENRICH_LIMIT);
  const enrichTickers = enrichSet.map((c) => c.ticker);

  // 2. Cross-reference signals: watchlist factor/RS + insider overlay (batched).
  const [watch, insider, catalysts] = await Promise.all([
    buildWatchlist().catch(() => null),
    getInsiderOverlays(enrichTickers).catch(
      () => ({}) as Record<string, InsiderOverlay>
    ),
    opts.withCatalysts === false
      ? Promise.resolve(new Map<string, string>())
      : catalystMap(enrichTickers),
  ]);
  const appSig = appSignalsFromWatchlist(watch?.items ?? []);

  // 3. Per-name ATR + opening range (only the enrich set).
  const ohlcByTicker = new Map<string, MboumOHLC[]>();
  const intradayByTicker = new Map<string, MboumOHLC[]>();
  await Promise.all(
    enrichSet.map(async (c) => {
      const [daily, intra] = await Promise.all([
        getStockHistoryOHLC(c.ticker, {
          interval: "1d",
          days: SCANNER_ATR_DAYS * 3,
        }).catch(() => [] as MboumOHLC[]),
        getIntradayBars(c.ticker, "1h").catch(() => [] as MboumOHLC[]),
      ]);
      if (daily.length) ohlcByTicker.set(c.ticker, daily);
      if (intra.length) intradayByTicker.set(c.ticker, intra);
    })
  );

  // 4. Assemble + score.
  const candidates: BattleCandidate[] = enrichSet.map((c) => {
    const daily = ohlcByTicker.get(c.ticker) ?? [];
    const atr = computeAtr(daily, SCANNER_ATR_DAYS);
    const gapDollar =
      c.price != null && c.priorClose != null
        ? Math.abs(c.price - c.priorClose)
        : null;
    const gapAtr = atr != null && gapDollar != null ? gapDollar / atr : null;

    const intra = intradayByTicker.get(c.ticker) ?? [];
    const openingRange = openingRangeFrom(intra, c.price, "1h");

    const sig = appSig.get(c.ticker) ?? { rsPercentile: null, factorComposite: null };
    const ins = insider[c.ticker]?.signal ?? null;

    const base: BattleCandidate = {
      ticker: c.ticker,
      companyName: companyNameOf(c.row),
      sector: sectorFor(c.ticker),
      direction: c.direction,
      lists: [...c.lists],
      price: c.price,
      priorClose: c.priorClose,
      gapPct: c.gapPct,
      gapAtr,
      rvol: c.rvol,
      dollarVol: c.dollarVol,
      openingRange,
      rsPercentile: sig.rsPercentile,
      factorComposite: sig.factorComposite,
      insiderSignal: ins,
      catalyst: catalysts.get(c.ticker) ?? null,
      battleScore: 0,
      reasons: [],
    };
    const { score, reasons } = scoreCandidate(base);
    base.battleScore = score;
    base.reasons = reasons;
    return base;
  });

  candidates.sort((a, b) => b.battleScore - a.battleScore);

  const data: ScannerResponse = {
    candidates: candidates.slice(0, SCANNER_TOP_N),
    session,
    asOf: new Date().toISOString(),
    thresholds: {
      minGapPct: SCANNER_MIN_GAP_PCT,
      minDollarVol: SCANNER_MIN_DOLLAR_VOL,
      atrDays: SCANNER_ATR_DAYS,
      topN: SCANNER_TOP_N,
    },
    source: "mboum",
    disclaimer: DISCLAIMER,
  };
  if (!opts.lists) CACHE = { ts: Date.now(), data };
  return data;
}
