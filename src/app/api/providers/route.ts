import { NextResponse } from "next/server";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { getProviderCheck, type ProviderCheck } from "@/lib/providers";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Multi-source corroboration for the held tickers: compares Finnhub vs Mboum
 * prices and flags divergence. GET -> { checks: ProviderCheck[] }.
 */
export async function GET() {
  try {
    const { positions } = await getDerivedPortfolio();
    const checks: ProviderCheck[] = await Promise.all(
      positions.map((p) => getProviderCheck(p.ticker))
    );
    return NextResponse.json({ checks });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build provider checks",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
