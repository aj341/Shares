import { NextRequest, NextResponse } from "next/server";
import { captureSnapshot } from "@/lib/backtest";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Capture a score snapshot of the current portfolio.
 * Intended to be hit by a Railway cron (e.g. daily). No-op without a DB.
 *
 * If CRON_SECRET is set, the request must supply ?secret= (or x-cron-secret
 * header) matching it — prevents the public endpoint from being spammed.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const provided =
      req.nextUrl.searchParams.get("secret") || req.headers.get("x-cron-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" } satisfies ApiError, {
        status: 401,
      });
    }
  }
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
