import "server-only";
import { buildPortfolio } from "@/lib/portfolio";
import { ensureSnapshotSchema } from "@/lib/backtest";
import { isDatabaseConfigured, query } from "@/lib/db";
import type { Holding, PortfolioAlert } from "@/lib/types";

/**
 * Portfolio alerts: derived from the CURRENT portfolio state, optionally compared
 * against the previous score snapshot (when a database is configured).
 *
 * NUMERIC columns come back from pg as STRINGS — numeric reads use Number().
 */

export type { PortfolioAlert };

const POSITION_CAP_PCT = 33;
const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 30;
const NEWS_IMPACT_THRESHOLD = 2;

type PriorSignalRow = { ticker: string; signal: string };

/** Read the numeric RSI(14) value out of a holding's metrics, if present. */
function readRsi(holding: Holding): number | null {
  const metric = holding.metrics.find((m) => m.name === "RSI(14)");
  if (!metric) return null;
  const n = typeof metric.value === "number" ? metric.value : Number(metric.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Most recent recorded signal per ticker, from score_snapshots.
 * Returns an empty map when no DB is configured (signal_change is then skipped).
 */
async function getPriorSignals(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!isDatabaseConfigured()) return map;

  await ensureSnapshotSchema();

  // DISTINCT ON gives the latest row per ticker (ordered by captured_at DESC).
  const rows = await query<PriorSignalRow>(
    `SELECT DISTINCT ON (ticker) ticker, signal
       FROM score_snapshots
      ORDER BY ticker, captured_at DESC`
  );
  for (const row of rows) map.set(row.ticker, row.signal);
  return map;
}

export async function computeAlerts(): Promise<PortfolioAlert[]> {
  const [portfolio, priorSignals] = await Promise.all([
    buildPortfolio(),
    getPriorSignals(),
  ]);

  const alerts: PortfolioAlert[] = [];

  for (const holding of portfolio.holdings) {
    // 1. Signal change vs the previous snapshot (only when we have history).
    const prior = priorSignals.get(holding.ticker);
    if (prior && prior !== holding.signal) {
      alerts.push({
        ticker: holding.ticker,
        kind: "signal_change",
        message: `${holding.ticker} signal changed from ${prior} to ${holding.signal}.`,
        severity: holding.signal === "SELL" || holding.signal === "STRONG_BUY"
          ? "warning"
          : "info",
      });
    }

    // 2. RSI extreme (overbought / oversold).
    const rsi = readRsi(holding);
    if (rsi !== null && (rsi > RSI_OVERBOUGHT || rsi < RSI_OVERSOLD)) {
      const overbought = rsi > RSI_OVERBOUGHT;
      alerts.push({
        ticker: holding.ticker,
        kind: "rsi_extreme",
        message: `${holding.ticker} RSI is ${rsi.toFixed(1)} — ${
          overbought ? "overbought" : "oversold"
        }.`,
        severity: "warning",
      });
    }

    // 3. High-impact news (strongly negative or positive announcement).
    const highImpact = holding.announcements.find(
      (a) => Math.abs(a.impactScore) >= NEWS_IMPACT_THRESHOLD
    );
    if (highImpact) {
      alerts.push({
        ticker: holding.ticker,
        kind: "high_impact_news",
        message: `${holding.ticker}: ${highImpact.title}`,
        severity: highImpact.impactScore <= -NEWS_IMPACT_THRESHOLD ? "critical" : "info",
      });
    }

    // 4. Position near / over the concentration cap.
    if (holding.portfolioWeight >= POSITION_CAP_PCT) {
      alerts.push({
        ticker: holding.ticker,
        kind: "near_cap",
        message: `${holding.ticker} is ${holding.portfolioWeight.toFixed(
          1
        )}% of the portfolio — near/over the ${POSITION_CAP_PCT}% cap.`,
        severity: holding.portfolioWeight >= 35 ? "critical" : "warning",
      });
    }
  }

  return alerts;
}
