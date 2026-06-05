import { NextResponse } from "next/server";
import { captureSnapshot } from "@/lib/backtest";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Capture a score snapshot of the current portfolio.
 * Intended to be hit by a Railway cron (e.g. daily). No-op without a DB.
 */
export async function GET() {
  try {
    const { captured } = await captureSnapshot();
    return NextResponse.json({ ok: true, captured });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to capture snapshot",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
