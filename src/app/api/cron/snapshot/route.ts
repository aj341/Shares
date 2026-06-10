import { NextRequest, NextResponse } from "next/server";
import { captureSnapshot } from "@/lib/backtest";
import { runWatchlistScan } from "@/lib/watchlist-screen";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily housekeeping: capture a score snapshot AND refresh the watchlist
 * relative-strength rankings (the scan rides along here so it needs no
 * separate Railway cron entry). Hit by the Railway cron daily.
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
    const { captured } = await captureSnapshot();
    // Refresh the watchlist screen nightly alongside the snapshot. Failures
    // must never break snapshot capture — the previous rankings just persist.
    const scan = await runWatchlistScan().catch(() => null);
    return NextResponse.json({
      ok: true,
      captured,
      watchlistScan: scan ?? { scanned: 0, ranked: 0 },
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to capture snapshot",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
