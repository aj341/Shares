import { NextResponse } from "next/server";
import { buildPerformance } from "@/lib/performance";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 6-month price-history performance series (Mboum-backed). */
export async function GET() {
  try {
    const performance = await buildPerformance();
    return NextResponse.json(performance);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build performance series",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
