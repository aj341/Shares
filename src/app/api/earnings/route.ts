import { NextResponse } from "next/server";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { buildWatchlist } from "@/lib/watchlist";
import { getEarningsSignals, type EarningsSignal } from "@/lib/earnings-signals";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Earnings catalyst calendar: per-name next earnings date + days-until +
 * pre-positioning flag, estimate-revision trend, and post-earnings-drift (PEAD)
 * bias, for every holding AND watchlist name.
 *
 * Additive + null-safe: this route reads catalyst signals only and never
 * influences scores / signals / trade recommendations. Any provider miss simply
 * yields a sparser row (or no row) rather than an error.
 *
 *   GET /api/earnings
 *   -> { rows: EarningsRow[], asOf }
 *
 * `rows` are sorted by soonest upcoming earnings first, then names with no
 * known next date (sorted by ticker). `kind` tags whether a ticker is a current
 * holding, a watchlist name, or both.
 */

type RowKind = "holding" | "watchlist" | "both";

type EarningsRow = {
  ticker: string;
  companyName: string;
  kind: RowKind;
} & EarningsSignal;

export async function GET() {
  try {
    // Watchlist failures must not sink the whole route — degrade to holdings.
    const [{ positions }, watch] = await Promise.all([
      getDerivedPortfolio(),
      buildWatchlist().catch(() => null),
    ]);

    const holdingTickers = new Set(
      positions.map((p) => p.ticker.toUpperCase())
    );
    const watchTickers = new Set(
      (watch?.items ?? []).map((i) => i.ticker.toUpperCase())
    );

    // Friendly names keyed by ticker (holding names win over watchlist names).
    const names = new Map<string, string>();
    for (const it of watch?.items ?? [])
      names.set(it.ticker.toUpperCase(), it.companyName);
    for (const p of positions) names.set(p.ticker.toUpperCase(), p.companyName);

    const allTickers = [...new Set([...holdingTickers, ...watchTickers])];
    const signals = await getEarningsSignals(allTickers);

    const rows: EarningsRow[] = allTickers
      .map((ticker) => {
        const isHolding = holdingTickers.has(ticker);
        const isWatch = watchTickers.has(ticker);
        const kind: RowKind =
          isHolding && isWatch ? "both" : isHolding ? "holding" : "watchlist";
        const sig = signals.get(ticker) ?? {};
        return {
          ticker,
          companyName: names.get(ticker) ?? ticker,
          kind,
          ...sig,
        };
      })
      // Keep rows that carry at least one resolved earnings sub-signal.
      .filter(
        (r) =>
          r.nextDate != null ||
          r.lastReportDate != null ||
          r.revisionTrend != null
      );

    // Soonest upcoming first; rows with no nextDate sink to the bottom.
    rows.sort((a, b) => {
      const da = a.daysUntil ?? Number.POSITIVE_INFINITY;
      const db = b.daysUntil ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.ticker.localeCompare(b.ticker);
    });

    return NextResponse.json({ rows, asOf: new Date().toISOString() });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build earnings calendar",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
