import { NextResponse } from "next/server";
import { buildPortfolio, toAudRedistribution } from "@/lib/portfolio";
import { buildRedistribution } from "@/lib/redistribution";
import { getMarketRegime } from "@/lib/regime";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [portfolio, regime] = await Promise.all([
      buildPortfolio(),
      getMarketRegime().catch(() => null),
    ]);
    const plan = toAudRedistribution(
      buildRedistribution(portfolio, {
        targetCashBufferPct: regime?.targetCashBufferPct,
        regimeLabel: regime?.label,
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
