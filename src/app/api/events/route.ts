import { NextResponse } from "next/server";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { getUpcomingEvents } from "@/lib/events";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Upcoming-events radar: earnings dates + ex-dividends for held tickers. */
export async function GET() {
  try {
    const { positions } = await getDerivedPortfolio();
    const tickers = positions.map((p) => p.ticker);
    const events = await getUpcomingEvents(tickers);
    return NextResponse.json({ events });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build upcoming events",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
