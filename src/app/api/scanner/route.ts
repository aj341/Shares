import { NextResponse } from "next/server";
// [scanner] "Today's Battle List" — additive day-trading scanner route.
// Reuses the existing watchlist factor/RS engine + insider overlay; never
// alters score/Signal math. Always returns a valid payload (empty when Mboum
// is unconfigured or the screener yields nothing).
import { buildScanner } from "@/lib/scanner";
import type { MboumScreenerList } from "@/lib/mboum";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/scanner — the ranked Battle List.
 *
 * Optional query params:
 *   ?lists=day_gainers,day_losers,most_actives,trending  (override the pool)
 *   ?catalysts=0                                         (skip news tagging)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const listParam = url.searchParams.get("lists");
    const withCatalysts = url.searchParams.get("catalysts") !== "0";

    const allowed = new Set([
      "day_gainers",
      "day_losers",
      "most_actives",
      "trending",
      "small_cap_gainers",
      "growth_technology_stocks",
    ]);
    const lists: MboumScreenerList[] | undefined = listParam
      ? (listParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => allowed.has(s)) as MboumScreenerList[])
      : undefined;

    const data = await buildScanner({
      lists: lists && lists.length ? lists : undefined,
      withCatalysts,
    });
    return NextResponse.json(data);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build scanner",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
