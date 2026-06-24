import { NextRequest, NextResponse } from "next/server";
// [wfa] Latency-aware intraday alerts cron. Guarded by CRON_SECRET like the
// other crons; fires ONLY when called. Pushes high-priority intraday triggers
// (big gaps, concentration breaches, key-level crossings, Top-3 changes) to
// Telegram, reusing telegram.ts dedupe so it can run frequently without spam.
import { runIntradayAlerts } from "@/lib/intraday-alerts";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
    const result = await runIntradayAlerts();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to run intraday alerts",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
