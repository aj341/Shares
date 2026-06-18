// [regime] Market-regime / breadth context endpoint.
//
// Additive, read-only overlay: serves getRegimeAssessment() (overall posture
// from QQQ/SPY vs their 50d/200d MAs + realized-vol trend, plus cross-sector
// breadth and leading/lagging sectors). Does NOT touch any score or Signal —
// the dashboard banner consumes this purely as context. Index/ETF history is
// fetched via the shared per-build cache, so this stays cheap.
import { NextResponse } from "next/server";
import { getRegimeAssessment } from "@/lib/regime";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const assessment = await getRegimeAssessment();
    return NextResponse.json(assessment);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build regime assessment",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
