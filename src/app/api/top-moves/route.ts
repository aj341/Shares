import { NextResponse } from "next/server";
// [top3] AI "Top 3 Moves Today" — additive route. Reuses the existing
// portfolio + redistribution + watchlist builders; never alters them.
import { buildTopMovesData } from "@/lib/dashboard";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Top 3 Moves Today: deterministic candidate selection + ranking from the
 * app's own signals, with an optional Claude-written rationale. Always returns
 * a valid payload (heuristic fallback when the LLM is unavailable).
 */
export async function GET() {
  try {
    const data = await buildTopMovesData();
    return NextResponse.json(data);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build top moves",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
