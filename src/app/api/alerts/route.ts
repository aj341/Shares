import { NextResponse } from "next/server";
import { computeAlerts } from "@/lib/alerts";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Current portfolio alerts (signal changes, RSI extremes, news, concentration). */
export async function GET() {
  try {
    const alerts = await computeAlerts();
    return NextResponse.json({ alerts });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to compute alerts",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
