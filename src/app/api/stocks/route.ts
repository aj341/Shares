import { NextResponse } from "next/server";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { buildStocksTechnicals } from "@/lib/technicals";
import { isMboumConfigured } from "@/lib/mboum";
import type { ApiError, StocksResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Per-holding technicals (RSI, MAs, 52w, P/E, analyst target/consensus, sparkline). */
export async function GET() {
  try {
    const asOf = new Date().toISOString();
    if (!isMboumConfigured()) {
      return NextResponse.json({ byTicker: {}, asOf, source: "none" } satisfies StocksResponse);
    }
    const { positions } = await getDerivedPortfolio();
    const byTicker = await buildStocksTechnicals(positions.map((p) => p.ticker));
    return NextResponse.json({ byTicker, asOf, source: "mboum" } satisfies StocksResponse);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build stock technicals",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
