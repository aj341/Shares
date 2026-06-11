import { NextRequest, NextResponse } from "next/server";
import { buildBrief } from "@/lib/brief";
import { buildDashboard } from "@/lib/dashboard";
import { sendTelegramMessage } from "@/lib/telegram";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const STANCE_EMOJI: Record<string, string> = {
  "risk-on": "🟢",
  neutral: "⚪",
  mixed: "🟡",
  "risk-off": "🔴",
};

/**
 * Evening briefing to Telegram (8:30pm AEST cron — after the 8pm data
 * refresh, ahead of the 11:30pm AEST US open): stance, watch items,
 * catalysts, live book numbers and the current trade plan.
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
    const [brief, dash] = await Promise.all([buildBrief(), buildDashboard()]);
    const k = dash.kpis;

    const lines: string[] = [];
    lines.push(
      `📋 <b>Evening Brief</b> — ${STANCE_EMOJI[brief.stance] ?? ""} ${esc(
        brief.stance.replace("-", " ").toUpperCase()
      )}`
    );
    lines.push(esc(brief.headline));
    lines.push("");
    lines.push(esc(brief.summary));

    if (brief.watchItems.length > 0) {
      lines.push("");
      lines.push("<b>Watch tonight:</b>");
      for (const w of brief.watchItems.slice(0, 5)) {
        const flag = w.urgency === "high" ? "🔴" : w.urgency === "medium" ? "🟠" : "🔵";
        lines.push(`${flag} <b>${esc(w.ticker)}</b> — ${esc(w.note)}`);
      }
    }

    const recs = dash.tradeRecommendations;
    if (recs.length > 0) {
      lines.push("");
      lines.push("<b>Current plan (engine, not advice):</b>");
      for (const r of recs.slice(0, 6)) {
        lines.push(
          `• ${esc(r.action)} ${esc(r.ticker)} ×${r.shares} @ $${r.estimatedPrice}`
        );
      }
    }

    if (brief.catalysts.length > 0) {
      lines.push("");
      lines.push("<b>Catalysts:</b>");
      for (const c of brief.catalysts.slice(0, 5)) {
        const when = c.daysAway <= 0 ? "today" : c.daysAway === 1 ? "tomorrow" : `${c.daysAway}d`;
        lines.push(`📅 ${esc(c.ticker)} ${esc(c.detail)} — ${when}`);
      }
    }

    lines.push("");
    lines.push(
      `💼 A$${Math.round(k.totalPortfolioValue).toLocaleString("en-AU")} | cash A$${Math.round(
        k.currentCash
      ).toLocaleString("en-AU")} | unrealised ${k.totalUnrealisedPnl >= 0 ? "+" : ""}A$${Math.round(
        k.totalUnrealisedPnl
      ).toLocaleString("en-AU")}`
    );
    lines.push("<i>Not financial advice.</i>");

    const result = await sendTelegramMessage(lines.join("\n"));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to send daily brief",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
