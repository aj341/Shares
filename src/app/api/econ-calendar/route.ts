import { NextResponse } from "next/server";
// [scanner] Economic-calendar awareness — additive route. Surfaces today's /
// upcoming high-impact macro events + an intraday blackout-window flag. Falls
// back to the app's static FOMC/CPI calendar when the live feed is empty.
import { buildEconCalendar } from "@/lib/econ-calendar";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/econ-calendar — high-impact macro events + blackout flag. */
export async function GET() {
  try {
    const data = await buildEconCalendar();
    return NextResponse.json(data);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build economic calendar",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
