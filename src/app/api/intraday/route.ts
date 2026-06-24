// [intraday] Intraday technicals + micro-regime endpoint.
//
// Additive, read-only overlay. Returns per-symbol anchored/session VWAP,
// price-vs-VWAP state, ATR (+ suggested stop and VWAP±k·ATR bands) and a
// micro-regime (trend_up/trend_down/chop) from Mboum intraday bars. It NEVER
// touches any score or Signal — the dashboard panel consumes this purely as
// daily-trader context. Symbols come from ?symbols=AAPL,MSFT (deduped); when
// omitted, the current book's tickers are used. Null-safe + graceful when the
// market is closed / no intraday bars (each field returns null, never throws).
import { NextRequest, NextResponse } from "next/server";
import { getIntradayOverlays, type IntradayInterval } from "@/lib/intraday";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { getMarketSession } from "@/lib/market-session";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_INTERVALS: IntradayInterval[] = ["5m", "15m", "1h"];

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get("symbols");
    const intervalParam = url.searchParams.get("interval") as IntradayInterval | null;
    const interval =
      intervalParam && VALID_INTERVALS.includes(intervalParam)
        ? intervalParam
        : "15m";

    let symbols: string[];
    if (raw) {
      symbols = raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else {
      const { positions } = await getDerivedPortfolio().catch(() => ({
        positions: [] as { ticker: string }[],
      }));
      symbols = positions.map((p) => p.ticker);
    }

    const overlays = await getIntradayOverlays(symbols, { interval });

    return NextResponse.json({
      session: getMarketSession(),
      interval,
      asOf: new Date().toISOString(),
      byTicker: overlays,
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build intraday overlay",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
