import { NextRequest, NextResponse } from "next/server";
import { getIntradaySeries } from "@/lib/intraday-chart";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * [chart] GET /api/intraday?symbol=XXX
 * Today's intraday 1D series + summary (open/high/low/prevClose/last/%change).
 * Always 200 with hasData:false when upstream data is unavailable, so the
 * client renders an empty state rather than treating it as an error.
 */
export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol")?.trim();
    if (!symbol) {
      const body: ApiError = { error: "Missing required query param: symbol" };
      return NextResponse.json(body, { status: 400 });
    }
    const series = await getIntradaySeries(symbol);
    return NextResponse.json(series);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build intraday series",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
