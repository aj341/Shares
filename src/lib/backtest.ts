import "server-only";
import { buildPortfolio } from "@/lib/portfolio";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";

/**
 * Score snapshots + lightweight forward-return backtesting.
 *
 * On each capture we persist one row per holding (ticker, score, signal, price).
 * Over time these rows let us estimate how each signal "performed" by comparing
 * the price at snapshot time to the most recent price for the same ticker.
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

type SnapshotRow = {
  ticker: string;
  signal: string;
  price: string; // NUMERIC → string from pg
  captured_at: string;
};

type SignalPerformance = {
  signal: string;
  samples: number;
  avgForwardReturnPct: number | null;
};

/**
 * Best-effort forward-return backtest. For each historical snapshot, compute the
 * price return from that snapshot to the LATEST snapshot of the same ticker, then
 * group by the signal recorded at snapshot time and average the returns.
 *
 * Returns [] when there are fewer than 2 snapshots overall (nothing to compare).
 */
export async function getSignalPerformance(): Promise<SignalPerformance[]> {
  if (!isDatabaseConfigured()) return [];

  await ensureSnapshotSchema();

  const rows = await query<SnapshotRow>(
    `SELECT ticker, signal, price, captured_at
       FROM score_snapshots
      ORDER BY ticker, captured_at ASC`
  );

  if (rows.length < 2) return [];

  // Group rows by ticker (already ordered by captured_at ASC within ticker).
  const byTicker = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const list = byTicker.get(row.ticker);
    if (list) list.push(row);
    else byTicker.set(row.ticker, [row]);
  }

  // Accumulate forward returns per signal.
  const acc = new Map<string, { sum: number; count: number }>();

  for (const list of byTicker.values()) {
    if (list.length < 2) continue;
    const latest = list[list.length - 1];
    const latestPrice = Number(latest.price);
    if (!Number.isFinite(latestPrice) || latestPrice <= 0) continue;

    // Every snapshot before the latest gets a forward return to the latest price.
    for (let i = 0; i < list.length - 1; i++) {
      const snap = list[i];
      const snapPrice = Number(snap.price);
      if (!Number.isFinite(snapPrice) || snapPrice <= 0) continue;

      const forwardReturnPct = ((latestPrice - snapPrice) / snapPrice) * 100;
      const bucket = acc.get(snap.signal) ?? { sum: 0, count: 0 };
      bucket.sum += forwardReturnPct;
      bucket.count += 1;
      acc.set(snap.signal, bucket);
    }
  }

  const result: SignalPerformance[] = [];
  for (const [signal, { sum, count }] of acc.entries()) {
    result.push({
      signal,
      samples: count,
      avgForwardReturnPct:
        count > 0 ? Math.round((sum / count) * 100) / 100 : null,
    });
  }

  // Stable, readable ordering: most-sampled signals first.
  result.sort((a, b) => b.samples - a.samples);
  return result;
}
