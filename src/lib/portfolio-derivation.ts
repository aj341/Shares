import "server-only";
import { readPortfolio } from "@/lib/portfolio-store";
import type {
  DerivedPosition,
  PersistedPortfolio,
  PortfolioTransaction,
} from "@/lib/types";

/**
 * Derives the current portfolio (positions + cash) from the transaction
 * ledger. The ledger is the source of truth; holdings are a fold over it.
 *
 * - BUY:  shares += s, costBasis += s*price + fees, cash -= (s*price + fees)
 * - SELL: costBasis scaled down pro-rata, shares -= s, cash += (s*price - fees),
 *         realised P&L accrues; historical buy prices are never mutated.
 * - ADJUSTMENT (with `adjustment`): manual override of shares + avg price.
 * - opening: establishes shares/cost without touching opening cash.
 * - ADJUSTMENT with ticker "CASH": cash-only delta (netCashImpact).
 */

type Acc = {
  ticker: string;
  companyName: string;
  shares: number;
  costBasis: number;
  realisedPnl: number;
  manuallyAdjusted: boolean;
};

const CASH_TICKER = "CASH";

function sortLedger(txs: PortfolioTransaction[]): PortfolioTransaction[] {
  return [...txs].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

export function derive(state: PersistedPortfolio): {
  positions: DerivedPosition[];
  cash: number;
} {
  const byTicker = new Map<string, Acc>();
  let cash = state.openingCash;

  for (const tx of sortLedger(state.transactions)) {
    cash += tx.netCashImpact ?? 0;

    if (tx.ticker === CASH_TICKER) continue; // pure cash movement

    let acc = byTicker.get(tx.ticker);
    if (!acc) {
      acc = {
        ticker: tx.ticker,
        companyName: tx.companyName,
        shares: 0,
        costBasis: 0,
        realisedPnl: 0,
        manuallyAdjusted: false,
      };
      byTicker.set(tx.ticker, acc);
    }
    if (tx.companyName) acc.companyName = tx.companyName;

    if (tx.tradeType === "BUY") {
      acc.shares += tx.shares;
      acc.costBasis += tx.shares * tx.pricePerShare + (tx.fees ?? 0);
    } else if (tx.tradeType === "SELL") {
      const avg = acc.shares > 0 ? acc.costBasis / acc.shares : 0;
      const sold = Math.min(tx.shares, acc.shares);
      acc.realisedPnl += sold * (tx.pricePerShare - avg) - (tx.fees ?? 0);
      acc.costBasis -= avg * sold; // remove cost of sold shares, keep avg intact
      acc.shares -= sold;
      if (acc.shares <= 0.0000001) {
        acc.shares = 0;
        acc.costBasis = 0;
      }
    } else if (tx.tradeType === "ADJUSTMENT" && tx.adjustment) {
      acc.shares = tx.adjustment.shares;
      acc.costBasis = tx.adjustment.shares * tx.adjustment.avgPrice;
      acc.manuallyAdjusted = true;
    }
  }

  const archived = new Set(state.archivedTickers);
  const positions: DerivedPosition[] = [...byTicker.values()]
    .filter((a) => a.shares > 0 && !archived.has(a.ticker))
    .map((a) => ({
      ticker: a.ticker,
      companyName: a.companyName,
      shares: round4(a.shares),
      entryPrice: a.shares > 0 ? round4(a.costBasis / a.shares) : 0,
      manuallyAdjusted: a.manuallyAdjusted,
      realisedPnl: round2(a.realisedPnl),
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  return { positions, cash: round2(cash) };
}

/** Owned-share lookup for sell validation (includes archived/zero). */
export function sharesOwned(state: PersistedPortfolio, ticker: string): number {
  let shares = 0;
  for (const tx of sortLedger(state.transactions)) {
    if (tx.ticker !== ticker) continue;
    if (tx.tradeType === "BUY") shares += tx.shares;
    else if (tx.tradeType === "SELL") shares -= tx.shares;
    else if (tx.tradeType === "ADJUSTMENT" && tx.adjustment)
      shares = tx.adjustment.shares;
  }
  return Math.max(0, round4(shares));
}

/** Convenience: read + derive in one call. */
export async function getDerivedPortfolio(): Promise<{
  positions: DerivedPosition[];
  cash: number;
  state: PersistedPortfolio;
}> {
  const state = await readPortfolio();
  const { positions, cash } = derive(state);
  return { positions, cash, state };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
