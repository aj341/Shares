import { NextResponse } from "next/server";
import { buildDashboard } from "@/lib/dashboard";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Aggregates portfolio + redistribution + disagreement in a single round-trip. */
export async function GET() {
  try {
    const dashboard = await buildDashboard();
    return NextResponse.json(dashboard);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build dashboard",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
