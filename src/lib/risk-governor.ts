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

const TARGET_VOL = 0.15; // 15% annualised target — the "comfort" level

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

  const suggestedExposurePct =
    realizedVol && realizedVol > 0
      ? Math.round(Math.max(0, Math.min(1.2, TARGET_VOL / realizedVol)) * 100)
      : null;

  const ratio =
    realizedVol && baselineVol && baselineVol > 0 ? realizedVol / baselineVol : 1;
  const dd = drawdownPct ?? 0;
  let level: RiskLevel = "calm";
  if (ratio >= 1.5 || dd >= 10) level = "high";
  else if (ratio >= 1.15 || dd >= 5) level = "elevated";

  const tgt = Math.round(TARGET_VOL * 100);
  let plainNote: string;
  if (level === "high") {
    plainNote =
      `Your book is swinging hard right now` +
      (dd >= 10 ? ` and sits ${Math.round(dd)}% below its recent high` : "") +
      ` — you're carrying more risk than your ${tgt}% comfort level` +
      (suggestedExposurePct != null
        ? `; easing toward ~${suggestedExposurePct}% invested would bring it back in line.`
        : ".");
  } else if (level === "elevated") {
    plainNote =
      `A bit choppier than usual — risk is running a little above your ${tgt}% comfort level` +
      (suggestedExposurePct != null
        ? `; ~${suggestedExposurePct}% invested would match it.`
        : ".");
  } else {
    plainNote = `Calm — your book's swings are within your usual ${tgt}% comfort level. Nothing to act on.`;
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
