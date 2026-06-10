import "server-only";
import { resolveDataSource } from "@/lib/constants";
import * as finnhub from "@/lib/finnhub";
import { getStockHistory, isMboumConfigured } from "@/lib/mboum";
import { computeLiveMetrics } from "@/lib/live-metrics";
import { getLiveAnnouncements, minAnnouncementImpact } from "@/lib/announcements";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import { buildLiveVerdict } from "@/lib/verdict";
import { enhanceVerdict, getCachedEnhancedVerdict } from "@/lib/verdict-llm";
import { universeEntryFor } from "@/lib/universe";
import type { Holding } from "@/lib/types";

/**
 * Research view: run ANY ticker through the exact same engine as the
 * portfolio holdings — live quote, 20 live metrics, score/signal, real news,
 * verdict (with the cached Claude overlay) — so watchlist names open the same
 * detail drawer. Position fields are zeroed (shares 0 marks "not held").
 *
 * No-mock rules apply: if live data is unavailable the result is null and the
 * API returns an error — never a mock-backed rating.
 */

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; holding: Holding }>();

export async function buildResearchHolding(raw: string): Promise<Holding | null> {
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) return null;
  if (resolveDataSource() !== "finnhub" || !isMboumConfigured()) return null;

  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.holding;

  const [quote, announcements] = await Promise.all([
    finnhub.getQuote(ticker).catch(() => null),
    getLiveAnnouncements(ticker).catch(() => []),
  ]);

  // Live price: Finnhub, else a REAL Mboum close. Never mock.
  let currentPrice = quote && quote.c > 0 ? quote.c : 0;
  let dayChangePct = quote?.dp ?? 0;
  if (currentPrice <= 0) {
    const candles = await getStockHistory(ticker, { interval: "1d", days: 10 }).catch(
      () => []
    );
    if (candles.length > 0) {
      const last = candles[candles.length - 1];
      const prev = candles.length > 1 ? candles[candles.length - 2] : null;
      currentPrice = last.close;
      dayChangePct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
    }
  }

  const metrics = await computeLiveMetrics(
    ticker,
    announcements.map((a) => a.impactScore)
  ).catch(() => null);

  // No live data -> no rating. The caller surfaces an error.
  if (!metrics || currentPrice <= 0) return null;

  const { score, signal } = scoreHolding(metrics, {
    rsi: extractRsi(metrics),
    unrealisedPnlPct: 0,
    portfolioWeight: 0,
    minAnnouncementImpact: minAnnouncementImpact(announcements),
  });

  const base = buildLiveVerdict({ ticker, metrics, score, signal, announcements });
  const cached = getCachedEnhancedVerdict(ticker, score);
  const verdict = cached ?? base;
  if (!cached) {
    void enhanceVerdict({ ticker, metrics, score, signal, announcements, base }).catch(
      () => {}
    );
  }

  const holding: Holding = {
    ticker,
    companyName: universeEntryFor(ticker)?.companyName ?? ticker,
    shares: 0,
    entryPrice: 0,
    currentPrice,
    dayChangePct,
    dataQuality: "live",
    costBasis: 0,
    marketValue: 0,
    unrealisedPnl: 0,
    unrealisedPnlPct: 0,
    portfolioWeight: 0,
    score,
    signal,
    metrics,
    announcements,
    verdict,
  };

  cache.set(ticker, { at: Date.now(), holding });
  return holding;
}
