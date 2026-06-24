import { NextRequest, NextResponse } from "next/server";
import { getChartSeries, normalizeRange } from "@/lib/chart-series";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * [chartframes] GET /api/chart?symbol=XXX&range=1D|5D|1M|6M|YTD|1Y|5Y|MAX
 *
 * Multi-timeframe per-stock series + summary (open/last/change-over-range and a
 * reference price: prev close for 1D, period-start for longer ranges).
 *
 * ADDITIVE: a brand-new route. It always returns 200 with `hasData:false` when
 * upstream data is unavailable, so the client renders an empty state rather
 * than treating it as an error. Caching is handled per (symbol,range) inside
 * the engine via Mboum's `revalidate` (60s for 5D, ~300s for longer ranges).
 */
export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol")?.trim();
    if (!symbol) {
      const body: ApiError = { error: "Missing required query param: symbol" };
      return NextResponse.json(body, { status: 400 });
    }
    const range = normalizeRange(req.nextUrl.searchParams.get("range"));
    const series = await getChartSeries(symbol, range);
    return NextResponse.json(series);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build chart series",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
