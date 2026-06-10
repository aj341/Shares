import "server-only";
import { getPastEarningsReports } from "@/lib/events";
import { getStockHistory } from "@/lib/mboum";

/**
 * Historical earnings event-risk: how much does this stock typically move on
 * an earnings print?
 *
 * Method: pull past report dates from the Finnhub earnings calendar (~2 years
 * back), then for each print find the close-to-close move spanning the report
 * using ~25 months of daily candles. Earnings can land before-open ("bmo") or
 * after-close ("amc"); we use the reported hour when present to pick the right
 * candle pair, otherwise the day-over-day close spanning the date is a fine
 * approximation.
 *
 * Average the most recent up to 8 prints; require at least 3 to report.
 * Results are cached in-module (12h TTL) — earnings history barely changes.
 *
 * Graceful degradation: any provider failure resolves to null.
 */

export type EarningsMoveStats = {
  /** Average absolute % move across the sampled prints (e.g. 9.8). */
  avgAbsMovePct: number;
  /** Number of prints in the average. */
  samples: number;
  /** Absolute % moves, most recent first. */
  lastMoves: number[];
};

const LOOKBACK_DAYS = 740; // ~2 years of report dates
const CANDLE_MONTHS_BACK = 25;
const MAX_PRINTS = 8;
const MIN_PRINTS = 3;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const NEGATIVE_TTL_MS = 30 * 60 * 1000; // retry sooner after failures / no data

type CacheEntry = { value: EarningsMoveStats | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Average absolute post-earnings move for a ticker, from its last ~8 prints.
 * Returns null when there isn't enough history (< 3 usable prints) or when
 * a provider call fails. Never throws.
 */
export async function getHistoricalEarningsMoves(
  ticker: string
): Promise<EarningsMoveStats | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  const now = Date.now();
  const hit = cache.get(symbol);
  if (hit && hit.expiresAt > now) return hit.value;

  let stats: EarningsMoveStats | null = null;
  try {
    stats = await computeStats(symbol);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[earnings-risk] failed:", (err as Error).message);
    }
    stats = null;
  }

  cache.set(symbol, {
    value: stats,
    expiresAt: now + (stats ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
  });
  return stats;
}

async function computeStats(symbol: string): Promise<EarningsMoveStats | null> {
  const now = new Date();
  const to = toISODate(new Date(now.getTime() - 86_400_000)); // yesterday
  const from = toISODate(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000));

  const [reports, candles] = await Promise.all([
    getPastEarningsReports(symbol, from, to),
    getStockHistory(symbol, { monthsBack: CANDLE_MONTHS_BACK }),
  ]);
  if (reports.length === 0 || candles.length < 2) return null;

  // Dedupe report dates (calendar can occasionally repeat rows).
  const seen = new Set<string>();
  const uniqueReports = reports.filter((r) => {
    if (seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });

  const dates = candles.map((c) => c.date); // ascending YYYY-MM-DD
  const moves: number[] = []; // most recent first

  // Walk reports newest-first, collecting up to MAX_PRINTS usable moves.
  for (let i = uniqueReports.length - 1; i >= 0 && moves.length < MAX_PRINTS; i--) {
    const { date, hour } = uniqueReports[i];
    const afterClose = hour === "amc";

    // "amc": the print lands after the close on `date`, so the pre-print
    // close is ON the report date and the post-print close is the next
    // session. Otherwise (bmo / unknown): pre-print is the prior session,
    // post-print is the close on (or first session after) the report date.
    let beforeIdx = -1;
    for (let j = dates.length - 1; j >= 0; j--) {
      if (afterClose ? dates[j] <= date : dates[j] < date) {
        beforeIdx = j;
        break;
      }
    }
    if (beforeIdx < 0) continue;

    let afterIdx = -1;
    for (let j = beforeIdx + 1; j < dates.length; j++) {
      if (afterClose ? dates[j] > date : dates[j] >= date) {
        afterIdx = j;
        break;
      }
    }
    if (afterIdx < 0) continue;

    const before = candles[beforeIdx].close;
    const after = candles[afterIdx].close;
    if (!(before > 0) || !(after > 0)) continue;

    moves.push(Math.abs(after / before - 1) * 100);
  }

  if (moves.length < MIN_PRINTS) return null;

  const avg = moves.reduce((s, m) => s + m, 0) / moves.length;
  return {
    avgAbsMovePct: Math.round(avg * 10) / 10,
    samples: moves.length,
    lastMoves: moves.map((m) => Math.round(m * 10) / 10),
  };
}
