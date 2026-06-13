import { NextRequest, NextResponse } from "next/server";
import { buildBrief } from "@/lib/brief";
import { buildDashboard } from "@/lib/dashboard";
import { sendTelegramMessage } from "@/lib/telegram";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";
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

// --- Once-per-day send guard -----------------------------------------------
// Lets us schedule the brief at TWO off-peak times for redundancy (GitHub cron
// is best-effort and drops runs) without ever sending twice: the first run that
// succeeds marks the day; the second sees it and skips. Keyed by the AEST-fixed
// (UTC+10) date so it matches the schedule. `?force=1` bypasses it for manual
// test sends and does NOT mark the day, so the real evening send still fires.
const memSent = new Set<string>();

/** Today's date in AEST (UTC+10), as YYYY-MM-DD. */
function briefDateAest(): string {
  return new Date(Date.now() + 10 * 3_600_000).toISOString().slice(0, 10);
}

async function ensureBriefLog(): Promise<void> {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS daily_brief_sent (
       brief_date TEXT PRIMARY KEY,
       sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
}

async function alreadySentToday(date: string): Promise<boolean> {
  if (!isDatabaseConfigured()) return memSent.has(date);
  try {
    await ensureBriefLog();
    const rows = await query<{ brief_date: string }>(
      "SELECT brief_date FROM daily_brief_sent WHERE brief_date = $1",
      [date]
    );
    return rows.length > 0;
  } catch {
    return memSent.has(date); // DB hiccup: fall back, never block wrongly
  }
}

async function markSentToday(date: string): Promise<void> {
  memSent.add(date);
  if (!isDatabaseConfigured()) return;
  try {
    await ensureBriefLog();
    await query(
      "INSERT INTO daily_brief_sent (brief_date) VALUES ($1) ON CONFLICT DO NOTHING",
      [date]
    );
  } catch {
    /* memory copy already set */
  }
}

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
    // `?fresh=1` (the nightly cron) forces a brief rebuild so it reflects the
    // 8pm IBKR realign rather than a cached afternoon view. buildDashboard is
    // always computed fresh. `?force=1` bypasses the once-per-day guard.
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    const force = req.nextUrl.searchParams.get("force") === "1";
    const briefDate = briefDateAest();

    if (!force && (await alreadySentToday(briefDate))) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `Brief already sent for ${briefDate} (AEST).`,
      });
    }

    const [brief, dash] = await Promise.all([
      buildBrief({ force: fresh }),
      buildDashboard(),
    ]);
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
    // Mark the day only for the real (non-forced) evening send, so the
    // redundant cron de-dupes but manual test sends don't suppress it.
    if (result.sent && !force) await markSentToday(briefDate);
    return NextResponse.json({ ok: true, briefDate, ...result });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to send daily brief",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
