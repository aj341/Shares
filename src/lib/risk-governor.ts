import "server-only";
// [riskgov] Risk Governor — MONITOR + ALERT ONLY (per AJ: no fixed loss level,
// no gating, no auto-trim). Reads the portfolio equity curve (performance.ts)
// and reports volatility vs a target, drawdown from peak, today's move, and a
// volatility-target *suggestion* for exposure. Pure guidance; never blocks a buy.
import { buildPerformance } from "@/lib/performance";

export type RiskLevel = "calm" | "elevated" | "high";

export type RiskStatus = {
  level: RiskLevel;
  realizedVolPct: number | null; // ~20-day annualised vol of the book
  baselineVolPct: number | null; // full-window annualised vol (the "usual")
  drawdownPct: number | null; // % below the recent equity peak
  dayPnlPct: number | null; // today's move
  suggestedExposurePct: number | null; // vol-target guidance (target/realised)
  plainNote: string; // one plain-English sentence, no jargon
  asOf: string;
};

// Target = the book's OWN recent-normal volatility, not an arbitrary number.
// A high-octane growth book naturally runs hot; the governor flags when risk
// rises ABOVE that personal norm, and the exposure suggestion dials back toward
// it — never toward some generic target that would nag a daily trader forever.

function annualisedVol(rets: number[]): number | null {
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

export async function getRiskStatus(): Promise<RiskStatus> {
  const asOf = new Date().toISOString();
  const warming: RiskStatus = {
    level: "calm",
    realizedVolPct: null,
    baselineVolPct: null,
    drawdownPct: null,
    dayPnlPct: null,
    suggestedExposurePct: null,
    plainNote: "Still gathering enough history to gauge your risk — monitoring quietly.",
    asOf,
  };

  let perf;
  try {
    perf = await buildPerformance("3M");
  } catch {
    return warming;
  }
  const values = (perf.seriesValue ?? [])
    .map((p) => p.Portfolio)
    .filter((v): v is number => Number.isFinite(v) && v > 0);
  if (values.length < 10) return warming;

  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));

  const realizedVol = annualisedVol(rets.slice(-20));
  const baselineVol = annualisedVol(rets);
  const peak = Math.max(...values);
  const cur = values[values.length - 1];
  const drawdownPct = peak > 0 ? ((peak - cur) / peak) * 100 : null;
  const dayPnlPct = perf.pnlByPeriod?.daily?.pct ?? null;

  // Vol-target vs your OWN baseline: at-normal => ~100% (stay), spiking => trim.
  const suggestedExposurePct =
    realizedVol && realizedVol > 0 && baselineVol
      ? Math.round(Math.max(0, Math.min(1.2, baselineVol / realizedVol)) * 100)
      : null;

  const ratio =
    realizedVol && baselineVol && baselineVol > 0 ? realizedVol / baselineVol : 1;
  const dd = drawdownPct ?? 0;
  let level: RiskLevel = "calm";
  if (ratio >= 1.5 || dd >= 10) level = "high";
  else if (ratio >= 1.15 || dd >= 5) level = "elevated";

  const now = realizedVol != null ? Math.round(realizedVol * 100) : null;
  const usual = baselineVol != null ? Math.round(baselineVol * 100) : null;
  const swings = now != null ? `~${now}%` : "your recent swings";
  const norm = usual != null ? `your usual ~${usual}%` : "your norm";
  let plainNote: string;
  if (level === "high") {
    plainNote =
      `Your book is unusually volatile right now` +
      (dd >= 10 ? ` and is ${Math.round(dd)}% below its recent high` : "") +
      ` — swings (${swings}) are well above ${norm}` +
      (suggestedExposurePct != null
        ? `. Easing toward ~${suggestedExposurePct}% invested would dial risk back to your normal.`
        : ".");
  } else if (level === "elevated") {
    plainNote =
      `Running hotter than usual — swings (${swings}) are above ${norm}` +
      (dd >= 5 ? `, and you're ${Math.round(dd)}% off the recent high` : "") +
      (suggestedExposurePct != null
        ? `. Trimming toward ~${suggestedExposurePct}% invested would bring it back to normal.`
        : ".");
  } else {
    plainNote = `Risk is about normal — swings (${swings}) are in line with ${norm}. Nothing unusual to act on.`;
  }

  return {
    level,
    realizedVolPct: realizedVol != null ? Math.round(realizedVol * 100) : null,
    baselineVolPct: baselineVol != null ? Math.round(baselineVol * 100) : null,
    drawdownPct: drawdownPct != null ? Math.round(drawdownPct * 10) / 10 : null,
    dayPnlPct,
    suggestedExposurePct,
    plainNote,
    asOf,
  };
}
