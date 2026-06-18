// [sizing] Concentration / position-sizing endpoint.
//
// Surfaces the pure assessConcentration() output over the live portfolio.
// Additive — sits alongside the existing /api/risk route (which keeps its own
// HHI/sector view); this endpoint focuses on configurable LIMITS + breach
// status so the UI can render OK/WARN/BREACH and the suggested $-per-name.
import { NextResponse } from "next/server";
import { buildPortfolio } from "@/lib/portfolio";
import { assessConcentration } from "@/lib/concentration";
import { CONCENTRATION_LIMITS } from "@/lib/constants";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const portfolio = await buildPortfolio();
    const equity = portfolio.holdings.reduce((s, h) => s + h.marketValue, 0);
    const assessment = assessConcentration(
      portfolio.holdings,
      CONCENTRATION_LIMITS,
      equity
    );
    return NextResponse.json({
      ...assessment,
      asOf: portfolio.asOf,
      source: portfolio.source,
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build concentration assessment",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
