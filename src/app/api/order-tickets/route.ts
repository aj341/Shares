import { NextResponse } from "next/server";
// [wfa] Order-tickets endpoint. *** DISPLAY ONLY — NEVER PLACES ORDERS. ***
// IBKR Flex is read-only; there is no order API. Turns the redistribution
// engine's already-sized recommendations into copyable, pre-filled tickets the
// user enters MANUALLY in IBKR. Additive — no scoring/redistribution change.
import { buildPortfolio } from "@/lib/portfolio";
import { buildRedistribution } from "@/lib/redistribution";
import { buildOrderTicketsFromRedistribution } from "@/lib/order-tickets";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const portfolio = await buildPortfolio();
    // Reuse the redistribution engine exactly as the rest of the app does —
    // sizing already respects the concentration / position-sizing limits.
    const redistribution = buildRedistribution(portfolio);
    const result = await buildOrderTicketsFromRedistribution(
      redistribution,
      portfolio
    );
    return NextResponse.json({
      ...result,
      source: portfolio.source,
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build order tickets",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
