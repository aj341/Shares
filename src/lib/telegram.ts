import "server-only";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";
import type { PortfolioAlert } from "@/lib/types";

/**
 * Telegram delivery for near-real-time alerts. Sends to every chat id in
 * TELEGRAM_CHAT_IDS via the Bot API. A small dedupe table stops the same alert
 * being re-sent while its condition persists (state alerts dedupe by ticker+kind;
 * event alerts dedupe by exact message). Opt-in via TELEGRAM_BOT_TOKEN.
 *
 * Secrets (bot token) are read from env only — never logged or committed.
 */

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export function telegramChatIds(): string[] {
  return (process.env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const SEVERITY_EMOJI: Record<PortfolioAlert["severity"], string> = {
  critical: "🔴",
  warning: "🟠",
  info: "🔵",
};

// [alerttier] Critical-vs-noise routing. CRITICAL alerts (risk breaker / vol,
// hard catalysts on holdings, stop/target breaches, signal flips on holdings)
// are keyed by their EXACT event (kind+ticker+message) so a genuinely new event
// passes immediately, but the SAME critical is not re-sent every cron tick.
// NORMAL alerts (rsi, near-cap, watchlist entries, etc.) collapse to one per
// ticker per window. [dedupefix] Previously criticals bypassed the store
// entirely, so repeating news headlines spammed every 15 min.
const NORMAL_COOLDOWN_MINUTES = 60;
const CRITICAL_COOLDOWN_MINUTES = 360;
function cooldownMinutesFor(a: PortfolioAlert): number {
  return alertTier(a) === "critical"
    ? CRITICAL_COOLDOWN_MINUTES
    : NORMAL_COOLDOWN_MINUTES;
}

function alertTier(a: PortfolioAlert): "critical" | "normal" {
  if (a.severity === "critical") return "critical";
  if (
    a.kind === "signal_change" ||
    a.kind === "high_impact_news" ||
    a.kind === "earnings_imminent"
  )
    return "critical";
  return "normal";
}

// Critical: keyed by the exact event so every distinct critical passes.
// Normal: keyed by ticker so a noisy name collapses to one alert per window.
function cooldownKey(a: PortfolioAlert): string {
  return alertTier(a) === "critical"
    ? `crit:${a.kind}:${a.ticker}:${a.message}`
    : `norm:${a.ticker}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Dedupe store (Postgres when configured, else in-memory) ---------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telegram_sent_alerts (
  alert_key TEXT PRIMARY KEY,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

const memorySent = new Map<string, number>(); // key -> epoch ms (fallback)

/**
 * [dedupefix] Throttle EVERY alert by its cooldown key. Criticals are keyed by
 * exact event (kind+ticker+message) with a long window, so a genuinely new
 * event still passes immediately while an unchanged critical stops re-sending
 * every cron tick. Normals collapse per-ticker on a short window.
 */
async function filterUnsent(alerts: PortfolioAlert[]): Promise<PortfolioAlert[]> {
  if (alerts.length === 0) return [];
  const now = Date.now();
  const keyed = alerts.map((a) => ({
    a,
    key: cooldownKey(a),
    windowMs: cooldownMinutesFor(a) * 60_000,
  }));

  if (!isDatabaseConfigured()) {
    return keyed
      .filter(({ key, windowMs }) => {
        const last = memorySent.get(key);
        return last == null || last < now - windowMs;
      })
      .map(({ a }) => a);
  }

  await ensureSchema();
  const maxWindow = Math.max(NORMAL_COOLDOWN_MINUTES, CRITICAL_COOLDOWN_MINUTES);
  const rows = await query<{ alert_key: string; sent_at: string | Date }>(
    `SELECT alert_key, sent_at FROM telegram_sent_alerts
      WHERE sent_at > NOW() - INTERVAL '${maxWindow} minutes'`
  );
  const lastByKey = new Map(
    rows.map((r) => [r.alert_key, new Date(r.sent_at).getTime()])
  );
  return keyed
    .filter(({ key, windowMs }) => {
      const last = lastByKey.get(key);
      return last == null || last < now - windowMs;
    })
    .map(({ a }) => a);
}

/** Record alerts as sent (upsert sent_at = now). [dedupefix] Track ALL tiers. */
async function recordSent(alerts: PortfolioAlert[]): Promise<void> {
  const keys = alerts.map(cooldownKey);
  if (keys.length === 0) return;
  if (!isDatabaseConfigured()) {
    const now = Date.now();
    for (const k of keys) memorySent.set(k, now);
    return;
  }
  await ensureSchema();
  for (const k of keys) {
    await query(
      `INSERT INTO telegram_sent_alerts (alert_key, sent_at)
       VALUES ($1, NOW())
       ON CONFLICT (alert_key) DO UPDATE SET sent_at = NOW()`,
      [k]
    );
  }
}

// --- Sending ---------------------------------------------------------------

async function sendToChat(token: string, chatId: string, html: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Send arbitrary text to all configured chats (e.g. a test message). */
export async function sendTelegramMessage(
  text: string
): Promise<{ sent: boolean; reason?: string; recipients: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { sent: false, reason: "TELEGRAM_BOT_TOKEN not configured", recipients: 0 };
  const chats = telegramChatIds();
  if (chats.length === 0) return { sent: false, reason: "no TELEGRAM_CHAT_IDS configured", recipients: 0 };

  const results = await Promise.all(chats.map((c) => sendToChat(token, c, text)));
  const ok = results.filter(Boolean).length;
  return { sent: ok > 0, recipients: ok };
}

/** Format + send only the alerts not already delivered. Records what it sends. */
export async function sendAlertTelegram(
  alerts: PortfolioAlert[]
): Promise<{ sent: boolean; reason?: string; new: number; recipients: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { sent: false, reason: "TELEGRAM_BOT_TOKEN not configured", new: 0, recipients: 0 };
  const chats = telegramChatIds();
  if (chats.length === 0) return { sent: false, reason: "no TELEGRAM_CHAT_IDS configured", new: 0, recipients: 0 };

  const fresh = await filterUnsent(alerts);
  if (fresh.length === 0) return { sent: false, reason: "no new alerts", new: 0, recipients: 0 };

  // Severity order: critical → warning → info.
  const order = { critical: 0, warning: 1, info: 2 } as const;
  fresh.sort((a, b) => order[a.severity] - order[b.severity]);

  const lines = fresh.map(
    (a) => `${SEVERITY_EMOJI[a.severity]} <b>${escapeHtml(a.ticker)}</b> — ${escapeHtml(a.message)}`
  );
  const html = `📈 <b>Shares alert</b>\n\n${lines.join("\n")}`;

  const results = await Promise.all(chats.map((c) => sendToChat(token, c, html)));
  const recipients = results.filter(Boolean).length;
  if (recipients > 0) await recordSent(fresh);

  return { sent: recipients > 0, new: fresh.length, recipients };
}
