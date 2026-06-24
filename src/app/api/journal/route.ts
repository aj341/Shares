import { NextResponse } from "next/server";
import { buildJournal } from "@/lib/journal";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * [journal] Trade journal + MAE/MFE analytics (ADDITIVE, read-only).
 *
 * Folds the portfolio_transactions ledger into round-trip trades, tags each
 * with signal-at-entry (from score_snapshots), sector, hold time, realised R
 * and win/loss, and computes MAE/MFE from Mboum daily OHLC. Aggregates by
 * signal, sector and time-of-day. Returns honest sample sizes + a methodology
 * echo so the surface is self-documenting. Never mutates anything.
 */
export async function GET() {
  try {
    const journal = await buildJournal();
    return NextResponse.json({
      ...journal,
      methodology: {
        roundTrips:
          "FIFO pairing of BUY lots to SELL fills per ticker; opening seed " +
          "positions act as BUY lots. ADJUSTMENT rows drop the ticker's open " +
          "lots (manual override). Remaining lots are shown as OPEN trades.",
        mae:
          "MAE% = (entryFill - min(daily low over [entry, exit])) / entryFill, " +
          "floored at 0. MFE% = (max(daily high) - entryFill) / entryFill. " +
          "Open trades run to the latest available bar.",
        rMultiple:
          "R = realisedReturn% / riskProxy%, where riskProxy% = the trade's " +
          "own MAE% (implied initial risk) when >= 1%, else a fixed 8% fallback. " +
          "No explicit stops exist in the ledger, so R is MAE-anchored.",
        signalAtEntry:
          "Nearest score_snapshots row within +/-4 days of the entry date " +
          "(prefers on-or-before). null when no snapshot / no DB.",
        limitations:
          "Daily bars only (no intraday path); young/sparse ledger -> small " +
          "samples; snapshots only exist for dates the capture cron ran. Treat " +
          "all by-tag stats as indicative, not significant.",
      },
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build trade journal",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
