import { NextResponse } from "next/server";
import { getSignalPerformance } from "@/lib/backtest";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Signal forward-return backtest derived from accumulated score snapshots. */
export async function GET() {
  try {
    const performance = await getSignalPerformance();
    return NextResponse.json({ performance });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to compute signal performance",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
