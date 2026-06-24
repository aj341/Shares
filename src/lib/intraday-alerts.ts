import "server-only";

// [wfa] LATENCY-AWARE INTRADAY ALERTS.
// ---------------------------------------------------------------------------
// A fast, high-priority intraday alert pass over HELD + WATCHLIST names. It is
// separate from the existing daily `computeAlerts` (src/lib/alerts.ts): that
// one is a broad end-of-cycle digest; this one is meant to run FREQUENTLY in
// market hours and only fire on things that can't wait — a Top-3 reshuffle, a
// concentration breach, a big intraday gap, or a price crossing a key level
// (MA20 / MA50 / 52-week high/low) when intraday/technical data is present.
//
// It emits the shared `PortfolioAlert` shape and pushes through the SAME
// telegram.ts pipeline (sendAlertTelegram) so it inherits the existing dedupe
// (state alerts dedupe by ticker+kind, event alerts by exact text) and never
// spams. Top-3 membership changes are additionally deduped against a tiny
// persisted "last top-3" set so an unchanged leaderboard stays silent.
//
// ADDITIVE + null-safe: no scoring/redistribution change. Missing keys/data ->
// returns an empty alert list (and the cron route is a 200 no-op). Never throws.

import { buildPortfolio } from "@/lib/portfolio";
import { buildWatchlist } from "@/lib/watchlist";
import { buildTopMovesData } from "@/lib/dashboard";
import { buildStocksTechnicals } from "@/lib/technicals";
import { assessConcentration } from "@/lib/concentration";
import { CONCENTRATION_LIMITS } from "@/lib/constants";
import { sendAlertTelegram } from "@/lib/telegram";
import { getPool, isDatabaseConfigured } from "@/lib/db";
import type {
  Holding,
  PortfolioAlert,
  StockTechnicals,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Thresholds (local, labelled).
// ---------------------------------------------------------------------------

/** |dayChangePct| above this is a "big gap/move" worth an intraday ping. */
const GAP_PCT_THRESHOLD = 4;
/** How near a key level (MA20/MA50/52w) counts as "crossing" (% of price). */
const LEVEL_PROXIMITY_PCT = 0.75;
/** Cap how many watchlist names we pull technicals for (bounds latency/cost). */
const MAX_WATCHLIST_TECH = 12;

// Reuse the kinds already declared on PortfolioAlert so telegram.ts dedupe
// treats them correctly. `near_cap` is a STATE alert (dedupes by ticker+kind);
// `signal_change` and `high_impact_news` are EVENT alerts (dedupe by message).
// We map intraday triggers onto these existing kinds rather than widening the
// shared union (keeps the [wfa] edit to shared files minimal).

// ---------------------------------------------------------------------------
// Top-3 membership persistence (tiny key/value, DB when configured).
// ---------------------------------------------------------------------------

let memTop3: string[] | null = null; // in-memory fallback
let schemaReady: Promise<void> | null = null;

function ensureTop3Schema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS intraday_top3_state (
           id        BOOLEAN PRIMARY KEY DEFAULT TRUE,
           tickers   TEXT NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           CONSTRAINT intraday_top3_singleton CHECK (id)
         )`
      )
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

async function readLastTop3(): Promise<string[]> {
  if (!isDatabaseConfigured()) return memTop3 ?? [];
  try {
    await ensureTop3Schema();
    const { rows } = await getPool().query<{ tickers: string }>(
      "SELECT tickers FROM intraday_top3_state WHERE id = TRUE"
    );
    if (rows.length === 0) return [];
    return rows[0].tickers.split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return memTop3 ?? [];
  }
}

async function writeLastTop3(tickers: string[]): Promise<void> {
  memTop3 = tickers;
  if (!isDatabaseConfigured()) return;
  try {
    await ensureTop3Schema();
    await getPool().query(
      `INSERT INTO intraday_top3_state (id, tickers, updated_at)
       VALUES (TRUE, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET tickers = $1, updated_at = NOW()`,
      [tickers.join(",")]
    );
  } catch {
    /* memory copy already set */
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function readRsi(h: Holding): number | null {
  const m = h.metrics.find((x) => x.name === "RSI(14)");
  if (!m) return null;
  const n = typeof m.value === "number" ? m.value : Number(m.value);
  return Number.isFinite(n) ? n : null;
}

/** Nearest key level a price is within LEVEL_PROXIMITY_PCT of (or just crossed). */
function keyLevelCross(
  price: number,
  tech: StockTechnicals | undefined
): { label: string; level: number } | null {
  if (!tech || !(price > 0)) return null;
  const candidates: Array<{ label: string; level: number | null }> = [
    { label: "MA20", level: tech.ma20 },
    { label: "MA50", level: tech.ma50 },
    { label: "52w high", level: tech.week52High },
    { label: "52w low", level: tech.week52Low },
  ];
  let best: { label: string; level: number } | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c.level == null || !(c.level > 0)) continue;
    const distPct = Math.abs(price / c.level - 1) * 100;
    if (distPct <= LEVEL_PROXIMITY_PCT && distPct < bestDist) {
      bestDist = distPct;
      best = { label: c.label, level: c.level };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Core: computeIntradayAlerts (impure: reads live data; null-safe; no throw).
// ---------------------------------------------------------------------------

export type IntradayAlertsResult = {
  alerts: PortfolioAlert[];
  /** Current Top-3 tickers (so the cron route can echo state for debugging). */
  top3: string[];
  /** Top-3 names that newly ENTERED vs the last persisted set. */
  top3Entered: string[];
  hasData: boolean;
};

export async function computeIntradayAlerts(): Promise<IntradayAlertsResult> {
  const empty: IntradayAlertsResult = {
    alerts: [],
    top3: [],
    top3Entered: [],
    hasData: false,
  };

  const portfolio = await buildPortfolio().catch(() => null);
  if (!portfolio) return empty;

  const [watchlist, topMoves] = await Promise.all([
    buildWatchlist().catch(() => null),
    buildTopMovesData().catch(() => null),
  ]);

  const alerts: PortfolioAlert[] = [];

  // --- 1. Big intraday gap/move on a HELD name (skip degraded data). --------
  for (const h of portfolio.holdings) {
    if (h.dataQuality === "degraded") continue;
    if (Math.abs(h.dayChangePct) >= GAP_PCT_THRESHOLD) {
      const up = h.dayChangePct >= 0;
      const sess =
        h.session && h.session !== "regular" ? ` (${h.session}-market)` : "";
      alerts.push({
        ticker: h.ticker,
        kind: "high_impact_news", // event alert -> dedupes by exact message
        message: `${h.ticker} ${up ? "+" : ""}${h.dayChangePct.toFixed(
          1
        )}% intraday${sess} — ${h.portfolioWeight.toFixed(1)}% of the book.`,
        severity: Math.abs(h.dayChangePct) >= GAP_PCT_THRESHOLD * 2 ? "critical" : "warning",
      });
    }
  }

  // --- 2. Concentration breaches (state alert -> dedupes by ticker+kind). ---
  const equity = portfolio.holdings.reduce((s, h) => s + h.marketValue, 0);
  const conc = assessConcentration(
    portfolio.holdings,
    CONCENTRATION_LIMITS,
    equity
  );
  for (const a of conc.assessments) {
    if (a.status !== "BREACH") continue;
    alerts.push({
      ticker: a.subject ?? portfolio.holdings[0]?.ticker ?? "BOOK",
      kind: "near_cap",
      message: `Concentration breach — ${a.message}`,
      severity: "critical",
    });
  }

  // --- 3. Key-level crossings on HELD + a bounded slice of WATCHLIST names. --
  const watchTickers = (watchlist?.items ?? [])
    .map((w) => w.ticker)
    .slice(0, MAX_WATCHLIST_TECH);
  const techTickers = [
    ...new Set([...portfolio.holdings.map((h) => h.ticker), ...watchTickers]),
  ];
  const tech = await buildStocksTechnicals(techTickers).catch(
    () => ({} as Record<string, StockTechnicals>)
  );

  for (const h of portfolio.holdings) {
    if (h.dataQuality === "degraded") continue;
    const cross = keyLevelCross(h.currentPrice, tech[h.ticker]);
    if (cross) {
      alerts.push({
        ticker: h.ticker,
        kind: "high_impact_news",
        message: `${h.ticker} testing ${cross.label} ($${cross.level.toFixed(
          2
        )}) at $${h.currentPrice.toFixed(2)}.`,
        severity: "info",
      });
    }
  }
  for (const item of watchlist?.items ?? []) {
    if (item.price == null) continue;
    const cross = keyLevelCross(item.price, tech[item.ticker]);
    if (cross) {
      alerts.push({
        ticker: item.ticker,
        kind: "watchlist_entry",
        message: `${item.ticker} (watchlist) testing ${cross.label} ($${cross.level.toFixed(
          2
        )}) at $${item.price.toFixed(2)}.`,
        severity: "info",
      });
    }
  }

  // --- 4. Top-3 membership change (deduped against the persisted last set). --
  const top3 = (topMoves?.moves ?? []).map((m) => m.ticker);
  const lastTop3 = await readLastTop3();
  const lastSet = new Set(lastTop3);
  const top3Entered = top3.filter((t) => !lastSet.has(t));

  // Only emit when there's a real change AND we had a prior set to compare to
  // (avoids a spurious alert on the very first run / empty state).
  if (lastTop3.length > 0 && top3Entered.length > 0) {
    for (const move of topMoves?.moves ?? []) {
      if (!top3Entered.includes(move.ticker)) continue;
      alerts.push({
        ticker: move.ticker,
        kind: "signal_change", // event alert -> dedupes by exact message
        message: `${move.ticker} entered Top-3 (${move.action}) — ${move.whyNow}`,
        severity: move.action === "SELL" ? "critical" : "warning",
      });
    }
  }
  // Persist the current leaderboard for the next run's comparison.
  if (top3.length > 0) await writeLastTop3(top3);

  return {
    alerts,
    top3,
    top3Entered,
    hasData: alerts.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Send pipeline: compute -> Telegram (inherits telegram.ts dedupe).
// ---------------------------------------------------------------------------

export type IntradayAlertsSendResult = {
  computed: number;
  top3: string[];
  top3Entered: string[];
  sent: boolean;
  reason?: string;
  new: number;
  recipients: number;
};

/**
 * Compute intraday alerts and push the not-already-sent ones to Telegram. The
 * dedupe in telegram.ts stops repeats while a condition persists, so this can
 * run every few minutes without spamming. null-safe: no alerts / no Telegram
 * config -> a benign result, never a throw.
 */
export async function runIntradayAlerts(): Promise<IntradayAlertsSendResult> {
  const { alerts, top3, top3Entered } = await computeIntradayAlerts();
  const res = await sendAlertTelegram(alerts);
  return {
    computed: alerts.length,
    top3,
    top3Entered,
    sent: res.sent,
    reason: res.reason,
    new: res.new,
    recipients: res.recipients,
  };
}
