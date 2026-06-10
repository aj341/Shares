import "server-only";
import { buildPortfolio } from "@/lib/portfolio";
import { ensureSnapshotSchema } from "@/lib/backtest";
import { buildWatchlist } from "@/lib/watchlist";
import { getUpcomingEvents } from "@/lib/events";
import { getHistoricalEarningsMoves } from "@/lib/earnings-risk";
import { getImpliedMove } from "@/lib/tradier";
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
const EARNINGS_ALERT_DAYS = 7;

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
  const [portfolio, priorSignals, watchlist] = await Promise.all([
    buildPortfolio(),
    getPriorSignals(),
    buildWatchlist().catch(() => null),
  ]);
  const events = await getUpcomingEvents(
    portfolio.holdings.map((h) => h.ticker)
  ).catch(() => []);

  // Nearest upcoming earnings per ticker (days away).
  const nextEarnings = new Map<string, { daysAway: number; detail: string }>();
  for (const e of events) {
    if (e.type !== "earnings") continue;
    const prev = nextEarnings.get(e.ticker);
    if (!prev || e.daysAway < prev.daysAway) {
      nextEarnings.set(e.ticker, { daysAway: e.daysAway, detail: e.detail });
    }
  }

  const alerts: PortfolioAlert[] = [];

  for (const holding of portfolio.holdings) {
    // SAFETY: degraded (mock-fallback) data must not fire signal/price alerts.
    // High-impact news still passes — headlines are real regardless of quotes.
    const degraded = holding.dataQuality === "degraded";

    // 1. Signal change vs the previous snapshot (only when we have history).
    const prior = priorSignals.get(holding.ticker);
    if (!degraded && prior && prior !== holding.signal) {
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
    const rsi = degraded ? null : readRsi(holding);
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

    // 4. Earnings imminent — anticipate the binary event instead of reacting.
    //    Real calendar data, so it fires even for degraded holdings.
    const earnings = nextEarnings.get(holding.ticker);
    if (earnings && earnings.daysAway <= EARNINGS_ALERT_DAYS) {
      const valueAud = holding.marketValue * portfolio.fxUsdToAud;
      const when =
        earnings.daysAway <= 0
          ? "today"
          : earnings.daysAway === 1
          ? "tomorrow"
          : `in ${earnings.daysAway} days`;

      // Historical event-risk: avg post-earnings move x position size.
      // Only fetched for holdings inside the alert window (right here), and
      // the alert still fires unchanged when history is unavailable.
      let risk = "";
      const moveStats = await getHistoricalEarningsMoves(holding.ticker).catch(
        () => null
      );
      if (moveStats) {
        const riskAud =
          (moveStats.avgAbsMovePct / 100) * valueAud;
        risk = ` Historically moves ±${moveStats.avgAbsMovePct.toFixed(1)}% on earnings (last ${moveStats.samples} prints) — that's ±A$${Math.round(riskAud).toLocaleString("en-AU")} at current size.`;
      }

      // Forward-looking: options-implied move for the expiry spanning the
      // print (Tradier; null when unconfigured — alert fires regardless).
      const printDate = new Date(Date.now() + earnings.daysAway * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const implied = await getImpliedMove(holding.ticker, printDate).catch(
        () => null
      );
      if (implied != null) {
        const impliedAud = (implied / 100) * valueAud;
        risk += ` Options currently imply ±${implied.toFixed(1)}% (±A$${Math.round(impliedAud).toLocaleString("en-AU")}).`;
      }

      alerts.push({
        ticker: holding.ticker,
        kind: "earnings_imminent",
        message: `${holding.ticker} reports earnings ${when} (${earnings.detail}). Position is ${holding.portfolioWeight.toFixed(1)}% of the book (≈A$${Math.round(valueAud).toLocaleString("en-AU")}).${risk}`,
        severity: earnings.daysAway <= 2 ? "warning" : "info",
      });
    }

    // 5. Position near / over the concentration cap (weight uses the live
    //    price, so skip when degraded).
    if (!degraded && holding.portfolioWeight >= POSITION_CAP_PCT) {
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

  // 5. Watchlist entry triggers — candidates sitting in the "best entry" bucket
  //    (e.g. pulled back / near oversold) are worth a look.
  for (const item of watchlist?.items ?? []) {
    if (item.bucket === "best_entry") {
      alerts.push({
        ticker: item.ticker,
        kind: "watchlist_entry",
        message: `${item.ticker} (watchlist) in entry zone — ${item.signalLabel}${
          item.rsi != null ? `, RSI ${item.rsi}` : ""
        }${item.upsidePct != null ? `, ${Math.round(item.upsidePct)}% upside` : ""}.`,
        severity: "info",
      });
    }
  }

  return alerts;
}
