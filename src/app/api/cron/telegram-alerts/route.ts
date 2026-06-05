import { NextRequest, NextResponse } from "next/server";
import { computeAlerts } from "@/lib/alerts";
import { sendAlertTelegram, sendTelegramMessage } from "@/lib/telegram";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Near-real-time Telegram alerts. Intended to run frequently during market
 * hours; only newly-triggered alerts are sent (dedupe lives in telegram.ts).
 * Guarded by CRON_SECRET. `?test=1` sends a one-off test message instead.
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
    if (req.nextUrl.searchParams.get("test") === "1") {
      const result = await sendTelegramMessage(
        "✅ Shares dashboard is connected. You'll get alerts here."
      );
      return NextResponse.json({ ok: true, test: true, ...result });
    }

    const alerts = await computeAlerts();
    const result = await sendAlertTelegram(alerts);
    return NextResponse.json({ ok: true, computed: alerts.length, ...result });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to send Telegram alerts",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
