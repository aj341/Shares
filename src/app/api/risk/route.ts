import { NextResponse } from "next/server";
import { buildRiskAnalysis } from "@/lib/risk";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Portfolio-level risk analytics: relative strength, beta, concentration, correlation. */
export async function GET() {
  try {
    const analysis = await buildRiskAnalysis();
    return NextResponse.json(analysis);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build risk analysis",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
