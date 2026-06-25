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
// are ALWAYS delivered — the upstream computation is edge-triggered (only emits
// on a real change), so this never spams. NORMAL alerts (rsi, near-cap,
// watchlist entries, etc.) are throttled to one per ticker per cooldown window.
const COOLDOWN_MINUTES = 60;

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

/** [alerttier] Critical always passes; normal throttled by a per-ticker cooldown. */
async function filterUnsent(alerts: PortfolioAlert[]): Promise<PortfolioAlert[]> {
  if (alerts.length === 0) return [];
  const critical = alerts.filter((a) => alertTier(a) === "critical");
  const normal = alerts.filter((a) => alertTier(a) === "normal");
  if (normal.length === 0) return critical;

  const keyed = normal.map((a) => ({ a, key: cooldownKey(a) }));

  if (!isDatabaseConfigured()) {
    const cutoff = Date.now() - COOLDOWN_MINUTES * 60_000;
    const fresh = keyed
      .filter(({ key }) => {
        const last = memorySent.get(key);
        return last == null || last < cutoff;
      })
      .map(({ a }) => a);
    return [...critical, ...fresh];
  }

  await ensureSchema();
  const rows = await query<{ alert_key: string }>(
    `SELECT alert_key FROM telegram_sent_alerts
      WHERE sent_at > NOW() - INTERVAL '${COOLDOWN_MINUTES} minutes'`
  );
  const recent = new Set(rows.map((r) => r.alert_key));
  const fresh = keyed.filter(({ key }) => !recent.has(key)).map(({ a }) => a);
  return [...critical, ...fresh];
}

/** Record alerts as sent (upsert sent_at = now). */
async function recordSent(alerts: PortfolioAlert[]): Promise<void> {
  // Only NORMAL alerts need cooldown tracking — criticals always pass.
  const keys = alerts.filter((a) => alertTier(a) === "normal").map(cooldownKey);
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
