import { NextResponse } from "next/server";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { getUpcomingEvents, type UpcomingEvent } from "@/lib/events";
import { getHistoricalEarningsMoves } from "@/lib/earnings-risk";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** How far out we bother computing historical earnings-move context. */
const RISK_HORIZON_DAYS = 30;

/** Upcoming event, optionally enriched with historical earnings-move context. */
type EventWithRisk = UpcomingEvent & {
  /** Avg absolute % move on past earnings prints (earnings events only). */
  avgAbsMovePct?: number;
};

/** Upcoming-events radar: earnings dates + ex-dividends for held tickers. */
export async function GET() {
  try {
    const { positions } = await getDerivedPortfolio();
    const tickers = positions.map((p) => p.ticker);
    const events = await getUpcomingEvents(tickers);

    // Attach historical earnings-move context to near-term earnings events
    // only (one fetch chain per unique ticker; failures degrade to no field).
    const nearTickers = [
      ...new Set(
        events
          .filter((e) => e.type === "earnings" && e.daysAway <= RISK_HORIZON_DAYS)
          .map((e) => e.ticker)
      ),
    ];
    const statsByTicker = new Map(
      await Promise.all(
        nearTickers.map(
          async (t) =>
            [t, await getHistoricalEarningsMoves(t).catch(() => null)] as const
        )
      )
    );

    const enriched: EventWithRisk[] = events.map((e) => {
      if (e.type !== "earnings" || e.daysAway > RISK_HORIZON_DAYS) return e;
      const stats = statsByTicker.get(e.ticker);
      return stats ? { ...e, avgAbsMovePct: stats.avgAbsMovePct } : e;
    });

    return NextResponse.json({ events: enriched });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build upcoming events",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
