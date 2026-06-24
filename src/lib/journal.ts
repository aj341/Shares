import "server-only";
import { isDatabaseConfigured, query } from "@/lib/db";
import { mboumFetch } from "@/lib/mboum";
import { readPortfolio } from "@/lib/portfolio-store";
import { sectorFor } from "@/lib/sectors";
import type {
  PersistedPortfolio,
  PortfolioTransaction,
  Signal,
} from "@/lib/types";

/**
 * [journal] Trade journal + execution / slippage analytics.
 *
 * ADDITIVE, read-only. Everything here is derived from the existing
 * `portfolio_transactions` ledger plus (optionally) the `score_snapshots`
 * table and Mboum daily OHLC history. It NEVER mutates the ledger, the
 * scoring engine, or the redistribution engine.
 *
 * The ledger records BUY / SELL / ADJUSTMENT rows (shares, pricePerShare,
 * fees, realised cash impact). We fold those rows into round-trip trades
 * (a FIFO BUY -> SELL pairing per ticker) and tag each with whatever context
 * is recoverable:
 *   - signal / score at entry  (from score_snapshots near the entry date)
 *   - sector                   (from the shared sectorFor() map)
 *   - hold time, realised $    (from the ledger itself)
 *   - R-multiple               (realised return / risk proxy, see methodology)
 *   - MAE / MFE                (Mboum daily HIGH/LOW between entry and exit)
 *   - estimated slippage       (fill price vs that day's close)
 *
 * HONESTY: the ledger is young and sparse, snapshots may not exist for the
 * entry date, and Mboum gives daily (not tick) bars. Every field that can be
 * unknown is `null`, and every aggregate carries its sample size so the UI
 * can label small / unproven samples. See the route's `methodology` echo and
 * the doc-comments below.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JournalOutcome = "win" | "loss" | "scratch" | "open";

/** Coarse US-session bucket derived from the trade's createdAt timestamp. */
export type TimeOfDayBucket =
  | "pre"
  | "open"
  | "midday"
  | "close"
  | "after"
  | "unknown";

export type JournalTrade = {
  /** Stable id: entry transaction id (round trips key off the opening BUY). */
  id: string;
  ticker: string;
  companyName: string;
  sector: string;
  /** Entry (weighted) fill price per share, USD. */
  entryPrice: number;
  /** Exit (weighted) fill price per share, USD; null while the trade is open. */
  exitPrice: number | null;
  shares: number;
  entryDate: string; // YYYY-MM-DD
  exitDate: string | null; // YYYY-MM-DD, null while open
  /** Calendar days held; null while open. */
  holdDays: number | null;
  /** Time-of-day bucket of the ENTRY fill (from createdAt, ET). */
  entryTimeOfDay: TimeOfDayBucket;
  /** Realised P&L in USD net of fees on both legs; null while open. */
  realisedPnl: number | null;
  /** Realised return on the entry cost, fraction*100; null while open. */
  realisedReturnPct: number | null;
  outcome: JournalOutcome;
  /** Signal at entry, recovered from the nearest score snapshot; null if none. */
  signalAtEntry: Signal | null;
  /** 0-100 score at entry; null if no snapshot. */
  scoreAtEntry: number | null;
  /** How the entry signal/score was sourced. */
  signalBasis: "snapshot" | "none";
  /** R-multiple: realised return / per-trade risk proxy (see methodology). */
  rMultiple: number | null;
  /** Maximum Adverse Excursion as a positive % of entry (worst drawdown). */
  maePct: number | null;
  /** Maximum Favorable Excursion as a positive % of entry (best run-up). */
  mfePct: number | null;
  /** MAE / MFE expressed in R (excursion% / riskPct). */
  maeR: number | null;
  mfeR: number | null;
  /** Estimated entry slippage in bps vs entry-day close (see methodology). */
  entrySlippageBps: number | null;
  /** Estimated exit slippage in bps vs exit-day close. */
  exitSlippageBps: number | null;
  /** True when MAE/MFE were derived from real Mboum bars. */
  excursionAvailable: boolean;
};

export type TagStats = {
  tag: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  /** Expectancy in R: mean R-multiple across closed trades with an R value. */
  expectancyR: number | null;
  /** Mean realised return %, closed trades. */
  avgReturnPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Profit factor = sum(wins$) / |sum(losses$)|; null if no losses. */
  profitFactor: number | null;
  avgMaePct: number | null;
  avgMfePct: number | null;
  totalRealised: number;
};

export type JournalSummary = {
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  expectancyR: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Avg win % / |avg loss %| payoff ratio; null if no losses. */
  payoffRatio: number | null;
  profitFactor: number | null;
  totalRealised: number;
  avgHoldDays: number | null;
  avgMaePct: number | null;
  avgMfePct: number | null;
  /** Closed trades for which we have real Mboum excursion data. */
  excursionCoverage: number;
  /** Closed trades for which we recovered an entry signal. */
  signalCoverage: number;
};

export type JournalResult = {
  trades: JournalTrade[];
  summary: JournalSummary;
  bySignal: TagStats[];
  bySector: TagStats[];
  byTimeOfDay: TagStats[];
  /** Honest data-availability flags so the UI can caveat correctly. */
  data: {
    hasDb: boolean;
    snapshotsUsed: boolean;
    excursionUsed: boolean;
  };
};

// ---------------------------------------------------------------------------
// Round-trip construction (FIFO lots)
// ---------------------------------------------------------------------------

type Lot = {
  shares: number;
  price: number;
  feePerShare: number;
  date: string;
  createdAt: string;
  entryTxId: string;
};

type RoundTrip = {
  entryTxId: string;
  ticker: string;
  companyName: string;
  shares: number;
  entryCost: number; // shares*entryPrice + entry fees
  entryFees: number;
  entryPrice: number; // weighted, ex-fees
  entryDate: string;
  entryCreatedAt: string;
  exitProceeds: number; // shares*exitPrice - exit fees
  exitFees: number;
  exitPrice: number; // weighted, ex-fees
  exitDate: string;
  closed: boolean;
};

const CASH_TICKER = "CASH";

function sortLedger(txs: PortfolioTransaction[]): PortfolioTransaction[] {
  return [...txs].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/**
 * Fold the ledger into round-trip (and still-open) trades, FIFO. Opening seed
 * positions are treated as BUY lots so they can later be closed by a SELL.
 * ADJUSTMENT rows can't be reconciled to fills, so we drop any open FIFO lots
 * for that ticker (the manual override has rewritten the position). This is
 * conservative: a skipped trade simply doesn't appear rather than producing a
 * fake fill.
 */
function buildRoundTrips(state: PersistedPortfolio): {
  closed: RoundTrip[];
  open: RoundTrip[];
} {
  const lotsByTicker = new Map<string, Lot[]>();
  const closed: RoundTrip[] = [];
  const companyByTicker = new Map<string, string>();

  for (const tx of sortLedger(state.transactions)) {
    if (tx.ticker === CASH_TICKER) continue;
    if (tx.companyName) companyByTicker.set(tx.ticker, tx.companyName);

    if (tx.tradeType === "BUY") {
      const lots = lotsByTicker.get(tx.ticker) ?? [];
      const feePerShare = tx.shares > 0 ? (tx.fees ?? 0) / tx.shares : 0;
      lots.push({
        shares: tx.shares,
        price: tx.pricePerShare,
        feePerShare,
        date: tx.tradeDate,
        createdAt: tx.createdAt,
        entryTxId: tx.id,
      });
      lotsByTicker.set(tx.ticker, lots);
    } else if (tx.tradeType === "SELL") {
      let toSell = tx.shares;
      const lots = lotsByTicker.get(tx.ticker) ?? [];
      const exitFeePerShare = tx.shares > 0 ? (tx.fees ?? 0) / tx.shares : 0;
      while (toSell > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const matched = Math.min(lot.shares, toSell);
        const entryFees = matched * lot.feePerShare;
        const exitFees = matched * exitFeePerShare;
        closed.push({
          entryTxId: lot.entryTxId,
          ticker: tx.ticker,
          companyName: companyByTicker.get(tx.ticker) ?? tx.ticker,
          shares: matched,
          entryCost: matched * lot.price + entryFees,
          entryFees,
          entryPrice: lot.price,
          entryDate: lot.date,
          entryCreatedAt: lot.createdAt,
          exitProceeds: matched * tx.pricePerShare - exitFees,
          exitFees,
          exitPrice: tx.pricePerShare,
          exitDate: tx.tradeDate,
          closed: true,
        });
        lot.shares -= matched;
        toSell -= matched;
        if (lot.shares <= 1e-9) lots.shift();
      }
      // Over-sell beyond known lots (e.g. shares predating the ledger) is
      // ignored -- we never fabricate an entry we don't have.
    } else if (tx.tradeType === "ADJUSTMENT") {
      // Manual override rewrites the position; existing FIFO lots are no longer
      // a faithful record, so drop them.
      lotsByTicker.delete(tx.ticker);
    }
  }

  // Whatever remains is an open position; collapse remaining lots per ticker
  // into a single open round-trip (weighted entry) for journal display.
  const open: RoundTrip[] = [];
  for (const [ticker, lots] of lotsByTicker) {
    const live = lots.filter((l) => l.shares > 1e-9);
    if (live.length === 0) continue;
    const shares = live.reduce((s, l) => s + l.shares, 0);
    const cost = live.reduce(
      (s, l) => s + l.shares * l.price + l.shares * l.feePerShare,
      0
    );
    const fees = live.reduce((s, l) => s + l.shares * l.feePerShare, 0);
    const first = live[0];
    open.push({
      entryTxId: first.entryTxId,
      ticker,
      companyName: companyByTicker.get(ticker) ?? ticker,
      shares,
      entryCost: cost,
      entryFees: fees,
      entryPrice: shares > 0 ? (cost - fees) / shares : 0,
      entryDate: first.date,
      entryCreatedAt: first.createdAt,
      exitProceeds: 0,
      exitFees: 0,
      exitPrice: 0,
      exitDate: "",
      closed: false,
    });
  }

  return { closed, open };
}

// ---------------------------------------------------------------------------
// Entry signal recovery (score_snapshots)
// ---------------------------------------------------------------------------

type SnapRow = { signal: string; score: number; captured_at: string | Date };

/**
 * Load all score/signal snapshots for the given tickers. Returns an empty map
 * when no DB is configured or the table doesn't exist yet.
 */
async function loadEntrySignals(
  tickers: string[]
): Promise<Map<string, SnapRow[]>> {
  const out = new Map<string, SnapRow[]>();
  if (!isDatabaseConfigured() || tickers.length === 0) return out;
  try {
    const rows = await query<SnapRow & { ticker: string }>(
      `SELECT ticker, signal, score, captured_at
         FROM score_snapshots
        WHERE ticker = ANY($1)
        ORDER BY captured_at ASC`,
      [tickers]
    );
    for (const r of rows) {
      const list = out.get(r.ticker) ?? [];
      list.push({ signal: r.signal, score: r.score, captured_at: r.captured_at });
      out.set(r.ticker, list);
    }
  } catch {
    // Table may not exist yet -- degrade to "no signal".
    return new Map();
  }
  return out;
}

const SIGNAL_SET: ReadonlySet<string> = new Set([
  "STRONG_BUY",
  "BUY",
  "HOLD",
  "TRIM",
  "SELL",
]);

const ENTRY_SNAPSHOT_WINDOW_DAYS = 4;

/**
 * Pick the snapshot closest to the entry date, preferring snapshots captured
 * on-or-before the fill, within +/- ENTRY_SNAPSHOT_WINDOW_DAYS (the snapshot
 * cadence is roughly daily and may not land exactly on the trade date).
 */
function pickSnapshot(
  snaps: SnapRow[] | undefined,
  entryDate: string
): { signal: Signal; score: number } | null {
  if (!snaps || snaps.length === 0) return null;
  const target = Date.parse(entryDate);
  if (Number.isNaN(target)) return null;
  let best: SnapRow | null = null;
  let bestDist = Infinity;
  for (const s of snaps) {
    const t = new Date(s.captured_at).getTime();
    const dist = Math.abs(t - target);
    const onOrBefore = t <= target + 12 * 3600 * 1000;
    const adj = onOrBefore ? dist : dist + 1; // tiny penalty for "after"
    if (adj < bestDist) {
      bestDist = adj;
      best = s;
    }
  }
  if (!best) return null;
  const days = bestDist / (24 * 3600 * 1000);
  if (days > ENTRY_SNAPSHOT_WINDOW_DAYS) return null;
  const sig = SIGNAL_SET.has(best.signal) ? (best.signal as Signal) : null;
  if (!sig) return null;
  return { signal: sig, score: Number(best.score) };
}

// ---------------------------------------------------------------------------
// Mboum daily OHLC (for MAE/MFE + slippage reference close)
// ---------------------------------------------------------------------------

export type OhlcBar = {
  date: string; // YYYY-MM-DD
  high: number;
  low: number;
  close: number;
};

type MboumHistoryRaw = {
  body?: Record<
    string,
    { date: string; high: number; low: number; close: number }
  >;
};

/**
 * Fetch ~all available daily OHLC for a symbol. `getStockHistory` in mboum.ts
 * deliberately drops high/low (it only needs closes), so the journal calls the
 * raw endpoint via the exported `mboumFetch` to get the fuller bars. Returns []
 * on any failure (no key, network, parse) -- callers treat that as "no
 * excursion data" rather than erroring.
 */
async function getDailyOhlc(symbol: string): Promise<OhlcBar[]> {
  try {
    const data = await mboumFetch<MboumHistoryRaw>(
      "/markets/stock/history",
      { symbol, interval: "1d", diffandsplits: "false" },
      60 * 60
    );
    if (!data?.body) return [];
    return Object.values(data.body)
      .filter(
        (b) =>
          b &&
          Number.isFinite(b.high) &&
          Number.isFinite(b.low) &&
          Number.isFinite(b.close) &&
          b.close > 0
      )
      .map((b) => ({ date: b.date, high: b.high, low: b.low, close: b.close }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    return [];
  }
}

/** Index of the last bar dated on-or-before `date`, or -1. */
function indexOnOrBefore(bars: OhlcBar[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Index of the first bar dated on-or-after `date`, or -1. */
function indexOnOrAfter(bars: OhlcBar[], date: string): number {
  for (let i = 0; i < bars.length; i++) if (bars[i].date >= date) return i;
  return -1;
}

type Excursion = {
  maePct: number | null;
  mfePct: number | null;
  closeOn: (date: string) => number | null;
  available: boolean;
};

/**
 * Compute MAE/MFE over the holding window [entryDate, exitDate] inclusive,
 * relative to the entry FILL price. For an OPEN trade, the window runs to the
 * latest available bar.
 *
 * MAE = (entry - min(low over window)) / entry, floored at 0.
 * MFE = (max(high over window) - entry) / entry, floored at 0.
 */
function computeExcursion(
  bars: OhlcBar[],
  entryPrice: number,
  entryDate: string,
  exitDate: string | null
): Excursion {
  const closeOn = (date: string): number | null => {
    const i = indexOnOrBefore(bars, date);
    return i >= 0 ? bars[i].close : null;
  };
  if (bars.length === 0 || !(entryPrice > 0)) {
    return { maePct: null, mfePct: null, closeOn, available: false };
  }
  const startIdx = indexOnOrAfter(bars, entryDate);
  if (startIdx < 0) {
    return { maePct: null, mfePct: null, closeOn, available: false };
  }
  const endDate = exitDate ?? bars[bars.length - 1].date;
  let endIdx = indexOnOrBefore(bars, endDate);
  if (endIdx < startIdx) endIdx = startIdx;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    if (bars[i].low < minLow) minLow = bars[i].low;
    if (bars[i].high > maxHigh) maxHigh = bars[i].high;
  }
  if (!Number.isFinite(minLow) || !Number.isFinite(maxHigh)) {
    return { maePct: null, mfePct: null, closeOn, available: false };
  }
  const maePct = Math.max(0, (entryPrice - minLow) / entryPrice) * 100;
  const mfePct = Math.max(0, (maxHigh - entryPrice) / entryPrice) * 100;
  return { maePct, mfePct, closeOn, available: true };
}

// ---------------------------------------------------------------------------
// Tagging helpers
// ---------------------------------------------------------------------------

/**
 * Time-of-day bucket from the ENTRY createdAt timestamp, converted to US
 * Eastern (the market's clock). Buckets: pre <09:30, open 09:30-10:30, midday
 * 10:30-14:00, close 14:00-16:00, after >16:00. Unparseable -> "unknown".
 */
function timeOfDayBucket(createdAt: string): TimeOfDayBucket {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(et.find((p) => p.type === "hour")?.value ?? "NaN");
  const m = Number(et.find((p) => p.type === "minute")?.value ?? "NaN");
  if (Number.isNaN(h) || Number.isNaN(m)) return "unknown";
  const mins = h * 60 + m;
  if (mins < 9 * 60 + 30) return "pre";
  if (mins < 10 * 60 + 30) return "open";
  if (mins < 14 * 60) return "midday";
  if (mins <= 16 * 60) return "close";
  return "after";
}

export const TIME_OF_DAY_LABELS: Record<TimeOfDayBucket, string> = {
  pre: "Pre-market",
  open: "Open (9:30-10:30)",
  midday: "Midday",
  close: "Close (2-4pm)",
  after: "After hours",
  unknown: "Unknown time",
};

function daysBetween(a: string, b: string): number | null {
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.max(0, Math.round((t1 - t0) / (24 * 3600 * 1000)));
}

/**
 * Per-trade risk proxy for the R-multiple. The ledger has no explicit stops,
 * so R is MAE-anchored: risk% = the trade's MAE% (how far it actually went
 * against us) -- the standard "implied initial risk" used in MAE/MFE studies.
 * When MAE is unavailable or ~0, we fall back to a fixed risk so R stays
 * finite and honest.
 */
const FALLBACK_RISK_PCT = 8; // %
const MIN_RISK_PCT = 1;

function riskPctFor(maePct: number | null): number {
  if (maePct != null && maePct >= MIN_RISK_PCT) return maePct;
  return FALLBACK_RISK_PCT;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

function statsFor(tag: string, list: JournalTrade[]): TagStats {
  const wins = list.filter((t) => t.outcome === "win");
  const losses = list.filter((t) => t.outcome === "loss");
  const rs = list.map((t) => t.rMultiple).filter((r): r is number => r != null);
  const rets = list
    .map((t) => t.realisedReturnPct)
    .filter((r): r is number => r != null);
  const winRets = wins
    .map((t) => t.realisedReturnPct)
    .filter((r): r is number => r != null);
  const lossRets = losses
    .map((t) => t.realisedReturnPct)
    .filter((r): r is number => r != null);
  const grossWin = wins.reduce((s, t) => s + (t.realisedPnl ?? 0), 0);
  const grossLoss = losses.reduce((s, t) => s + (t.realisedPnl ?? 0), 0);
  const maes = list.map((t) => t.maePct).filter((x): x is number => x != null);
  const mfes = list.map((t) => t.mfePct).filter((x): x is number => x != null);
  const decided = wins.length + losses.length;
  return {
    tag,
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: decided ? (wins.length / decided) * 100 : null,
    expectancyR: mean(rs),
    avgReturnPct: mean(rets),
    avgWinPct: mean(winRets),
    avgLossPct: mean(lossRets),
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    avgMaePct: mean(maes),
    avgMfePct: mean(mfes),
    totalRealised: list.reduce((s, t) => s + (t.realisedPnl ?? 0), 0),
  };
}

function aggregate(
  trades: JournalTrade[],
  tagOf: (t: JournalTrade) => string
): TagStats[] {
  const groups = new Map<string, JournalTrade[]>();
  for (const t of trades) {
    if (t.outcome === "open") continue;
    const tag = tagOf(t);
    const list = groups.get(tag) ?? [];
    list.push(t);
    groups.set(tag, list);
  }
  const stats: TagStats[] = [];
  for (const [tag, list] of groups) stats.push(statsFor(tag, list));
  return stats.sort(
    (a, b) =>
      b.trades - a.trades ||
      (b.expectancyR ?? -Infinity) - (a.expectancyR ?? -Infinity)
  );
}

function summarise(trades: JournalTrade[]): JournalSummary {
  const closed = trades.filter((t) => t.outcome !== "open");
  const wins = closed.filter((t) => t.outcome === "win");
  const losses = closed.filter((t) => t.outcome === "loss");
  const rs = closed.map((t) => t.rMultiple).filter((r): r is number => r != null);
  const winRets = wins
    .map((t) => t.realisedReturnPct)
    .filter((r): r is number => r != null);
  const lossRets = losses
    .map((t) => t.realisedReturnPct)
    .filter((r): r is number => r != null);
  const avgWinPct = mean(winRets);
  const avgLossPct = mean(lossRets);
  const grossWin = wins.reduce((s, t) => s + (t.realisedPnl ?? 0), 0);
  const grossLoss = losses.reduce((s, t) => s + (t.realisedPnl ?? 0), 0);
  const holds = closed
    .map((t) => t.holdDays)
    .filter((d): d is number => d != null);
  const maes = closed.map((t) => t.maePct).filter((x): x is number => x != null);
  const mfes = closed.map((t) => t.mfePct).filter((x): x is number => x != null);
  const decided = wins.length + losses.length;
  return {
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: decided ? (wins.length / decided) * 100 : null,
    expectancyR: mean(rs),
    avgWinPct,
    avgLossPct,
    payoffRatio:
      avgWinPct != null && avgLossPct != null && avgLossPct !== 0
        ? Math.abs(avgWinPct / avgLossPct)
        : null,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    totalRealised: closed.reduce((s, t) => s + (t.realisedPnl ?? 0), 0),
    avgHoldDays: mean(holds),
    avgMaePct: mean(maes),
    avgMfePct: mean(mfes),
    excursionCoverage: closed.filter((t) => t.excursionAvailable).length,
    signalCoverage: closed.filter((t) => t.signalAtEntry != null).length,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function classifyOutcome(pnl: number | null): JournalOutcome {
  if (pnl == null) return "open";
  if (pnl > 1e-6) return "win";
  if (pnl < -1e-6) return "loss";
  return "scratch";
}

export async function buildJournal(): Promise<JournalResult> {
  const state = await readPortfolio();
  const { closed, open } = buildRoundTrips(state);
  const all = [...closed, ...open];

  const tickers = [...new Set(all.map((r) => r.ticker))];

  // Recover entry signals + fetch OHLC concurrently (both degrade to empty).
  const [snapsByTicker, ohlcEntries] = await Promise.all([
    loadEntrySignals(tickers),
    Promise.all(tickers.map(async (t) => [t, await getDailyOhlc(t)] as const)),
  ]);
  const ohlcByTicker = new Map<string, OhlcBar[]>(ohlcEntries);

  let snapshotsUsed = false;
  let excursionUsed = false;

  const trades: JournalTrade[] = all.map((rt) => {
    const bars = ohlcByTicker.get(rt.ticker) ?? [];
    const exc = computeExcursion(
      bars,
      rt.entryPrice,
      rt.entryDate,
      rt.closed ? rt.exitDate : null
    );
    if (exc.available) excursionUsed = true;

    const snap = pickSnapshot(snapsByTicker.get(rt.ticker), rt.entryDate);
    if (snap) snapshotsUsed = true;

    const realisedPnl = rt.closed ? rt.exitProceeds - rt.entryCost : null;
    const realisedReturnPct =
      rt.closed && rt.entryCost > 0 ? (realisedPnl! / rt.entryCost) * 100 : null;

    const riskPct = riskPctFor(exc.maePct);
    const rMultiple =
      realisedReturnPct != null ? realisedReturnPct / riskPct : null;
    const maeR = exc.maePct != null ? exc.maePct / riskPct : null;
    const mfeR = exc.mfePct != null ? exc.mfePct / riskPct : null;

    // Slippage: fill vs that day's close. Positive bps = paid worse than close
    // on a BUY / received worse than close on a SELL.
    const entryClose = exc.closeOn(rt.entryDate);
    const entrySlippageBps =
      entryClose && entryClose > 0
        ? ((rt.entryPrice - entryClose) / entryClose) * 10000
        : null;
    const exitClose = rt.closed ? exc.closeOn(rt.exitDate) : null;
    const exitSlippageBps =
      rt.closed && exitClose && exitClose > 0
        ? ((exitClose - rt.exitPrice) / exitClose) * 10000
        : null;

    return {
      id: rt.entryTxId,
      ticker: rt.ticker,
      companyName: rt.companyName,
      sector: sectorFor(rt.ticker),
      entryPrice: round4(rt.entryPrice),
      exitPrice: rt.closed ? round4(rt.exitPrice) : null,
      shares: round4(rt.shares),
      entryDate: rt.entryDate,
      exitDate: rt.closed ? rt.exitDate : null,
      holdDays: rt.closed ? daysBetween(rt.entryDate, rt.exitDate) : null,
      entryTimeOfDay: timeOfDayBucket(rt.entryCreatedAt),
      realisedPnl: realisedPnl != null ? round2(realisedPnl) : null,
      realisedReturnPct:
        realisedReturnPct != null ? round2(realisedReturnPct) : null,
      outcome: classifyOutcome(realisedPnl),
      signalAtEntry: snap?.signal ?? null,
      scoreAtEntry: snap?.score ?? null,
      signalBasis: snap ? "snapshot" : "none",
      rMultiple: rMultiple != null ? round2(rMultiple) : null,
      maePct: exc.maePct != null ? round2(exc.maePct) : null,
      mfePct: exc.mfePct != null ? round2(exc.mfePct) : null,
      maeR: maeR != null ? round2(maeR) : null,
      mfeR: mfeR != null ? round2(mfeR) : null,
      entrySlippageBps:
        entrySlippageBps != null ? Math.round(entrySlippageBps) : null,
      exitSlippageBps:
        exitSlippageBps != null ? Math.round(exitSlippageBps) : null,
      excursionAvailable: exc.available,
    };
  });

  // Newest first for display.
  trades.sort((a, b) => {
    const ad = a.exitDate ?? a.entryDate;
    const bd = b.exitDate ?? b.entryDate;
    return ad < bd ? 1 : ad > bd ? -1 : 0;
  });

  return {
    trades,
    summary: summarise(trades),
    bySignal: aggregate(trades, (t) => (t.signalAtEntry ? t.signalAtEntry : "Untagged")),
    bySector: aggregate(trades, (t) => t.sector),
    byTimeOfDay: aggregate(trades, (t) => TIME_OF_DAY_LABELS[t.entryTimeOfDay]),
    data: {
      hasDb: isDatabaseConfigured(),
      snapshotsUsed,
      excursionUsed,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
