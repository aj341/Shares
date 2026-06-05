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

/** Re-send a persistent alert at most once per this window. */
const DEDUPE_HOURS = 18;

/** State alerts dedupe by condition; event alerts dedupe by exact text. */
function alertKey(a: PortfolioAlert): string {
  const stateKinds = new Set(["rsi_extreme", "near_cap", "watchlist_entry"]);
  return stateKinds.has(a.kind)
    ? `${a.kind}:${a.ticker}`
    : `${a.kind}:${a.ticker}:${a.message}`;
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

/** Keep only alerts not already sent within the dedupe window. */
async function filterUnsent(alerts: PortfolioAlert[]): Promise<PortfolioAlert[]> {
  if (alerts.length === 0) return [];
  const keyed = alerts.map((a) => ({ a, key: alertKey(a) }));

  if (!isDatabaseConfigured()) {
    const now = Date.now();
    const cutoff = now - DEDUPE_HOURS * 3_600_000;
    return keyed
      .filter(({ key }) => {
        const last = memorySent.get(key);
        return last == null || last < cutoff;
      })
      .map(({ a }) => a);
  }

  await ensureSchema();
  const rows = await query<{ alert_key: string }>(
    `SELECT alert_key FROM telegram_sent_alerts
      WHERE sent_at > NOW() - INTERVAL '${DEDUPE_HOURS} hours'`
  );
  const recent = new Set(rows.map((r) => r.alert_key));
  return keyed.filter(({ key }) => !recent.has(key)).map(({ a }) => a);
}

/** Record alerts as sent (upsert sent_at = now). */
async function recordSent(alerts: PortfolioAlert[]): Promise<void> {
  const keys = alerts.map(alertKey);
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
