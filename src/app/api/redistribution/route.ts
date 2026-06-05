import { NextResponse } from "next/server";
import { buildPortfolio, toAudRedistribution } from "@/lib/portfolio";
import { buildRedistribution } from "@/lib/redistribution";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const portfolio = await buildPortfolio();
    const plan = toAudRedistribution(
      buildRedistribution(portfolio),
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
