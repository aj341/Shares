import { NextResponse } from "next/server";
import { buildExecutionStats } from "@/lib/execution-stats";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * [journal] Execution / slippage analytics (ADDITIVE, read-only).
 *
 * Estimates per-fill slippage as fill-vs-same-day-close (bps) from the ledger
 * fills + Mboum daily closes, then aggregates by signal type and entry
 * time-of-day. Honest about what is vs isn't estimable (see the response's
 * `methodology`). Never mutates anything.
 */
export async function GET() {
  try {
    const stats = await buildExecutionStats();
    return NextResponse.json(stats);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build execution stats",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
