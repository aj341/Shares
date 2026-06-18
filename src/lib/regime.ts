import "server-only";
import { getStockHistory, isMboumConfigured } from "@/lib/mboum";
import { PORTFOLIO_RULES } from "@/lib/constants";

/**
 * Market-regime overlay: QQQ vs its 200-day MA (trend) + 20-day realized
 * volatility percentile vs the trailing year (stress). Classifies the tape and
 * feeds the brief's stance + the risk-off gate on NEW positions.
 *
 * Cash buffer is DISABLED (fully-invested policy): all regimes target a 0%
 * buffer, so the redistribution engine deploys all available cash regardless of
 * regime. The regime is still used to (a) suppress new-position entries in
 * risk-off and (b) colour the brief's stance.
 */

export type MarketRegime = {
  regime: "risk_on" | "caution" | "risk_off";
  label: string;
  targetCashBufferPct: number;
  qqqVs200dmaPct: number | null;
  volPercentile: number | null;
  asOf: string;
};

// Fully-invested policy: no cash buffer in any regime. (Regime still gates
// new positions in risk-off and sets the brief's stance.)
const BUFFERS: Record<MarketRegime["regime"], number> = {
  risk_on: PORTFOLIO_RULES.targetCashBufferPct, // 0
  caution: 0,
  risk_off: 0,
};

const VOL_STRESS_PCTILE = 70;
const TTL_MS = 30 * 60 * 1000;
let cache: { at: number; value: MarketRegime } | null = null;

function fallback(): MarketRegime {
  return {
    regime: "risk_on",
    label: "Risk-on (no benchmark data — using base buffer)",
    targetCashBufferPct: BUFFERS.risk_on,
    qqqVs200dmaPct: null,
    volPercentile: null,
    asOf: new Date().toISOString(),
  };
}

/** Rolling 20-day annualised volatility series from daily closes. */
function rollingVol(closes: number[], window = 20): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const out: number[] = [];
  for (let i = window; i <= rets.length; i++) {
    const slice = rets.slice(i - window, i);
    const mean = slice.reduce((s, r) => s + r, 0) / window;
    const variance = slice.reduce((s, r) => s + (r - mean) ** 2, 0) / (window - 1);
    out.push(Math.sqrt(variance) * Math.sqrt(252));
  }
  return out;
}

export async function getMarketRegime(): Promise<MarketRegime> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  if (!isMboumConfigured()) return fallback();

  const candles = await getStockHistory("QQQ", { monthsBack: 13 }).catch(() => []);
  if (candles.length < 210) return fallback();

  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const ma200 = closes.slice(-200).reduce((s, c) => s + c, 0) / 200;
  const vsMa = ((last - ma200) / ma200) * 100;

  const vols = rollingVol(closes);
  const current = vols[vols.length - 1];
  const pct =
    (vols.filter((v) => v <= current).length / vols.length) * 100;

  const uptrend = vsMa >= 0;
  const calm = pct < VOL_STRESS_PCTILE;
  const regime: MarketRegime["regime"] =
    uptrend && calm ? "risk_on" : !uptrend && !calm ? "risk_off" : "caution";

  const labels: Record<MarketRegime["regime"], string> = {
    risk_on: "Risk-on — QQQ above its 200-day average with calm volatility",
    caution: uptrend
      ? "Caution — uptrend intact but volatility is elevated"
      : "Caution — QQQ below its 200-day average",
    risk_off: "Risk-off — QQQ in a downtrend with stressed volatility",
  };

  const value: MarketRegime = {
    regime,
    label: labels[regime],
    targetCashBufferPct: BUFFERS[regime],
    qqqVs200dmaPct: Math.round(vsMa * 10) / 10,
    volPercentile: Math.round(pct),
    asOf: new Date().toISOString(),
  };
  cache = { at: now, value };
  return value;
}

// ===========================================================================
// [regime] Additive market-regime / breadth ASSESSMENT layer.
//
// This block is purely additive: it does NOT touch `getMarketRegime` /
// `MarketRegime` above (still consumed by dashboard/brief/redistribution) and
// does NOT change any score or Signal math. It surfaces a richer, UI-facing
// `RegimeAssessment` — overall posture from QQQ + SPY vs their 50d/200d MAs and
// a realized-vol trend, plus cross-sector breadth (% of sector ETFs above their
// 50d MA) and leading/lagging sectors by relative strength.
//
// History is fetched via the shared, per-build cached `getBenchmarkCloses`
// (src/lib/relative-strength.ts) so QQQ/SPY/each sector ETF is pulled at most
// once. The sector-ETF set is the single source of truth in src/lib/sectors.ts
// (ETF_BY_SECTOR). Everything is null-safe and degrades to a neutral, clearly
// labelled assessment when data is missing.
// ===========================================================================

import { getBenchmarkCloses } from "@/lib/relative-strength";
import { ETF_BY_SECTOR } from "@/lib/sectors";

/** UI-facing tri-state posture (independent of the internal "caution" enum). */
export type RegimePosture = "risk_on" | "neutral" | "risk_off";

export type SectorStrength = {
  /** Representative sector ETF symbol (e.g. "XLK"). */
  etf: string;
  /** Human sector label(s) this ETF represents (e.g. "Cloud / AI"). */
  label: string;
  /** % the ETF sits above (+) or below (−) its 50d MA. null when short. */
  vs50: number | null;
  /** % above/below its 200d MA. null when short. */
  vs200: number | null;
  /** Trailing ~3M total return (fraction), used for relative strength. */
  ret3m: number | null;
  /** ret3m minus QQQ's ret3m (fraction) — the relative-strength score. */
  rs: number | null;
  /** Whether the ETF is currently above its 50d MA. */
  above50: boolean;
};

export type RegimeAssessment = {
  regime: RegimePosture;
  /** Short human descriptor of the posture. */
  descriptor: string;
  /** QQQ price vs its 50d / 200d MA, in %. null when data missing. */
  qqqVs50: number | null;
  qqqVs200: number | null;
  /** SPY price vs its 50d / 200d MA, in %. null when data missing. */
  spyVs50: number | null;
  spyVs200: number | null;
  /** 20d annualised realized vol (fraction) and whether it is rising. */
  realizedVol: number | null;
  realizedVolRising: boolean | null;
  /** Percentile of current 20d vol vs the trailing year (0–100). */
  realizedVolPctile: number | null;
  /** % of tracked sector ETFs trading above their 50d MA (0–100). */
  breadthPctAbove50: number | null;
  /** Count of sector ETFs we had data for (denominator of breadth). */
  sectorsCovered: number;
  /** Strongest sectors by relative strength vs QQQ (descending). */
  leadingSectors: SectorStrength[];
  /** Weakest sectors by relative strength vs QQQ (ascending). */
  laggingSectors: SectorStrength[];
  asOf: string;
};

const ASSESS_TTL_MS = 30 * 60 * 1000;
let assessCache: { at: number; value: RegimeAssessment } | null = null;

/** Simple moving average of the last `n` closes; null when too short. */
function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((s, c) => s + c, 0) / n;
}

/** Last close vs an n-day MA, as a signed %; null when short. */
function vsMa(closes: number[], n: number): number | null {
  const ma = sma(closes, n);
  if (ma == null || ma <= 0) return null;
  const last = closes[closes.length - 1];
  return ((last - ma) / ma) * 100;
}

/** Distinct sector-ETF set (single source of truth) with grouped labels. */
function sectorEtfUniverse(): Array<{ etf: string; label: string }> {
  const labels = new Map<string, string[]>();
  for (const [sector, etf] of Object.entries(ETF_BY_SECTOR)) {
    const arr = labels.get(etf) ?? [];
    arr.push(sector);
    labels.set(etf, arr);
  }
  return [...labels.entries()].map(([etf, sectors]) => ({
    etf,
    label: sectors.join(" · "),
  }));
}

function neutralFallback(reason: string): RegimeAssessment {
  return {
    regime: "neutral",
    descriptor: `Neutral — ${reason}`,
    qqqVs50: null,
    qqqVs200: null,
    spyVs50: null,
    spyVs200: null,
    realizedVol: null,
    realizedVolRising: null,
    realizedVolPctile: null,
    breadthPctAbove50: null,
    sectorsCovered: 0,
    leadingSectors: [],
    laggingSectors: [],
    asOf: new Date().toISOString(),
  };
}

/**
 * Full market-regime + breadth assessment. Additive, null-safe, cached for
 * 30 minutes. Returns a clearly-labelled neutral fallback when Mboum is
 * unconfigured or index history is too short to judge.
 */
export async function getRegimeAssessment(): Promise<RegimeAssessment> {
  const now = Date.now();
  if (assessCache && now - assessCache.at < ASSESS_TTL_MS) return assessCache.value;
  if (!isMboumConfigured()) return neutralFallback("no benchmark data");

  // Indices first (QQQ leads; SPY confirms). getBenchmarkCloses is cached
  // per-symbol for the build, so QQQ here reuses any earlier fetch.
  const [qqq, spy] = await Promise.all([
    getBenchmarkCloses("QQQ").catch(() => [] as number[]),
    getBenchmarkCloses("SPY").catch(() => [] as number[]),
  ]);

  if (qqq.length < 60) return neutralFallback("insufficient index history");

  const qqqVs50 = round1(vsMa(qqq, 50));
  const qqqVs200 = round1(vsMa(qqq, 200));
  const spyVs50 = round1(vsMa(spy, 50));
  const spyVs200 = round1(vsMa(spy, 200));

  // Realized-volatility trend on QQQ (20d annualised). Rising vol = stress.
  const vols = rollingVol(qqq, 20);
  const realizedVol =
    vols.length > 0 ? round3(vols[vols.length - 1]) : null;
  let realizedVolRising: boolean | null = null;
  let realizedVolPctile: number | null = null;
  if (vols.length >= 6) {
    const cur = vols[vols.length - 1];
    const prior = vols[vols.length - 6]; // ~1 week earlier
    realizedVolRising = cur > prior;
    const yr = vols.slice(-252);
    realizedVolPctile = Math.round(
      (yr.filter((v) => v <= cur).length / yr.length) * 100
    );
  }

  // Breadth + relative strength across the distinct sector ETFs.
  const universe = sectorEtfUniverse();
  const qqqRet3m = trailingRet(qqq, 63);
  const sectors: SectorStrength[] = [];
  await Promise.all(
    universe.map(async ({ etf, label }) => {
      const closes = await getBenchmarkCloses(etf).catch(() => [] as number[]);
      if (closes.length < 50) return; // skip ETFs without enough history
      const v50 = vsMa(closes, 50);
      const ret3m = trailingRet(closes, 63);
      const rs =
        ret3m != null && qqqRet3m != null ? ret3m - qqqRet3m : null;
      sectors.push({
        etf,
        label,
        vs50: round1(v50),
        vs200: round1(vsMa(closes, 200)),
        ret3m: ret3m != null ? round3(ret3m) : null,
        rs: rs != null ? round3(rs) : null,
        above50: (v50 ?? 0) > 0,
      });
    })
  );

  const sectorsCovered = sectors.length;
  const breadthPctAbove50 =
    sectorsCovered > 0
      ? Math.round((sectors.filter((s) => s.above50).length / sectorsCovered) * 100)
      : null;

  const ranked = sectors
    .filter((s) => s.rs != null)
    .sort((a, b) => (b.rs ?? 0) - (a.rs ?? 0));
  const leadingSectors = ranked.slice(0, 3);
  const laggingSectors = ranked.slice(-3).reverse();

  // ---- Posture classification (QQQ trend + SPY confirm + breadth + vol) ----
  // A small score where each positive signal nudges toward risk-on.
  let score = 0;
  if (qqqVs200 != null) score += qqqVs200 > 0 ? 1 : -1;
  if (qqqVs50 != null) score += qqqVs50 > 0 ? 1 : -1;
  if (spyVs200 != null) score += spyVs200 > 0 ? 0.5 : -0.5;
  if (breadthPctAbove50 != null) {
    if (breadthPctAbove50 >= 60) score += 1;
    else if (breadthPctAbove50 <= 40) score -= 1;
  }
  if (realizedVolPctile != null) {
    if (realizedVolPctile >= 80) score -= 1;
    else if (realizedVolPctile <= 40) score += 0.5;
  }
  if (realizedVolRising === true) score -= 0.5;

  const regime: RegimePosture =
    score >= 1.5 ? "risk_on" : score <= -1.5 ? "risk_off" : "neutral";

  const trendWord =
    qqqVs200 != null && qqqVs200 > 0 ? "above" : "below";
  const breadthWord =
    breadthPctAbove50 == null
      ? "mixed breadth"
      : breadthPctAbove50 >= 60
      ? "broad participation"
      : breadthPctAbove50 <= 40
      ? "narrow breadth"
      : "mixed breadth";
  const volWord =
    realizedVolPctile == null
      ? ""
      : realizedVolPctile >= 80
      ? ", stressed volatility"
      : realizedVolPctile <= 40
      ? ", calm volatility"
      : "";

  const descriptors: Record<RegimePosture, string> = {
    risk_on: `Risk-on — QQQ ${trendWord} its 200d MA with ${breadthWord}${volWord}`,
    neutral: `Neutral — QQQ ${trendWord} its 200d MA, ${breadthWord}${volWord}`,
    risk_off: `Risk-off — QQQ ${trendWord} its 200d MA, ${breadthWord}${volWord}`,
  };

  const value: RegimeAssessment = {
    regime,
    descriptor: descriptors[regime],
    qqqVs50,
    qqqVs200,
    spyVs50,
    spyVs200,
    realizedVol,
    realizedVolRising,
    realizedVolPctile,
    breadthPctAbove50,
    sectorsCovered,
    leadingSectors,
    laggingSectors,
    asOf: new Date().toISOString(),
  };
  assessCache = { at: now, value };
  return value;
}

/** Trailing total return over the last `lookback` trading days; null if short. */
function trailingRet(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const from = closes[closes.length - 1 - lookback];
  const to = closes[closes.length - 1];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return (to - from) / from;
}

function round1(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}
function round3(v: number | null): number | null {
  return v == null ? null : Math.round(v * 1000) / 1000;
}
