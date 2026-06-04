import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CURRENT_CASH, POSITIONS } from "@/lib/constants";
import {
  ensureSchema,
  isDatabaseConfigured,
  query,
  withTransaction,
} from "@/lib/db";
import type { PersistedPortfolio, PortfolioTransaction } from "@/lib/types";

/**
 * Persistence for the transaction ledger behind a repository interface, so the
 * backend can be swapped without touching callers or the V3 contracts.
 *
 * - PostgresPortfolioRepository — used when DATABASE_URL is set (production /
 *   Railway). Durable, multi-instance safe.
 * - FilePortfolioRepository — local-dev fallback (JSON file). Not safe across
 *   instances or on an ephemeral filesystem.
 *
 * Both seed the opening positions + cash on first access so behaviour is
 * identical regardless of backend.
 */

export interface PortfolioRepository {
  read(): Promise<PersistedPortfolio>;
  appendTransaction(tx: PortfolioTransaction): Promise<PersistedPortfolio>;
  setArchived(ticker: string, archived: boolean): Promise<PersistedPortfolio>;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export function buildSeed(): PersistedPortfolio {
  const seededAt = new Date().toISOString();
  const transactions: PortfolioTransaction[] = POSITIONS.map((p, i) => ({
    id: `seed-${p.ticker}`,
    ticker: p.ticker,
    companyName: p.companyName,
    tradeType: "BUY",
    shares: p.shares,
    pricePerShare: p.entryPrice,
    grossAmount: round2(p.shares * p.entryPrice),
    fees: 0,
    // Opening positions don't spend the opening cash (CURRENT_CASH is the
    // post-purchase balance), so their cash impact is zero.
    netCashImpact: 0,
    tradeDate: seededAt.slice(0, 10),
    notes: "Opening position",
    createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
    opening: true,
  }));
  return { openingCash: CURRENT_CASH, transactions, archivedTickers: [], seededAt };
}

// ---------------------------------------------------------------------------
// File backend (local dev)
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "portfolio-state.json");

class FilePortfolioRepository implements PortfolioRepository {
  async read(): Promise<PersistedPortfolio> {
    try {
      const raw = await fs.readFile(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw) as PersistedPortfolio;
      if (!parsed.transactions) throw new Error("malformed state");
      return parsed;
    } catch {
      const seed = buildSeed();
      await this.write(seed).catch(() => {});
      return seed;
    }
  }

  private async write(state: PersistedPortfolio): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  }

  async appendTransaction(tx: PortfolioTransaction): Promise<PersistedPortfolio> {
    const state = await this.read();
    const next = { ...state, transactions: [...state.transactions, tx] };
    await this.write(next);
    return next;
  }

  async setArchived(ticker: string, archived: boolean): Promise<PersistedPortfolio> {
    const state = await this.read();
    const set = new Set(state.archivedTickers);
    if (archived) set.add(ticker);
    else set.delete(ticker);
    const next = { ...state, archivedTickers: [...set] };
    await this.write(next);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Postgres backend (production)
// ---------------------------------------------------------------------------

type TxRow = {
  id: string;
  ticker: string;
  company_name: string;
  trade_type: PortfolioTransaction["tradeType"];
  shares: string;
  price_per_share: string;
  gross_amount: string;
  fees: string;
  net_cash_impact: string;
  trade_date: string | Date;
  notes: string | null;
  opening: boolean;
  adjustment: { shares: number; avgPrice: number } | null;
  created_at: string | Date;
};

function rowToTx(r: TxRow): PortfolioTransaction {
  return {
    id: r.id,
    ticker: r.ticker,
    companyName: r.company_name,
    tradeType: r.trade_type,
    shares: Number(r.shares),
    pricePerShare: Number(r.price_per_share),
    grossAmount: Number(r.gross_amount),
    fees: Number(r.fees),
    netCashImpact: Number(r.net_cash_impact),
    tradeDate:
      typeof r.trade_date === "string"
        ? r.trade_date.slice(0, 10)
        : r.trade_date.toISOString().slice(0, 10),
    notes: r.notes ?? undefined,
    opening: r.opening,
    adjustment: r.adjustment ?? undefined,
    createdAt:
      typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  };
}

class PostgresPortfolioRepository implements PortfolioRepository {
  private async ensureSeeded(): Promise<void> {
    await ensureSchema();
    const meta = await query<{ count: string }>(
      "SELECT COUNT(*)::int AS count FROM portfolio_meta"
    );
    if (Number(meta[0]?.count ?? 0) > 0) return;

    const seed = buildSeed();
    await withTransaction(async (c) => {
      // Idempotent seed: concurrent boots/requests race to insert, so every
      // statement no-ops on conflict. The singleton meta row guards the rest.
      const meta = await c.query(
        `INSERT INTO portfolio_meta (id, opening_cash, seeded_at)
         VALUES (TRUE, $1, $2) ON CONFLICT (id) DO NOTHING`,
        [seed.openingCash, seed.seededAt]
      );
      if (meta.rowCount === 0) return; // another writer already seeded
      for (const tx of seed.transactions) {
        await c.query(insertSql(), insertParams(tx));
      }
    });
  }

  async read(): Promise<PersistedPortfolio> {
    await this.ensureSeeded();
    const [meta, txs, archived] = await Promise.all([
      query<{ opening_cash: string; seeded_at: string | Date }>(
        "SELECT opening_cash, seeded_at FROM portfolio_meta LIMIT 1"
      ),
      query<TxRow>(
        "SELECT * FROM portfolio_transactions ORDER BY trade_date ASC, created_at ASC"
      ),
      query<{ ticker: string }>("SELECT ticker FROM portfolio_archived"),
    ]);
    return {
      openingCash: Number(meta[0]?.opening_cash ?? CURRENT_CASH),
      transactions: txs.map(rowToTx),
      archivedTickers: archived.map((a) => a.ticker),
      seededAt:
        typeof meta[0]?.seeded_at === "string"
          ? meta[0].seeded_at
          : (meta[0]?.seeded_at as Date)?.toISOString() ?? new Date().toISOString(),
    };
  }

  async appendTransaction(tx: PortfolioTransaction): Promise<PersistedPortfolio> {
    await this.ensureSeeded();
    await query(insertSql(), insertParams(tx));
    return this.read();
  }

  async setArchived(ticker: string, archived: boolean): Promise<PersistedPortfolio> {
    await this.ensureSeeded();
    if (archived) {
      await query(
        "INSERT INTO portfolio_archived (ticker) VALUES ($1) ON CONFLICT DO NOTHING",
        [ticker]
      );
    } else {
      await query("DELETE FROM portfolio_archived WHERE ticker = $1", [ticker]);
    }
    return this.read();
  }
}

function insertSql(): string {
  return `INSERT INTO portfolio_transactions
    (id, ticker, company_name, trade_type, shares, price_per_share, gross_amount,
     fees, net_cash_impact, trade_date, notes, opening, adjustment, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO NOTHING`;
}

function insertParams(tx: PortfolioTransaction): unknown[] {
  return [
    tx.id,
    tx.ticker,
    tx.companyName,
    tx.tradeType,
    tx.shares,
    tx.pricePerShare,
    tx.grossAmount,
    tx.fees,
    tx.netCashImpact,
    tx.tradeDate,
    tx.notes ?? null,
    tx.opening ?? false,
    tx.adjustment ? JSON.stringify(tx.adjustment) : null,
    tx.createdAt,
  ];
}

// ---------------------------------------------------------------------------
// Selection + public API
// ---------------------------------------------------------------------------

let repo: PortfolioRepository = isDatabaseConfigured()
  ? new PostgresPortfolioRepository()
  : new FilePortfolioRepository();

export function setPortfolioRepository(next: PortfolioRepository): void {
  repo = next;
}

export function activeBackend(): "postgres" | "file" {
  return repo instanceof PostgresPortfolioRepository ? "postgres" : "file";
}

export function readPortfolio(): Promise<PersistedPortfolio> {
  return repo.read();
}

export function appendTransaction(
  tx: PortfolioTransaction
): Promise<PersistedPortfolio> {
  return repo.appendTransaction(tx);
}

export function setArchived(
  ticker: string,
  archived: boolean
): Promise<PersistedPortfolio> {
  return repo.setArchived(ticker, archived);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
