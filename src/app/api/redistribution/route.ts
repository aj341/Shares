import { NextResponse } from "next/server";
import { buildPortfolio, toAudRedistribution } from "@/lib/portfolio";
import { buildRedistribution } from "@/lib/redistribution";
import { getMarketRegime } from "@/lib/regime";
import { buildWatchlist } from "@/lib/watchlist";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [portfolio, regime] = await Promise.all([
      buildPortfolio(),
      getMarketRegime().catch(() => null),
    ]);
    const watch =
      regime?.regime === "risk_off" ? null : await buildWatchlist().catch(() => null);
    const candidates = (watch?.items ?? [])
      .filter((i) => i.price != null && i.price > 0 && i.bucket !== "overbought")
      .slice(0, 3)
      .map((i) => ({
        ticker: i.ticker,
        companyName: i.companyName,
        priceUsd: i.price as number,
        rationale: i.whyItFits,
      }));
    const plan = toAudRedistribution(
      buildRedistribution(portfolio, {
        targetCashBufferPct: regime?.targetCashBufferPct,
        regimeLabel: regime?.label,
        newPositionCandidates: candidates,
      }),
      portfolio.fxUsdToAud
    );
    return NextResponse.json(plan);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build redistribution plan",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
