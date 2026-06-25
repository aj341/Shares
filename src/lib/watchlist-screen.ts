import "server-only";
import { getStockHistory, getKeyStats, getAnalystRatings, isMboumConfigured } from "@/lib/mboum";
import { getRevisionTrend } from "@/lib/revisions";
import { isDatabaseConfigured, query } from "@/lib/db";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { UNIVERSE, universeEntryFor } from "@/lib/universe";
// [scanscore] shared engine score so the scan persists the SAME score holdings use.
import { scoreOnEngine } from "@/lib/engine-score";
import { sectorFor } from "@/lib/sectors";
import type { Signal } from "@/lib/types";

/**
 * Systematic relative-strength screen over the Nasdaq-100 universe.
 *
 * For each ticker we compute:
 *  - 12-1 momentum: return from ~252 trading days ago to ~21 days ago
 *    (classic momentum factor — excludes the most recent month to avoid
 *    short-term reversal noise).
 *  - Relative strength: 6-month return minus QQQ's 6-month return.
 *  - Analyst revision direction (upgrading / stable / downgrading).
 *
 * Composite rank = 0.5 * momentumZ + 0.4 * rsZ + 0.1 * revisionScore, where
 * the z-scores are standardized across the scanned set. The scan ALSO computes
 * the same 0-100 engine score the holdings use and persists it per-name (see
 * [scanscore]) so reads are cheap (DB-only). Results persist to Postgres
 * (watchlist_rankings, per-name UPSERT — incremental + resilient so a partial
 * scan still accumulates coverage) with an in-memory fallback when no database
 * is configured.
 */

export type RevisionDirection = "upgrading" | "stable" | "downgrading";

export type WatchlistRanking = {
  ticker: string;
  /** 12-1 momentum, percent. */
  momentumPct: number;
  /** 6m return minus QQQ 6m return, percentage points. */
  rsPct: number;
  revision: RevisionDirection;
  composite: number;
  /** RSI(14) at scan time — entry-quality signal (low = pulled back). */
  rsi14: number | null;
  // [scanscore] Persisted engine score/signal — the SAME 0-100 score holdings
  // use (computed in the scan, read cheaply). Null for pre-migration rows or a
  // name whose live scoring failed; callers degrade to the composite rank.
  engineScore: number | null;
  engineSignal: Signal | null;
  /** Company name / sector persisted in the scan (cheap reads avoid lookups). */
  companyName: string | null;
  sector: string | null;
  price: number | null; // [scanscore] last close (candidate sizing)
  // [headercards] persisted fundamentals for watchlist row cards.
  peRatio: number | null;
  week52High: number | null;
  week52Low: number | null;
  bullishPct: number | null;
  scannedAt: string; // ISO timestamp
  /** 1-based rank by composite desc within the scanned set. */
  rank: number;
  /** Number of tickers successfully ranked in this scan. */
  universeSize: number;
};

export type ScanResult = {
  scanned: number;
  ranked: number;
};

// Trading-day offsets.
const DAYS_12M = 252;
const DAYS_1M = 21;
const DAYS_6M = 126;
const BATCH_SIZE = 3; // [scanfix] smaller batches: avoid Mboum rate-limit drops across 104 names

// In-memory fallback (and same-process cache) when Postgres is unavailable.
let MEM_RANKINGS: WatchlistRanking[] | null = null;

const REVISION_SCORE: Record<RevisionDirection, number> = {
  upgrading: 1,
  stable: 0,
  downgrading: -1,
};

type RawStats = {
  ticker: string;
  momentumPct: number;
  rsPct: number;
  revision: RevisionDirection;
  rsi14: number | null;
  // [scanscore] engine score computed in the scan (same path holdings use).
  engineScore: number | null;
  engineSignal: Signal | null;
  companyName: string | null;
  sector: string | null;
  price: number | null; // [scanscore] last close for new-buy candidate sizing
  // [headercards] fundamentals persisted so watchlist rows show real data.
  peRatio: number | null;
  week52High: number | null;
  week52Low: number | null;
  bullishPct: number | null;
};

/** Percent return between two closes; null when inputs are unusable. */
function pctReturn(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Return over the last `days` trading days ending `endOffset` days before the
 * latest candle. Candles are ascending; uses adjusted closes.
 */
function windowReturn(
  closes: number[],
  startOffset: number,
  endOffset: number
): number | null {
  const last = closes.length - 1;
  const startIdx = last - startOffset;
  const endIdx = last - endOffset;
  if (startIdx < 0 || endIdx < 0 || startIdx >= endIdx) return null;
  return pctReturn(closes[startIdx], closes[endIdx]);
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdDev(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Z-scores across the set; all-zero when there is no dispersion. */
function zScores(xs: number[]): number[] {
  const mu = mean(xs);
  const sd = stdDev(xs, mu);
  if (sd === 0) return xs.map(() => 0);
  return xs.map((x) => (x - mu) / sd);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Wilder-smoothed RSI(14) from daily closes; null when insufficient data. */
function rsi14(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round2(100 - 100 / (1 + rs));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Compute raw stats for one ticker; null when data is insufficient. */
async function scanTicker(
  ticker: string,
  qqq6mPct: number
): Promise<RawStats | null> {
  let candles = await getStockHistory(ticker, { monthsBack: 13 });
  // [scanfix] retry once on an empty pull (transient Mboum rate-limit) before dropping.
  if (candles.length === 0) {
    await new Promise((r) => setTimeout(r, 600));
    candles = await getStockHistory(ticker, { monthsBack: 13 });
  }
  // Need a full 12-month lookback (252 trading days) plus the excluded month.
  if (candles.length <= DAYS_12M) return null;
  const closes = candles.map((c) => c.adjClose);

  const momentumPct = windowReturn(closes, DAYS_12M, DAYS_1M);
  const sixMonthPct = windowReturn(closes, DAYS_6M, 0);
  if (momentumPct == null || sixMonthPct == null) return null;

  let revision: RevisionDirection = "stable";
  try {
    const trend = await getRevisionTrend(ticker);
    if (trend) revision = trend.direction;
  } catch {
    // Revision data is a 10% factor — treat failures as "stable".
  }

  // [scanscore] Compute the engine score HERE (in the scan), reusing the shared
  // scoreOnEngine path so the universe is scored with the SAME 0-100 engine the
  // holdings use. computeLiveMetrics is internally cached. Failure -> null
  // (back-compat / graceful): the name still ranks on its composite.
  const engine = await scoreOnEngine(ticker);
  // [headercards] Fundamentals for the row cards. getKeyStats is already warmed
  // by computeLiveMetrics (cache hit); getAnalystRatings is the only new call.
  const [keyStats, ratings] = await Promise.all([
    getKeyStats(ticker).catch(() => null),
    getAnalystRatings(ticker).catch(() => null),
  ]);
  const bullishPct = ratings
    ? Math.round(
        ((ratings.strongBuy + ratings.buy) /
          Math.max(
            1,
            ratings.strongBuy + ratings.buy + ratings.hold + ratings.sell + ratings.strongSell
          )) *
          100
      )
    : null;
  const entry = universeEntryFor(ticker);

  return {
    ticker,
    momentumPct: round2(momentumPct),
    rsPct: round2(sixMonthPct - qqq6mPct),
    revision,
    rsi14: rsi14(closes),
    engineScore: engine?.score ?? null,
    engineSignal: engine?.signal ?? null,
    companyName: entry?.companyName ?? null,
    sector: sectorFor(ticker),
    price: closes.length ? closes[closes.length - 1] : null,
    peRatio: keyStats?.peRatio ?? null,
    week52High: keyStats?.week52High ?? null,
    week52Low: keyStats?.week52Low ?? null,
    bullishPct,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const RANKINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS watchlist_rankings (
  ticker       TEXT PRIMARY KEY,
  momentum_pct NUMERIC NOT NULL,
  rs_pct       NUMERIC NOT NULL,
  revision     TEXT NOT NULL,
  composite    NUMERIC NOT NULL,
  scanned_at   TIMESTAMPTZ NOT NULL
);
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS rsi14 NUMERIC;
-- [scanscore] persist the engine score + signal + light metadata so reads are
-- cheap (DB-only) and never need to live-re-score the universe.
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS engine_score NUMERIC;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS engine_signal TEXT;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS sector TEXT;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS price NUMERIC;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS pe_ratio NUMERIC;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS week52_high NUMERIC;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS week52_low NUMERIC;
ALTER TABLE watchlist_rankings ADD COLUMN IF NOT EXISTS bullish_pct NUMERIC;
`;

let rankingsSchemaReady: Promise<void> | null = null;

function ensureRankingsSchema(): Promise<void> {
  if (!rankingsSchemaReady) {
    rankingsSchemaReady = query(RANKINGS_SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        rankingsSchemaReady = null; // allow retry on transient failure
        throw err;
      });
  }
  return rankingsSchemaReady;
}

type RankingRow = {
  ticker: string;
  momentum_pct: string | number;
  rs_pct: string | number;
  revision: string;
  composite: string | number;
  rsi14: string | number | null;
  // [scanscore] persisted engine fields (nullable for pre-migration rows).
  engine_score: string | number | null;
  engine_signal: string | null;
  company_name: string | null;
  sector: string | null;
  price: string | number | null;
  pe_ratio: string | number | null;
  week52_high: string | number | null;
  week52_low: string | number | null;
  bullish_pct: string | number | null;
  scanned_at: string | Date;
};

function parseRevision(v: string): RevisionDirection {
  return v === "upgrading" || v === "downgrading" ? v : "stable";
}

const VALID_SIGNALS: ReadonlySet<string> = new Set([
  "STRONG_BUY",
  "BUY",
  "HOLD",
  "TRIM",
  "SELL",
]);

// [scanscore] Parse a persisted signal string back to the Signal union; null
// (back-compat) for pre-migration rows or unrecognised values.
function parseSignal(v: string | null): Signal | null {
  return v != null && VALID_SIGNALS.has(v) ? (v as Signal) : null;
}

// [scanscore] Per-name UPSERT (not delete-all/insert-all). Persisting each name
// AS IT IS SCORED means a partial scan (rate-limited or time-boxed) still
// accumulates coverage across runs instead of writing nothing. ON CONFLICT keeps
// the latest values for a ticker. The composite/rank are written here too, but
// finalised once the whole set is scored (z-scores need the full set).
async function persistOneRanking(r: WatchlistRanking): Promise<void> {
  await query(
    `INSERT INTO watchlist_rankings
       (ticker, momentum_pct, rs_pct, revision, composite, rsi14,
        engine_score, engine_signal, company_name, sector, price,
        pe_ratio, week52_high, week52_low, bullish_pct, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (ticker) DO UPDATE SET
       momentum_pct  = EXCLUDED.momentum_pct,
       rs_pct        = EXCLUDED.rs_pct,
       revision      = EXCLUDED.revision,
       composite     = EXCLUDED.composite,
       rsi14         = EXCLUDED.rsi14,
       engine_score  = EXCLUDED.engine_score,
       engine_signal = EXCLUDED.engine_signal,
       company_name  = EXCLUDED.company_name,
       sector        = EXCLUDED.sector,
       price         = EXCLUDED.price,
       pe_ratio      = EXCLUDED.pe_ratio,
       week52_high   = EXCLUDED.week52_high,
       week52_low    = EXCLUDED.week52_low,
       bullish_pct   = EXCLUDED.bullish_pct,
       scanned_at    = EXCLUDED.scanned_at`,
    [
      r.ticker,
      r.momentumPct,
      r.rsPct,
      r.revision,
      r.composite,
      r.rsi14,
      r.engineScore,
      r.engineSignal,
      r.companyName,
      r.sector,
      r.price,
      r.peRatio,
      r.week52High,
      r.week52Low,
      r.bullishPct,
      r.scannedAt,
    ]
  );
}

async function readRankingsFromDb(): Promise<WatchlistRanking[] | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    await ensureRankingsSchema();
    const rows = await query<RankingRow>(
      `SELECT ticker, momentum_pct, rs_pct, revision, composite, rsi14,
              engine_score, engine_signal, company_name, sector, price,
              pe_ratio, week52_high, week52_low, bullish_pct, scanned_at
       FROM watchlist_rankings ORDER BY composite DESC`
    );
    if (rows.length === 0) return null;
    const universeSize = rows.length;
    return rows.map((row, i) => ({
      ticker: row.ticker,
      momentumPct: Number(row.momentum_pct),
      rsPct: Number(row.rs_pct),
      revision: parseRevision(row.revision),
      composite: Number(row.composite),
      rsi14: row.rsi14 == null ? null : Number(row.rsi14),
      // [scanscore] persisted engine fields; null-safe for pre-migration rows.
      engineScore: row.engine_score == null ? null : Number(row.engine_score),
      engineSignal: parseSignal(row.engine_signal),
      companyName: row.company_name,
      sector: row.sector,
      price: row.price == null ? null : Number(row.price),
      peRatio: row.pe_ratio == null ? null : Number(row.pe_ratio),
      week52High: row.week52_high == null ? null : Number(row.week52_high),
      week52Low: row.week52_low == null ? null : Number(row.week52_low),
      bullishPct: row.bullish_pct == null ? null : Number(row.bullish_pct),
      scannedAt: new Date(row.scanned_at).toISOString(),
      rank: i + 1,
      universeSize,
    }));
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[watchlist-screen] DB read failed:", (err as Error).message);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan the universe, rank by composite momentum/RS/revision score and persist
 * the rankings. Tolerates per-ticker failures; batches Mboum calls to respect
 * rate limits (max ~5 concurrent). Intended to run from a cron.
 */
export async function runWatchlistScan(): Promise<ScanResult> {
  if (!isMboumConfigured()) return { scanned: 0, ranked: 0 };

  // Benchmark first — relative strength needs QQQ's 6-month return.
  const qqq = await getStockHistory("QQQ", { monthsBack: 13 });
  const qqqCloses = qqq.map((c) => c.adjClose);
  const qqq6mPct = windowReturn(qqqCloses, DAYS_6M, 0);
  if (qqq6mPct == null) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[watchlist-screen] QQQ benchmark unavailable; scan aborted");
    }
    return { scanned: 0, ranked: 0 };
  }

  const dbReady = isDatabaseConfigured();
  // [scanscore] Ensure the schema (incl. the new engine_score columns) exists
  // BEFORE the loop so per-name upserts during the scan succeed.
  if (dbReady) {
    try {
      await ensureRankingsSchema();
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[watchlist-screen] schema ensure failed (memory fallback kept):",
          (err as Error).message
        );
      }
    }
  }

  const scannedAt = new Date().toISOString();
  const stats: RawStats[] = [];
  let scanned = 0;
  for (let i = 0; i < UNIVERSE.length; i += BATCH_SIZE) {
    const batch = UNIVERSE.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((u) => scanTicker(u.ticker, qqq6mPct))
    );
    for (const res of settled) {
      scanned += 1;
      // [scanscore] A name that fails scoring is skipped, not fatal.
      if (res.status !== "fulfilled" || !res.value) continue;
      const stat = res.value;
      stats.push(stat);
      // [scanscore] INCREMENTAL persist: write each name AS IT IS SCORED with a
      // provisional composite (finalised below once the whole set's z-scores are
      // known). A partial/time-boxed run thus still accumulates coverage instead
      // of writing nothing. Per-name failure is swallowed so one bad row never
      // aborts the scan.
      if (dbReady) {
        try {
          await persistOneRanking({
            ticker: stat.ticker,
            momentumPct: stat.momentumPct,
            rsPct: stat.rsPct,
            revision: stat.revision,
            composite: 0, // provisional — corrected in the finalise pass
            rsi14: stat.rsi14,
            engineScore: stat.engineScore,
            engineSignal: stat.engineSignal,
            companyName: stat.companyName,
            sector: stat.sector,
            price: stat.price,
            peRatio: stat.peRatio,
            week52High: stat.week52High,
            week52Low: stat.week52Low,
            bullishPct: stat.bullishPct,
            scannedAt,
            rank: 0,
            universeSize: 0,
          });
        } catch (err) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[watchlist-screen] incremental persist failed for ${stat.ticker}:`,
              (err as Error).message
            );
          }
        }
      }
    }
    // [scanfix] brief spacing so a 104-name scan doesn't trip Mboum throttling.
    if (i + BATCH_SIZE < UNIVERSE.length) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  if (stats.length === 0) return { scanned, ranked: 0 };

  // Finalise: z-scores standardise across the scanned set, so composite/rank can
  // only be computed once every name is in.
  const momentumZ = zScores(stats.map((s) => s.momentumPct));
  const rsZ = zScores(stats.map((s) => s.rsPct));

  const unranked = stats.map((s, i) => ({
    ...s,
    composite: round4(
      0.5 * momentumZ[i] + 0.4 * rsZ[i] + 0.1 * REVISION_SCORE[s.revision]
    ),
  }));
  unranked.sort((a, b) => b.composite - a.composite);

  const rankings: WatchlistRanking[] = unranked.map((s, i) => ({
    ticker: s.ticker,
    momentumPct: s.momentumPct,
    rsPct: s.rsPct,
    revision: s.revision,
    composite: s.composite,
    rsi14: s.rsi14,
    engineScore: s.engineScore,
    engineSignal: s.engineSignal,
    companyName: s.companyName,
    sector: s.sector,
    price: s.price,
    peRatio: s.peRatio,
    week52High: s.week52High,
    week52Low: s.week52Low,
    bullishPct: s.bullishPct,
    scannedAt,
    rank: i + 1,
    universeSize: unranked.length,
  }));

  // Always keep the in-memory copy current; persist to Postgres when present.
  MEM_RANKINGS = rankings;
  if (dbReady) {
    // [scanscore] Finalise pass: re-upsert with the real composite (and refreshed
    // per-name fields). Still per-name + tolerant — a failed row leaves its
    // earlier incremental value in place rather than aborting the run.
    for (const r of rankings) {
      try {
        await persistOneRanking(r);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[watchlist-screen] finalise persist failed for ${r.ticker} (memory fallback kept):`,
            (err as Error).message
          );
        }
      }
    }
  }

  // [scanscore] prune tickers no longer in the universe (was lost when
  // delete-all was replaced by per-name upsert).
  if (dbReady) {
    try {
      await query("DELETE FROM watchlist_rankings WHERE ticker <> ALL($1)", [
        UNIVERSE.map((u) => u.ticker),
      ]);
    } catch {
      /* prune is best-effort */
    }
  }

  return { scanned, ranked: rankings.length };
}

/** GOOG/GOOGL are the same company — exclude both when either is held. */
function exclusionKey(ticker: string): string {
  return ticker === "GOOGL" ? "GOOG" : ticker;
}

/**
 * Latest rankings (DB first, then in-memory fallback), excluding the
 * portfolio's own holdings, top `n` by composite. Returns [] when no scan
 * has run — callers fall back to their static lists.
 */
export async function getTopRanked(n: number): Promise<WatchlistRanking[]> {
  const rankings = (await readRankingsFromDb()) ?? MEM_RANKINGS;
  if (!rankings || rankings.length === 0) return [];

  const held = new Set<string>();
  try {
    const { positions } = await getDerivedPortfolio();
    for (const p of positions) {
      if (p.shares > 0) held.add(exclusionKey(p.ticker));
    }
  } catch {
    // No portfolio data — return rankings unfiltered rather than nothing.
  }

  return rankings
    .filter((r) => !held.has(exclusionKey(r.ticker)))
    .slice(0, n);
}

// [wlfilter] Full ranked set (every scanned, non-held name) with NO top-N
// slice — the complete coverage path used by the watchlist's "all" list and
// the redistribution candidate path so all scanned universe names are visible.
export async function getAllRanked(): Promise<WatchlistRanking[]> {
  return getTopRanked(Number.MAX_SAFE_INTEGER);
}
