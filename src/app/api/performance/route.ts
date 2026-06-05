import { NextRequest, NextResponse } from "next/server";
import { buildPerformance } from "@/lib/performance";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Price-history performance series (Mboum-backed). `?range=` picks the window. */
export async function GET(req: NextRequest) {
  try {
    const range = req.nextUrl.searchParams.get("range") ?? undefined;
    const performance = await buildPerformance(range);
    return NextResponse.json(performance);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build performance series",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
