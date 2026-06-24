import "server-only";
import { getQuote } from "@/lib/finnhub";
import { mboumFetch } from "@/lib/mboum";
import { readPortfolio } from "@/lib/portfolio-store";
import { sectorFor } from "@/lib/sectors";
import type { PersistedPortfolio, PortfolioTransaction } from "@/lib/types";

/**
 * [whatif] Sell-decision counterfactual — "what if I hadn't sold?".
 *
 * ADDITIVE, read-only. Everything here is derived from the existing
 * `portfolio_transactions` ledger plus Mboum daily closes (history) and
 * Finnhub live quotes (current price). It NEVER mutates the ledger, the
 * scoring engine, or the redistribution engine, and it does NOT change any
 * scoring / redistribution numbers — it is pure hindsight analytics layered
 * on top of the same source of truth the journal uses.
 *
 * THE QUESTION: every SELL row in the ledger is a *sell decision*. Was it the
 * right call? We answer that by replaying the alternate history where the user
 * had simply kept those shares:
 *
 *   decisionPnl = soldShares x (sellPrice - currentPrice)   [USD]
 *
 *   - POSITIVE  -> the price FELL after the sale: selling banked value you'd
 *                  otherwise have lost. A GOOD call.
 *   - NEGATIVE  -> the price ROSE after the sale: you sold too early and left
 *                  money on the table.
 *
 * A full SELL (position -> 0) and a TRIM (partial sell, residual remains) are
 * both `tradeType: "SELL"` rows in the ledger; we classify per-row by the
 * share count that survived the sell. Both are sell decisions and both count.
 *
 * "AT ANY GIVEN TIME": for each sell we build a small daily time series from
 * the sell date to now of the counterfactual value `soldShares x close[t]`
 * against the realised-at-sale value `soldShares x sellPrice`, so the user can
 * see how the decision *aged* — its best moment, its worst moment, and where
 * it stands now.
 *
 * HONESTY: the ledger is young, Mboum gives daily (not tick) bars, and the
 * live quote or history can be missing. Every field that can be unknown is
 * `null`; `priced` / `seriesAvailable` flags say whether a verdict is real or
 * just unavailable. Sells with no current price are surfaced but excluded from
 * the aggregate (we never fabricate a verdict).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SellKind = "sell" | "trim";

/** Was the sell decision vindicated by what the price did afterwards? */
export type SellVerdict = "good" | "early" | "neutral" | "unknown";

/** One point on the "how the decision aged" curve (USD, undiscounted). */
export type WhatIfPoint = {
  date: string; // YYYY-MM-DD
  /** Counterfactual value of the sold shares had they been kept: shares x close. */
  counterfactual: number;
  /** Decision P&L at this date: realisedValue - counterfactual (sold x (sell - close)). */
  decisionPnl: number;
};

export type WhatIfSell = {
  /** Stable id: the SELL transaction id. */
  id: string;
  ticker: string;
  companyName: string;
  sector: string;
  /** "sell" (closed the position) or "trim" (partial — residual remained). */
  kind: SellKind;
  sellDate: string; // YYYY-MM-DD
  soldShares: number;
  /** Sell fill price per share, USD. */
  sellPrice: number;
  /** Gross proceeds of the sold shares at the sell price (ex-fees), USD. */
  proceeds: number;
  /** Live current price per share, USD; null if unavailable. */
  currentPrice: number | null;
  /**
   * Decision P&L, USD: soldShares x (sellPrice - currentPrice).
   * Positive = good sell (price fell); negative = sold too early (price rose).
   * null when there is no current price.
   */
  decisionPnl: number | null;
  /** Decision P&L as a % of the sell proceeds; null when unpriced. */
  decisionPnlPct: number | null;
  verdict: SellVerdict;
  /** True when a live current price was available (verdict is real). */
  priced: boolean;
  /** Daily counterfactual curve from sell date to now; [] if no history. */
  series: WhatIfPoint[];
  /** Best/worst/current snapshots of the decision over the holding window. */
  best: WhatIfPoint | null; // most the decision was ever WORTH (max decisionPnl)
  worst: WhatIfPoint | null; // most it ever COST (min decisionPnl)
  current: WhatIfPoint | null; // latest point on the curve
  /** True when the time series was derived from real Mboum closes. */
  seriesAvailable: boolean;
};

export type WhatIfSummary = {
  /** Total sell decisions in the ledger. */
  totalSells: number;
  /** Sells we could price (have a current price) and thus score. */
  pricedSells: number;
  /** Sum of decision P&L across priced sells, USD. */
  totalDecisionPnl: number;
  /** Good calls / early / neutral counts (priced sells only). */
  goodCalls: number;
  earlyCalls: number;
  neutralCalls: number;
  /**
   * Hit rate = good calls / (good + early), as a %. Neutral (flat) decisions
   * are excluded from the denominator. null when no decided sells.
   */
  hitRatePct: number | null;
  /** Best (most-vindicated) and worst (most-costly) single decision, USD. */
  bestDecisionPnl: number | null;
  worstDecisionPnl: number | null;
};

export type WhatIfResult = {
  sells: WhatIfSell[];
  summary: WhatIfSummary;
  data: {
    /** True if at least one sell got a live current price. */
    priceUsed: boolean;
    /** True if at least one sell got a real Mboum close series. */
    seriesUsed: boolean;
  };
};

// ---------------------------------------------------------------------------
// Ledger replay — extract every sell decision (FIFO position tracking)
// ---------------------------------------------------------------------------

const CASH_TICKER = "CASH";

/** A raw sell decision pulled straight from the ledger (pre-pricing). */
type RawSell = {
  txId: string;
  ticker: string;
  companyName: string;
  soldShares: number;
  sellPrice: number;
  sellFees: number;
  sellDate: string;
  kind: SellKind;
};

function sortLedger(txs: PortfolioTransaction[]): PortfolioTransaction[] {
  return [...txs].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/**
 * Walk the ledger and emit one RawSell per SELL row. We track running shares
 * per ticker (BUY adds, SELL removes, ADJUSTMENT overrides) only to classify
 * each sell as a full SELL (residual <= ~0) or a TRIM (residual remains). We
 * never fabricate sells, and over-sells beyond known shares are still recorded
 * as sells (the decision happened regardless of lot bookkeeping).
 */
function extractSells(state: PersistedPortfolio): RawSell[] {
  const sharesByTicker = new Map<string, number>();
  const companyByTicker = new Map<string, string>();
  const out: RawSell[] = [];

  for (const tx of sortLedger(state.transactions)) {
    if (tx.ticker === CASH_TICKER) continue;
    if (tx.companyName) companyByTicker.set(tx.ticker, tx.companyName);
    const held = sharesByTicker.get(tx.ticker) ?? 0;

    if (tx.tradeType === "BUY") {
      sharesByTicker.set(tx.ticker, held + tx.shares);
    } else if (tx.tradeType === "SELL") {
      const residual = held - tx.shares;
      out.push({
        txId: tx.id,
        ticker: tx.ticker,
        companyName: companyByTicker.get(tx.ticker) ?? tx.ticker,
        soldShares: tx.shares,
        sellPrice: tx.pricePerShare,
        sellFees: tx.fees ?? 0,
        sellDate: tx.tradeDate,
        // Residual above ~0 leaves an open position => TRIM, else full SELL.
        kind: residual > 1e-6 ? "trim" : "sell",
      });
      sharesByTicker.set(tx.ticker, Math.max(0, residual));
    } else if (tx.tradeType === "ADJUSTMENT" && tx.adjustment) {
      sharesByTicker.set(tx.ticker, tx.adjustment.shares);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Mboum daily closes (counterfactual curve) — mirrors journal.ts shape
// ---------------------------------------------------------------------------

type CloseBar = { date: string; close: number };

type MboumHistoryRaw = {
  body?: Record<string, { date: string; close: number }>;
};

/**
 * Fetch all available daily CLOSES for a symbol (ascending). Mirrors the
 * journal's raw-history approach: `getStockHistory` windows + drops bars we
 * want here, so we hit the raw endpoint via `mboumFetch`. Returns [] on any
 * failure (no key, network, parse) — callers treat that as "no series".
 */
async function getDailyCloses(symbol: string): Promise<CloseBar[]> {
  try {
    const data = await mboumFetch<MboumHistoryRaw>(
      "/markets/stock/history",
      { symbol, interval: "1d", diffandsplits: "false" },
      60 * 60
    );
    if (!data?.body) return [];
    return Object.values(data.body)
      .filter((b) => b && Number.isFinite(b.close) && b.close > 0)
      .map((b) => ({ date: b.date, close: b.close }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    return [];
  }
}

/** Index of the first bar dated on-or-after `date`, or -1. */
function indexOnOrAfter(bars: CloseBar[], date: string): number {
  for (let i = 0; i < bars.length; i++) if (bars[i].date >= date) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Per-sell counterfactual
// ---------------------------------------------------------------------------

const NEUTRAL_BAND_PCT = 0.25; // |decisionPnl%| <= this => "neutral" (a wash).

function verdictFor(decisionPnlPct: number | null): SellVerdict {
  if (decisionPnlPct == null) return "unknown";
  if (decisionPnlPct > NEUTRAL_BAND_PCT) return "good"; // banked value as price fell
  if (decisionPnlPct < -NEUTRAL_BAND_PCT) return "early"; // sold too soon, price rose
  return "neutral";
}

/**
 * Build the daily counterfactual curve for one sell from the sell date to the
 * latest bar. realisedValue (soldShares x sellPrice) is the flat line the user
 * locked in; counterfactual (soldShares x close[t]) is the alternate history.
 * decisionPnl[t] = realisedValue - counterfactual[t].
 */
function buildSeries(
  bars: CloseBar[],
  soldShares: number,
  sellPrice: number,
  sellDate: string
): WhatIfPoint[] {
  if (bars.length === 0 || !(soldShares > 0)) return [];
  const start = indexOnOrAfter(bars, sellDate);
  if (start < 0) return [];
  const realisedValue = soldShares * sellPrice;
  const points: WhatIfPoint[] = [];
  for (let i = start; i < bars.length; i++) {
    const counterfactual = soldShares * bars[i].close;
    points.push({
      date: bars[i].date,
      counterfactual: round2(counterfactual),
      decisionPnl: round2(realisedValue - counterfactual),
    });
  }
  return points;
}

function bestWorst(series: WhatIfPoint[]): {
  best: WhatIfPoint | null;
  worst: WhatIfPoint | null;
  current: WhatIfPoint | null;
} {
  if (series.length === 0) return { best: null, worst: null, current: null };
  let best = series[0];
  let worst = series[0];
  for (const p of series) {
    if (p.decisionPnl > best.decisionPnl) best = p;
    if (p.decisionPnl < worst.decisionPnl) worst = p;
  }
  return { best, worst, current: series[series.length - 1] };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function buildWhatIf(): Promise<WhatIfResult> {
  const state = await readPortfolio();
  const rawSells = extractSells(state);
  const tickers = [...new Set(rawSells.map((s) => s.ticker))];

  // Live current price (Finnhub) + daily closes (Mboum) per ticker, concurrent.
  // Both degrade to null / [] so a missing key or failed call never throws.
  const [quoteEntries, closeEntries] = await Promise.all([
    Promise.all(
      tickers.map(async (t) => {
        const q = await getQuote(t);
        const c = q && Number.isFinite(q.c) && q.c > 0 ? q.c : null;
        return [t, c] as const;
      })
    ),
    Promise.all(tickers.map(async (t) => [t, await getDailyCloses(t)] as const)),
  ]);
  const priceByTicker = new Map<string, number | null>(quoteEntries);
  const closesByTicker = new Map<string, CloseBar[]>(closeEntries);

  let priceUsed = false;
  let seriesUsed = false;

  const sells: WhatIfSell[] = rawSells.map((rs) => {
    const currentPrice = priceByTicker.get(rs.ticker) ?? null;
    const bars = closesByTicker.get(rs.ticker) ?? [];

    const proceeds = rs.soldShares * rs.sellPrice;
    const priced = currentPrice != null;
    if (priced) priceUsed = true;

    const decisionPnl = priced
      ? rs.soldShares * (rs.sellPrice - currentPrice!)
      : null;
    const decisionPnlPct =
      decisionPnl != null && proceeds > 0 ? (decisionPnl / proceeds) * 100 : null;

    const series = buildSeries(bars, rs.soldShares, rs.sellPrice, rs.sellDate);
    if (series.length > 0) seriesUsed = true;
    const { best, worst, current } = bestWorst(series);

    return {
      id: rs.txId,
      ticker: rs.ticker,
      companyName: rs.companyName,
      sector: sectorFor(rs.ticker),
      kind: rs.kind,
      sellDate: rs.sellDate,
      soldShares: round4(rs.soldShares),
      sellPrice: round4(rs.sellPrice),
      proceeds: round2(proceeds),
      currentPrice: currentPrice != null ? round4(currentPrice) : null,
      decisionPnl: decisionPnl != null ? round2(decisionPnl) : null,
      decisionPnlPct: decisionPnlPct != null ? round2(decisionPnlPct) : null,
      verdict: verdictFor(decisionPnlPct),
      priced,
      series,
      best,
      worst,
      current,
      seriesAvailable: series.length > 0,
    };
  });

  // Newest sell first for display.
  sells.sort((a, b) => (a.sellDate < b.sellDate ? 1 : a.sellDate > b.sellDate ? -1 : 0));

  return {
    sells,
    summary: summarise(sells),
    data: { priceUsed, seriesUsed },
  };
}

function summarise(sells: WhatIfSell[]): WhatIfSummary {
  const priced = sells.filter((s) => s.priced && s.decisionPnl != null);
  const good = priced.filter((s) => s.verdict === "good");
  const early = priced.filter((s) => s.verdict === "early");
  const neutral = priced.filter((s) => s.verdict === "neutral");
  const decided = good.length + early.length;
  const pnls = priced.map((s) => s.decisionPnl as number);
  return {
    totalSells: sells.length,
    pricedSells: priced.length,
    totalDecisionPnl: round2(pnls.reduce((sum, p) => sum + p, 0)),
    goodCalls: good.length,
    earlyCalls: early.length,
    neutralCalls: neutral.length,
    hitRatePct: decided ? round2((good.length / decided) * 100) : null,
    bestDecisionPnl: pnls.length ? round2(Math.max(...pnls)) : null,
    worstDecisionPnl: pnls.length ? round2(Math.min(...pnls)) : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
