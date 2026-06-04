import { getStockHistory, isMboumConfigured } from "@/lib/mboum";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import type {
  DerivedPosition,
  PerformancePoint,
  PerformanceResponse,
  PnlByPeriod,
} from "@/lib/types";

/**
 * Builds the 6-month performance series + period P&L from real Mboum daily
 * history. Series is rebased to 0% at the start; each ticker line is its %
 * return and "Portfolio" is the share-weighted book's % return.
 *
 * Period P&L (daily/weekly/monthly) compares the book's value now vs N trading
 * days ago using Mboum closes × current shares. Total P&L is vs cost basis.
 * If Mboum is unavailable we return hasData=false and the UI hides the chart —
 * we never fabricate price history.
 */

const MONTHS_BACK = 6;
const LOOKBACK = { daily: 1, weekly: 5, monthly: 21 };

export async function buildPerformance(): Promise<PerformanceResponse> {
  const asOf = new Date().toISOString();
  const empty: PerformanceResponse = {
    series: [],
    tickers: [],
    rangeLabel: `${MONTHS_BACK}-Month Performance`,
    hasData: false,
    source: "none",
    pnlByPeriod: null,
    asOf,
  };

  if (!isMboumConfigured()) return empty;

  const { positions } = await getDerivedPortfolio();
  if (positions.length === 0) return empty;

  const histories = await Promise.all(
    positions.map(async (p) => ({
      position: p,
      candles: await getStockHistory(p.ticker, {
        interval: "1d",
        monthsBack: MONTHS_BACK,
      }),
    }))
  );

  const usable = histories.filter((h) => h.candles.length > 1);
  if (usable.length === 0) return empty;

  // Union of trading dates, ascending.
  const dateSet = new Set<string>();
  for (const h of usable) for (const c of h.candles) dateSet.add(c.date);
  const dates = [...dateSet].sort();

  // Per-ticker forward-filled close by date.
  const closeByTicker = new Map<string, Map<string, number>>();
  const firstClose = new Map<string, number>();
  for (const h of usable) {
    const m = new Map<string, number>();
    for (const c of h.candles) m.set(c.date, c.close);
    let last = h.candles[0].close;
    let started = false;
    for (const d of dates) {
      if (m.has(d)) {
        last = m.get(d)!;
        started = true;
      } else if (started) {
        m.set(d, last);
      }
    }
    closeByTicker.set(h.position.ticker, m);
    firstClose.set(h.position.ticker, h.candles[0].close);
  }

  const tickers = usable.map((h) => h.position.ticker);
  const firstBookValue = usable.reduce(
    (s, h) => s + h.position.shares * h.candles[0].close,
    0
  );

  // Rebased series + a per-date book value for the period P&L calc.
  const bookByDate: number[] = [];
  const series: PerformancePoint[] = dates.map((date) => {
    const point: PerformancePoint = { date } as PerformancePoint;
    let book = 0;
    let counted = false;
    for (const h of usable) {
      const close = closeByTicker.get(h.position.ticker)?.get(date);
      if (close === undefined) continue;
      point[h.position.ticker] = round2(
        (close / firstClose.get(h.position.ticker)! - 1) * 100
      );
      book += h.position.shares * close;
      counted = true;
    }
    if (counted && firstBookValue > 0) {
      point.Portfolio = round2((book / firstBookValue - 1) * 100);
    }
    bookByDate.push(book);
    return point;
  });

  return {
    series,
    tickers,
    rangeLabel: `${MONTHS_BACK}-Month Performance`,
    hasData: true,
    source: "mboum",
    pnlByPeriod: computePnl(usable, bookByDate),
    asOf,
  };
}

function computePnl(
  usable: { position: DerivedPosition; candles: { close: number }[] }[],
  bookByDate: number[]
): PnlByPeriod {
  const n = bookByDate.length;
  const bookNow = bookByDate[n - 1] ?? 0;
  const costBasis = usable.reduce(
    (s, h) => s + h.position.shares * h.position.entryPrice,
    0
  );

  const at = (lookback: number) => bookByDate[Math.max(0, n - 1 - lookback)] ?? bookNow;
  const delta = (prev: number) => ({
    value: round2(bookNow - prev),
    pct: prev > 0 ? round2(((bookNow - prev) / prev) * 100) : 0,
  });

  return {
    daily: delta(at(LOOKBACK.daily)),
    weekly: delta(at(LOOKBACK.weekly)),
    monthly: delta(at(LOOKBACK.monthly)),
    total: {
      value: round2(bookNow - costBasis),
      pct: costBasis > 0 ? round2(((bookNow - costBasis) / costBasis) * 100) : 0,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
