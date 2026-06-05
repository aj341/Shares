import { NextResponse } from "next/server";
import { buildPortfolio, toAudPortfolio } from "@/lib/portfolio";
import { readPortfolio } from "@/lib/portfolio-store";
import type { ApiError, PortfolioState } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Full portfolio state: derived cash, enriched holdings, and the ledger. */
export async function GET() {
  try {
    const [portfolioUsd, persisted] = await Promise.all([
      buildPortfolio(),
      readPortfolio(),
    ]);
    const portfolio = toAudPortfolio(portfolioUsd);
    const state: PortfolioState = {
      currentCash: portfolio.cash,
      holdings: portfolio.holdings,
      transactions: persisted.transactions,
    };
    return NextResponse.json(state);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to read portfolio state",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
