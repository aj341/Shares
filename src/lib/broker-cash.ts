import "server-only";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";

/**
 * Broker cash balances captured by the IBKR Flex sync, in NATIVE currency
 * (e.g. EUR 70.97), persisted so buildPortfolio can show real cash between
 * syncs. Falls back to in-memory when no database is configured.
 *
 * NUMERIC comes back from pg as STRING — reads wrap in Number().
 */

export type BrokerCashLine = { currency: string; amount: number };

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS broker_cash (
  currency   TEXT PRIMARY KEY,
  amount     NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

let memory: BrokerCashLine[] | null = null;
let memoryAt: string | null = null;

/** Replace the stored balances with the latest sync's lines. */
export async function saveBrokerCash(lines: BrokerCashLine[]): Promise<void> {
  const clean = lines
    .map((l) => ({ currency: l.currency.toUpperCase(), amount: l.amount }))
    .filter((l) => l.currency && Number.isFinite(l.amount));
  if (!isDatabaseConfigured()) {
    memory = clean;
    memoryAt = new Date().toISOString();
    return;
  }
  await ensureSchema();
  await query(`DELETE FROM broker_cash`);
  for (const l of clean) {
    await query(
      `INSERT INTO broker_cash (currency, amount, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (currency) DO UPDATE SET amount = $2, updated_at = NOW()`,
      [l.currency, l.amount]
    );
  }
}

/**
 * Latest synced balances + the sync timestamp, or null when no sync has run.
 * `syncedAt` lets callers layer ledger cash movements entered AFTER the last
 * broker sync on top of the broker baseline (so a manual buy/cash-edit shows
 * immediately and reconciles automatically on the next sync).
 */
export async function readBrokerCash(): Promise<
  { lines: BrokerCashLine[]; syncedAt: string | null } | null
> {
  if (!isDatabaseConfigured()) {
    return memory ? { lines: memory, syncedAt: memoryAt } : null;
  }
  try {
    await ensureSchema();
    const rows = await query<{ currency: string; amount: string; updated_at: string | Date }>(
      `SELECT currency, amount, updated_at FROM broker_cash ORDER BY currency`
    );
    if (rows.length === 0) return null;
    const syncedAt = rows
      .map((r) => (typeof r.updated_at === "string" ? r.updated_at : r.updated_at.toISOString()))
      .sort()
      .at(-1) ?? null;
    return {
      lines: rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) })),
      syncedAt,
    };
  } catch {
    return null;
  }
}
