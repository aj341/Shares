import { NextResponse } from "next/server";
import { getCalibration } from "@/lib/calibration";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * [calibration] Conviction-calibration backtest.
 *
 * Reads accumulated score_snapshots and reports, per signal AND per score band,
 * the historical hit-rate / average forward return / sample size at each
 * horizon (~5/20/60 calendar days), plus a shrinkage-based conviction level.
 *
 * Responds { calibration } where calibration is null when no DB / no snapshots
 * yet (the UI then shows an honest "insufficient data" state). This is purely
 * additive and never alters the base score/signal.
 */
export async function GET() {
  try {
    const calibration = await getCalibration();
    return NextResponse.json({
      calibration,
      // Echo the methodology so the surface is self-documenting.
      methodology: {
        forwardReturn:
          "fwd = (forwardPrice - snapshotPrice) / snapshotPrice; forwardPrice " +
          "is the same ticker's later snapshot (or Mboum candle) closest to " +
          "date+H, STRICTLY after the snapshot date. Immature snapshots are " +
          "skipped (no lookahead).",
        horizonsDays: [5, 20, 60],
        benchmark: "QQQ (excess return = stock fwd - QQQ fwd over same window)",
        conviction:
          "edge = (winRateVsBench - 0.5) + clamp(avgExcess/0.05, -1, 1)*0.5; " +
          "confidence = n/(n+8); shrunkEdge = edge*confidence; " +
          "weight = clamp(0.5 + shrunkEdge/2, 0, 1); levels gated at n>=5.",
      },
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to compute calibration",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
