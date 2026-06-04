#!/usr/bin/env node
/**
 * One-off migration: copy the local file-backed ledger
 * (data/portfolio-state.json) into PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-file-to-db.mjs
 * (DATABASE_URL is also read from .env if present.)
 *
 * Safe to re-run: rows use ON CONFLICT DO NOTHING. If the file doesn't exist,
 * the app will simply seed the opening positions on first DB read instead.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portfolio_meta (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  opening_cash NUMERIC NOT NULL,
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portfolio_meta_singleton CHECK (id)
);
CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id TEXT PRIMARY KEY, ticker TEXT NOT NULL, company_name TEXT NOT NULL,
  trade_type TEXT NOT NULL, shares NUMERIC NOT NULL DEFAULT 0,
  price_per_share NUMERIC NOT NULL DEFAULT 0, gross_amount NUMERIC NOT NULL DEFAULT 0,
  fees NUMERIC NOT NULL DEFAULT 0, net_cash_impact NUMERIC NOT NULL DEFAULT 0,
  trade_date DATE NOT NULL, notes TEXT, opening BOOLEAN NOT NULL DEFAULT FALSE,
  adjustment JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portfolio_archived (ticker TEXT PRIMARY KEY);
`;

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (set it in env or .env).");
    process.exit(1);
  }
  const file = path.join(process.cwd(), "data", "portfolio-state.json");
  if (!existsSync(file)) {
    console.log("No data/portfolio-state.json found — nothing to migrate.");
    console.log("The app will seed opening positions on first DB read.");
    return;
  }
  const state = JSON.parse(readFileSync(file, "utf8"));
  const ssl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url)
    ? false
    : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();
  try {
    await client.query(SCHEMA);
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO portfolio_meta (id, opening_cash, seeded_at)
       VALUES (TRUE, $1, $2)
       ON CONFLICT (id) DO UPDATE SET opening_cash = EXCLUDED.opening_cash`,
      [state.openingCash, state.seededAt ?? new Date().toISOString()]
    );
    for (const t of state.transactions ?? []) {
      await client.query(
        `INSERT INTO portfolio_transactions
         (id, ticker, company_name, trade_type, shares, price_per_share, gross_amount,
          fees, net_cash_impact, trade_date, notes, opening, adjustment, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [
          t.id, t.ticker, t.companyName, t.tradeType, t.shares, t.pricePerShare,
          t.grossAmount, t.fees, t.netCashImpact, t.tradeDate, t.notes ?? null,
          t.opening ?? false, t.adjustment ? JSON.stringify(t.adjustment) : null,
          t.createdAt,
        ]
      );
    }
    for (const ticker of state.archivedTickers ?? []) {
      await client.query(
        "INSERT INTO portfolio_archived (ticker) VALUES ($1) ON CONFLICT DO NOTHING",
        [ticker]
      );
    }
    await client.query("COMMIT");
    console.log(
      `Migrated ${state.transactions?.length ?? 0} transactions and ` +
        `${state.archivedTickers?.length ?? 0} archived tickers to PostgreSQL.`
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
