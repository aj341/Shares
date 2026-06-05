import { NextRequest, NextResponse } from "next/server";
import { computeAlerts } from "@/lib/alerts";
import { sendAlertEmail } from "@/lib/email";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Compute current portfolio alerts and email a digest to the configured
 * recipients. Intended for a daily Railway cron. Guarded by CRON_SECRET.
 * No-op (but 200) when there are no alerts or RESEND_API_KEY is unset.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const provided =
      req.nextUrl.searchParams.get("secret") || req.headers.get("x-cron-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
    }
  }
  try {
    const alerts = await computeAlerts();
    const result = await sendAlertEmail(alerts);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to send alert email",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
