import "server-only";
// [scan-news-parity] The watchlist scan must score a name the SAME way the
// research/detail drawer does, or the persisted score (which feeds the
// redistribution engine) drifts below what the user sees when they open a
// name's full analysis. The detail path (buildResearchHolding) feeds live
// news/announcement impact into computeLiveMetrics + scoreHolding; the scan
// previously passed an empty array, dropping the sentiment/catalyst
// contribution (e.g. IRM scanned 86 but the drawer showed 89). We now fetch
// the same announcements here so scan == detail == redistribution input.
import { computeLiveMetrics } from "@/lib/live-metrics";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import { getLiveAnnouncements, minAnnouncementImpact } from "@/lib/announcements";
import type { Signal } from "@/lib/types";

/**
 * Score a single ticker on the shared engine (computeLiveMetrics + scoreHolding)
 * with the SAME news inputs the detail drawer uses. Returns null on any failure
 * so the caller can skip the name (never a fabricated score).
 */
export async function scoreOnEngine(
  ticker: string
): Promise<{ score: number; signal: Signal } | null> {
  try {
    const announcements = await getLiveAnnouncements(ticker).catch(() => []);
    const metrics = await computeLiveMetrics(
      ticker,
      announcements.map((a) => a.impactScore)
    );
    if (!metrics) return null;
    const { score, signal } = scoreHolding(metrics, {
      rsi: extractRsi(metrics),
      unrealisedPnlPct: 0,
      portfolioWeight: 0,
      minAnnouncementImpact: minAnnouncementImpact(announcements),
    });
    return { score, signal };
  } catch {
    return null;
  }
}
