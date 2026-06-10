import { NextRequest, NextResponse } from "next/server";
import { buildResearchHolding } from "@/lib/research";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Full holding-style analysis for any ticker (watchlist drawer). */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params;
    const holding = await buildResearchHolding(ticker);
    if (!holding) {
      const body: ApiError = {
        error: "Live data unavailable for this ticker",
        detail: "No rating is produced without live data (mock is never used).",
      };
      return NextResponse.json(body, { status: 503 });
    }
    return NextResponse.json({ holding });
  } catch (err) {
    const body: ApiError = {
      error: "Research lookup failed",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
