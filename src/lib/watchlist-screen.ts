import "server-only";
import { getStockHistory, isMboumConfigured } from "@/lib/mboum";
import { getRevisionTrend } from "@/lib/revisions";
import { isDatabaseConfigured, query } from "@/lib/db";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { UNIVERSE } from "@/lib/universe";

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
 * the z-scores are standardized across the scanned set. Results persist to
 * Postgres (watchlist_rankings, delete+insert each run) with an in-memory
 * fallback when no database is configured.
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
const BATCH_SIZE = 5;

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

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Compute raw stats for one ticker; null when data is insufficient. */
async function scanTicker(
  ticker: string,
  qqq6mPct: number
): Promise<RawStats | null> {
  const candles = await getStockHistory(ticker, { monthsBack: 13 });
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

  return {
    ticker,
    momentumPct: round2(momentumPct),
    rsPct: round2(sixMonthPct - qqq6mPct),
    revision,
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
  scanned_at: string | Date;
};

function parseRevision(v: string): RevisionDirection {
  return v === "upgrading" || v === "downgrading" ? v : "stable";
}

async function persistRankings(rankings: WatchlistRanking[]): Promise<void> {
  await ensureRankingsSchema();
  // Delete + insert each run so the table always reflects the latest scan.
  await query("DELETE FROM watchlist_rankings");
  for (const r of rankings) {
    await query(
      `INSERT INTO watchlist_rankings
         (ticker, momentum_pct, rs_pct, revision, composite, scanned_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.ticker, r.momentumPct, r.rsPct, r.revision, r.composite, r.scannedAt]
    );
  }
}

async function readRankingsFromDb(): Promise<WatchlistRanking[] | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    await ensureRankingsSchema();
    const rows = await query<RankingRow>(
      "SELECT ticker, momentum_pct, rs_pct, revision, composite, scanned_at FROM watchlist_rankings ORDER BY composite DESC"
    );
    if (rows.length === 0) return null;
    const universeSize = rows.length;
    return rows.map((row, i) => ({
      ticker: row.ticker,
      momentumPct: Number(row.momentum_pct),
      rsPct: Number(row.rs_pct),
      revision: parseRevision(row.revision),
      composite: Number(row.composite),
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

  const stats: RawStats[] = [];
  let scanned = 0;
  for (let i = 0; i < UNIVERSE.length; i += BATCH_SIZE) {
    const batch = UNIVERSE.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((u) => scanTicker(u.ticker, qqq6mPct))
    );
    for (const res of settled) {
      scanned += 1;
      if (res.status === "fulfilled" && res.value) stats.push(res.value);
    }
  }

  if (stats.length === 0) return { scanned, ranked: 0 };

  const momentumZ = zScores(stats.map((s) => s.momentumPct));
  const rsZ = zScores(stats.map((s) => s.rsPct));
  const scannedAt = new Date().toISOString();

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
    scannedAt,
    rank: i + 1,
    universeSize: unranked.length,
  }));

  // Always keep the in-memory copy current; persist to Postgres when present.
  MEM_RANKINGS = rankings;
  if (isDatabaseConfigured()) {
    try {
      await persistRankings(rankings);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[watchlist-screen] DB persist failed (memory fallback kept):",
          (err as Error).message
        );
      }
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
