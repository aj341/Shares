import { NextResponse } from "next/server";
// [wfa] Walk-forward (rolling out-of-sample) validation endpoint. Additive —
// sits alongside /api/calibration (full-sample) and re-uses the same engine.
import { getWalkForward } from "@/lib/walk-forward";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Rolling walk-forward validation over score_snapshots: each in-sample window
 * "fits" the per-band edge, the forward out-of-sample window tests it, and we
 * report OOS hit-rate / edge per signal-band plus an IS-vs-OOS overfit
 * indicator. Returns { walkForward } where walkForward is null when no DB / no
 * snapshots, and carries `insufficientData: true` when the young table can't
 * support an honest split (UI shows an "insufficient" state). Never alters the
 * base score/signal.
 */
export async function GET() {
  try {
    const walkForward = await getWalkForward();
    return NextResponse.json({
      walkForward,
      methodology: {
        windows:
          "Rolling folds: in-sample window (default 60d) is forward-tested by " +
          "the out-of-sample window immediately after it (default 30d), stepping " +
          "30d per fold. OOS is always later in time than the IS it tests.",
        edge:
          "Per fold + band the existing computeCalibration runs separately on IS " +
          "and OOS snapshots (strict lookahead preserved). edge = (winRateVsBench " +
          "- 0.5) + clamp(avgExcess/0.05,-1,1)*0.5.",
        overfit:
          "edgeDegradation = IS edge - OOS edge (sample-weighted across folds); " +
          "positive => the in-sample edge decayed out of sample. overfitVerdict " +
          "bins the grid-mean degradation into robust/mild/overfit.",
        honesty:
          "Buckets with fewer than the OOS sample floor of matured samples are " +
          "flagged `insufficient` and excluded from the headline indicator.",
      },
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to compute walk-forward validation",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
