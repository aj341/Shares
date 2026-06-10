import "server-only";
import { buildPortfolio } from "@/lib/portfolio";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";
import { getStockHistory, type MboumCandle } from "@/lib/mboum";

/**
 * Score snapshots + fixed-horizon, benchmark-relative backtesting.
 *
 * On each capture we persist one row per holding (ticker, score, signal, price).
 * Once snapshots age past a horizon (5/21/63 trading days) we measure each one's
 * forward return — snapshot price to the close N trading days later — minus
 * QQQ's return over the same window, then aggregate per signal band.
 *
 * NOTE: NUMERIC columns come back from pg as STRINGS — every numeric read is
 * wrapped in Number().
 */

const SNAPSHOT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS score_snapshots (
  id          SERIAL PRIMARY KEY,
  ticker      TEXT NOT NULL,
  score       INT NOT NULL,
  signal      TEXT NOT NULL,
  price       NUMERIC NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_snapshots_ticker ON score_snapshots (ticker);
CREATE INDEX IF NOT EXISTS idx_score_snapshots_captured ON score_snapshots (captured_at);
`;

let snapshotSchemaReady: Promise<void> | null = null;

/** Idempotently create the score_snapshots table. Cached so it runs once per process. */
export function ensureSnapshotSchema(): Promise<void> {
  if (!snapshotSchemaReady) {
    snapshotSchemaReady = (async () => {
      await getPool().query(SNAPSHOT_SCHEMA_SQL);
    })().catch((err) => {
      snapshotSchemaReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return snapshotSchemaReady;
}

/**
 * Capture the current portfolio: insert one snapshot row per holding.
 * No-op when no database is configured.
 */
export async function captureSnapshot(): Promise<{ captured: number }> {
  if (!isDatabaseConfigured()) return { captured: 0 };

  await ensureSnapshotSchema();
  const portfolio = await buildPortfolio();
  if (portfolio.holdings.length === 0) return { captured: 0 };

  // Build a single multi-row INSERT so all rows share one round-trip.
  const values: unknown[] = [];
  const tuples: string[] = [];
  portfolio.holdings.forEach((h, i) => {
    const base = i * 4;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push(h.ticker, Math.round(h.score), h.signal, h.currentPrice);
  });

  await query(
    `INSERT INTO score_snapshots (ticker, score, signal, price) VALUES ${tuples.join(
      ", "
    )}`,
    values
  );

  return { captured: portfolio.holdings.length };
}

/**
 * Snapshot the watchlist names' engine scores too, so the fixed-horizon
 * backtest validates the SCREEN's signals the same way it validates the
 * holdings'. Skips names without a live score or price. No-op without a DB.
 */
export async function captureWatchlistSnapshot(): Promise<{ captured: number }> {
  if (!isDatabaseConfigured()) return { captured: 0 };

  await ensureSnapshotSchema();
  const { buildWatchlist } = await import("@/lib/watchlist");
  const watch = await buildWatchlist().catch(() => null);
  const rows = (watch?.items ?? []).filter(
    (i) => i.engineScore != null && i.engineSignal != null && i.price != null
  );
  if (rows.length === 0) return { captured: 0 };

  const values: unknown[] = [];
  const tuples: string[] = [];
  rows.forEach((i, idx) => {
    const base = idx * 4;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push(i.ticker, Math.round(i.engineScore as number), i.engineSignal, i.price);
  });

  await query(
    `INSERT INTO score_snapshots (ticker, score, signal, price) VALUES ${tuples.join(
      ", "
    )}`,
    values
  );

  return { captured: rows.length };
}

type SnapshotRow = {
  ticker: string;
  signal: string;
  price: string; // NUMERIC → string from pg
  captured_at: string | Date; // TIMESTAMPTZ → Date (or string) from pg
};

/** Fixed evaluation horizons in TRADING days (≈ 1 week / 1 month / 3 months). */
export const BACKTEST_HORIZONS = [5, 21, 63] as const;

/** Aggregate stats for one signal band at one horizon. */
export type HorizonStats = {
  /** Mean of (stock forward return % − QQQ forward return %) over the window. */
  meanExcessPct: number;
  /** Number of snapshots old enough to have a full window at this horizon. */
  samples: number;
  /** Share of samples with positive excess return, as a 0–100 percentage. */
  hitRatePct: number;
};

export type SignalPerformance = {
  signal: string;
  /** Stats aligned index-for-index with BACKTEST_HORIZONS; null = no matured samples. */
  horizons: (HorizonStats | null)[];
};

/** Canonical display order for signal bands; unknown signals sort last. */
const SIGNAL_ORDER = ["STRONG_BUY", "BUY", "HOLD", "TRIM", "SELL"];

/** Index of the last candle dated on-or-before `date` (YYYY-MM-DD), or -1. */
function indexOnOrBefore(candles: MboumCandle[], date: string): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Fixed-horizon, benchmark-relative backtest.
 *
 * For each snapshot and each horizon N in BACKTEST_HORIZONS, compute the stock's
 * forward return from the snapshot's stored price to its close N trading days
 * after the snapshot date, minus QQQ's return over the same window. Snapshots
 * without N full trading days of history after them are skipped (no shorter
 * windows). Results are aggregated per signal band per horizon.
 *
 * Returns [] when no database is configured, there are no snapshots, or the
 * QQQ benchmark series is unavailable.
 */
export async function getSignalPerformance(): Promise<SignalPerformance[]> {
  if (!isDatabaseConfigured()) return [];

  await ensureSnapshotSchema();

  const rows = await query<SnapshotRow>(
    `SELECT ticker, signal, price, captured_at
       FROM score_snapshots
      ORDER BY ticker, captured_at ASC`
  );

  if (rows.length === 0) return [];

  // One candle fetch per distinct ticker plus one for the benchmark, cached
  // for this run and fetched concurrently.
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const candleCache = new Map<string, MboumCandle[]>();
  await Promise.all(
    [...tickers, "QQQ"].map(async (ticker) => {
      candleCache.set(ticker, await getStockHistory(ticker, { monthsBack: 12 }));
    })
  );

  const qqq = candleCache.get("QQQ") ?? [];
  if (qqq.length === 0) return []; // no benchmark → no honest excess returns

  // acc[signal][horizonIdx] = running aggregate of excess returns.
  const acc = new Map<
    string,
    { sum: number; count: number; positive: number }[]
  >();

  for (const row of rows) {
    const candles = candleCache.get(row.ticker) ?? [];
    if (candles.length === 0) continue;

    const snapPrice = Number(row.price);
    if (!Number.isFinite(snapPrice) || snapPrice <= 0) continue;

    // Match the snapshot date to the nearest candle on-or-before it, in both
    // the stock's series and the benchmark's.
    const snapDate = new Date(row.captured_at).toISOString().slice(0, 10);
    const startIdx = indexOnOrBefore(candles, snapDate);
    const qqqStartIdx = indexOnOrBefore(qqq, snapDate);
    if (startIdx < 0 || qqqStartIdx < 0) continue;

    const qqqStart = qqq[qqqStartIdx].close;
    if (!Number.isFinite(qqqStart) || qqqStart <= 0) continue;

    let buckets = acc.get(row.signal);
    if (!buckets) {
      buckets = BACKTEST_HORIZONS.map(() => ({
        sum: 0,
        count: 0,
        positive: 0,
      }));
      acc.set(row.signal, buckets);
    }

    BACKTEST_HORIZONS.forEach((horizon, h) => {
      const endIdx = startIdx + horizon;
      const qqqEndIdx = qqqStartIdx + horizon;
      // Skip horizons the snapshot hasn't aged past — never use a shorter window.
      if (endIdx >= candles.length || qqqEndIdx >= qqq.length) return;

      const stockReturnPct =
        ((candles[endIdx].close - snapPrice) / snapPrice) * 100;
      const qqqReturnPct = ((qqq[qqqEndIdx].close - qqqStart) / qqqStart) * 100;
      const excessPct = stockReturnPct - qqqReturnPct;
      if (!Number.isFinite(excessPct)) return;

      const bucket = buckets[h];
      bucket.sum += excessPct;
      bucket.count += 1;
      if (excessPct > 0) bucket.positive += 1;
    });
  }

  const result: SignalPerformance[] = [];
  for (const [signal, buckets] of acc.entries()) {
    const horizons = buckets.map((b) =>
      b.count > 0
        ? {
            meanExcessPct: Math.round((b.sum / b.count) * 100) / 100,
            samples: b.count,
            hitRatePct: Math.round((b.positive / b.count) * 100),
          }
        : null
    );
    // Drop signal bands with no matured samples at any horizon.
    if (horizons.every((h) => h === null)) continue;
    result.push({ signal, horizons });
  }

  // Stable, readable ordering: canonical signal bands first, unknowns last.
  result.sort((a, b) => {
    const ai = SIGNAL_ORDER.indexOf(a.signal);
    const bi = SIGNAL_ORDER.indexOf(b.signal);
    return (ai === -1 ? SIGNAL_ORDER.length : ai) -
      (bi === -1 ? SIGNAL_ORDER.length : bi);
  });
  return result;
}
