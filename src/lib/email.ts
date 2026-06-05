import "server-only";
import type { PortfolioAlert } from "@/lib/types";

/**
 * Email alert delivery via Resend (https://resend.com).
 *
 * Active only when RESEND_API_KEY is set. The key + sender are read server-side
 * and never exposed. Recipients default to the three configured addresses but
 * can be overridden with ALERT_RECIPIENTS (comma-separated). The sender domain
 * must be verified in Resend (set ALERT_EMAIL_FROM, e.g. "Shares Alerts
 * <alerts@designbees.com.au>").
 */

const DEFAULT_RECIPIENTS = [
  "aj@designbees.com.au",
  "aj@commercialgrowth.com.au",
  "kavanaghmarilyn70@gmail.com",
];

const DASHBOARD_URL =
  process.env.DASHBOARD_URL?.trim() ||
  "https://web-production-ddb43.up.railway.app";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

function recipients(): string[] {
  const env = process.env.ALERT_RECIPIENTS?.trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_RECIPIENTS;
}

const SEV_ORDER: Record<PortfolioAlert["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
const SEV_COLOR: Record<PortfolioAlert["severity"], string> = {
  critical: "#dc4040",
  warning: "#d68a1f",
  info: "#6b7785",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

function buildHtml(alerts: PortfolioAlert[], dateStr: string): string {
  const sorted = [...alerts].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const rows = sorted
    .map(
      (a) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap;font-weight:600">${esc(a.ticker)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:${SEV_COLOR[a.severity]};text-transform:uppercase;font-size:11px">${a.severity}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#333">${esc(a.message)}</td>
      </tr>`
    )
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:620px;margin:0 auto;padding:24px">
    <h1 style="font-size:18px;margin:0 0 4px">AJ's Portfolio — ${alerts.length} alert${alerts.length === 1 ? "" : "s"}</h1>
    <p style="color:#6b7785;font-size:13px;margin:0 0 16px">${esc(dateStr)} · Not financial advice</p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:14px">
      ${rows}
    </table>
    <p style="margin:18px 0 0"><a href="${DASHBOARD_URL}" style="background:#2b9eff;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;display:inline-block">Open dashboard</a></p>
  </div></body></html>`;
}

export type EmailResult = { sent: boolean; reason?: string; count: number };

export async function sendAlertEmail(alerts: PortfolioAlert[]): Promise<EmailResult> {
  if (alerts.length === 0) return { sent: false, reason: "no alerts", count: 0 };
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return { sent: false, reason: "RESEND_API_KEY not configured", count: alerts.length };

  const from =
    process.env.ALERT_EMAIL_FROM?.trim() || "Shares Alerts <alerts@designbees.com.au>";
  const dateStr = new Date().toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        from,
        to: recipients(),
        subject: `Shares — ${alerts.length} portfolio alert${alerts.length === 1 ? "" : "s"} (${dateStr})`,
        html: buildHtml(alerts, dateStr),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, reason: `Resend ${res.status}: ${detail.slice(0, 200)}`, count: alerts.length };
    }
    return { sent: true, count: alerts.length };
  } catch (err) {
    return { sent: false, reason: (err as Error).message, count: alerts.length };
  }
}
