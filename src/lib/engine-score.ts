// [scanscore] Single shared implementation of the 0-100 engine score for a
// ticker. Previously this lived only inside watchlist.ts (`scoreOnEngine`); the
// scan (watchlist-screen.ts) and buildWatchlist now share ONE implementation so
// universe names persist the SAME score holdings use. The scoring MATH is
// unchanged — this only relocates the computeLiveMetrics + scoreHolding wiring
// so both code paths call it.
import "server-only";
import { computeLiveMetrics } from "@/lib/live-metrics";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import type { Signal } from "@/lib/types";

/**
 * Score a name on the SAME 20-metric engine as holdings — the watchlist bucket
 * is entry TIMING (RSI); this is QUALITY. Null when live data fails (no-mock
 * rule). computeLiveMetrics has its own 10-min cache.
 */
export async function scoreOnEngine(
  ticker: string
): Promise<{ score: number; signal: Signal } | null> {
  try {
    const metrics = await computeLiveMetrics(ticker, []);
    if (!metrics) return null;
    const { score, signal } = scoreHolding(metrics, {
      rsi: extractRsi(metrics),
      unrealisedPnlPct: 0,
      portfolioWeight: 0,
      minAnnouncementImpact: 0,
    });
    return { score, signal };
  } catch {
    return null;
  }
}
