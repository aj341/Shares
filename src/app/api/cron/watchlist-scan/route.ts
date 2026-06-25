import { NextRequest, NextResponse } from "next/server";
// [refresh] getAllRanked surfaces the persisted scanned_at; clearWatchlistCache
// busts the 15-min watchlist cache so the next read sees the fresh scores.
import { runWatchlistScan, getAllRanked } from "@/lib/watchlist-screen";
import { clearWatchlistCache } from "@/lib/watchlist";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
// [scanscore] The scan now also computes the full 0-100 engine score per name
// (computeLiveMetrics + scoreHolding) across the 104-name universe, on top of
// the relative-strength pulls — so give it the full server budget. Persistence
// is incremental per-name, so even if the platform cuts the run short, coverage
// accumulates across runs rather than being lost.
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


/**
 * [refresh] Client-callable manual re-scan (same-origin user action, NO
 * CRON_SECRET — the secret only guards the public GET cron). Runs the SAME
 * runWatchlistScan() the cron does, busts the watchlist cache so fresh scores
 * are read immediately, and returns the latest persisted scan time so the UI
 * can update its "Scores as of" label without a second round-trip.
 *
 * The scan scores ~104 names (~2-3 min), so it needs the full server budget
 * (maxDuration = 300, set above).
 */
export async function POST() {
  try {
    const { ranked } = await runWatchlistScan();
    // [refresh] Bust the 15-min watchlist cache so the very next dashboard read
    // reflects the fresh scores rather than serving the stale pre-scan copy.
    clearWatchlistCache();
    // [refresh] Read back the persisted scan time (null-safe). Fall back to now
    // when no rankings are available (e.g. Mboum unconfigured -> empty scan).
    let scannedAt: string | null = null;
    try {
      const ranks = await getAllRanked();
      scannedAt = ranks[0]?.scannedAt ?? null;
    } catch {
      /* best-effort — the scan still succeeded */
    }
    if (!scannedAt) scannedAt = new Date().toISOString();
    return NextResponse.json({ ok: true, ranked, scannedAt });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to run watchlist scan",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
