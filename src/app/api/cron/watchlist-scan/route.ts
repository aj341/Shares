import { NextRequest, NextResponse } from "next/server";
import { runWatchlistScan } from "@/lib/watchlist-screen";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
// Scanning ~40 tickers in batches of 5 against Mboum takes a while.
export const maxDuration = 300;

/**
 * Run the relative-strength watchlist scan over the Nasdaq-100 universe.
 * Intended to be hit by a Railway cron (e.g. daily after the close).
 * Persists rankings to Postgres (in-memory fallback without a DB).
 *
 * If CRON_SECRET is set, the request must supply ?secret= (or x-cron-secret
 * header) matching it — prevents the public endpoint from being spammed.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const provided =
      req.nextUrl.searchParams.get("secret") || req.headers.get("x-cron-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" } satisfies ApiError, {
        status: 401,
      });
    }
  }
  try {
    const { scanned, ranked } = await runWatchlistScan();
    return NextResponse.json({ ok: true, scanned, ranked });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to run watchlist scan",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
