import { NextResponse } from "next/server";
import { buildWatchlist } from "@/lib/watchlist";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Curated watchlist candidates enriched with live Mboum metrics. */
export async function GET() {
  try {
    return NextResponse.json(await buildWatchlist());
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build watchlist",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
