import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * PostgreSQL connection pool + lazy schema initialisation.
 *
 * Connection is configured entirely from DATABASE_URL (Railway provides this).
 * SSL is enabled for remote hosts and disabled for localhost; override with
 * PGSSL=disable if your provider terminates TLS upstream.
 */

let pool: Pool | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function resolveSsl(url: string): false | { rejectUnauthorized: boolean } {
  if (process.env.PGSSL === "disable") return false;
  if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(url)) return false;
  return { rejectUnauthorized: false };
}

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not configured");
  pool = new Pool({
    connectionString: url,
    ssl: resolveSsl(url),
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

/** Run a function inside a transaction (BEGIN/COMMIT/ROLLBACK). */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portfolio_meta (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE,
  opening_cash NUMERIC NOT NULL,
  seeded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portfolio_meta_singleton CHECK (id)
);

CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id              TEXT PRIMARY KEY,
  ticker          TEXT NOT NULL,
  company_name    TEXT NOT NULL,
  trade_type      TEXT NOT NULL CHECK (trade_type IN ('BUY','SELL','ADJUSTMENT')),
  shares          NUMERIC NOT NULL DEFAULT 0,
  price_per_share NUMERIC NOT NULL DEFAULT 0,
  gross_amount    NUMERIC NOT NULL DEFAULT 0,
  fees            NUMERIC NOT NULL DEFAULT 0,
  net_cash_impact NUMERIC NOT NULL DEFAULT 0,
  trade_date      DATE NOT NULL,
  notes           TEXT,
  opening         BOOLEAN NOT NULL DEFAULT FALSE,
  adjustment      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_tx_ticker ON portfolio_transactions (ticker);
CREATE INDEX IF NOT EXISTS idx_portfolio_tx_created ON portfolio_transactions (created_at);

CREATE TABLE IF NOT EXISTS portfolio_archived (
  ticker TEXT PRIMARY KEY
);
`;

let schemaReady: Promise<void> | null = null;

/** Idempotently create tables. Cached so it runs once per process. */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await getPool().query(SCHEMA_SQL);
    })().catch((err) => {
      schemaReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return schemaReady;
}
