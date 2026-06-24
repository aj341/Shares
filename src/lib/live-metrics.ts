import "server-only";
import {
  getFinancials,
  getKeyStats,
  getPriceTargets,
  getStockHistory,
  isMboumConfigured,
} from "@/lib/mboum";
import { getEarningsSurprise } from "@/lib/earnings";
import { getValuationContext } from "@/lib/valuation";
import { getRevisionTrend } from "@/lib/revisions";
import { METRIC_DEFS } from "@/lib/mock-data";
import type { Metric, StatusTone } from "@/lib/types";

/**
 * Computes the 20 scoring metrics from REAL data (Mboum candles + modules +
 * live news sentiment) instead of curated mock statuses. Descriptions are
 * reused from METRIC_DEFS so the contract/UI is unchanged — only the statuses
 * and values become data-driven. Returns null when there isn't enough history
 * (caller falls back to mock), and caches results briefly per ticker.
 */

type Cell = [string | number, StatusTone];

// [score] Name of the position-size row — kept display-only (additive) so it
// never feeds the risk sub-score; the Rule-4 cap in scoring.ts owns sizing.
export const POSITION_SIZE_METRIC = "Position size vs 35% cap";

const CACHE = new Map<string, { metrics: Metric[]; ts: number }>();
const TTL_MS = 10 * 60 * 1000;

// QQQ benchmark closes, fetched once and cached in-module (same TTL pattern
// as the per-ticker metrics cache) so every holding shares one benchmark call.
let QQQ_CACHE: { closes: number[]; ts: number } | null = null;

async function getQqqCloses(): Promise<number[]> {
  if (QQQ_CACHE && Date.now() - QQQ_CACHE.ts < TTL_MS) return QQQ_CACHE.closes;
  const candles = await getStockHistory("QQQ", { interval: "1d", monthsBack: 13 });
  // [score] adjClose for split/dividend-consistent relative strength.
  const closes = candles.map((c) => c.adjClose);
  if (closes.length > 0) QQQ_CACHE = { closes, ts: Date.now() };
  return closes;
}

// --- TA helpers -------------------------------------------------------------

function sma(a: number[], p: number): number | null {
  if (a.length < p) return null;
  return a.slice(-p).reduce((x, y) => x + y, 0) / p;
}

function emaSeries(a: number[], p: number): number[] {
  const k = 2 / (p + 1);
  const out: number[] = [];
  let prev = a[0] ?? 0;
  a.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function rsi(a: number[], p = 14): number | null {
  if (a.length < p + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / p;
  let al = loss / p;
  for (let i = p + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  if (al === 0) return 100;
  return Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
}

function annualisedVol(closes: number[], n = 30): number | null {
  if (closes.length < n + 1) return null;
  const win = closes.slice(-(n + 1));
  const rets: number[] = [];
  for (let i = 1; i < win.length; i++) rets.push(win[i] / win[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0] ?? 0;
  let mdd = 0;
  for (const v of closes) {
    if (v > peak) peak = v;
    const dd = v / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

// --- main -------------------------------------------------------------------

export async function computeLiveMetrics(
  ticker: string,
  newsImpacts: number[] = []
): Promise<Metric[] | null> {
  if (!isMboumConfigured()) return null;

  const cached = CACHE.get(ticker);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.metrics;

  const [candles, targets, stats, fin, earnings, valCtx, revision, qqqCloses] = await Promise.all([
    getStockHistory(ticker, { interval: "1d", monthsBack: 13 }),
    getPriceTargets(ticker),
    getKeyStats(ticker),
    getFinancials(ticker),
    getEarningsSurprise(ticker),
    getValuationContext(ticker),
    getRevisionTrend(ticker),
    getQqqCloses(),
  ]);

  const closes = candles.map((c) => c.close);
  // [score] standardise relative-strength math on adjusted closes (matches
  // factors.ts / relative-strength.ts which use adjClose) so the RS-vs-QQQ
  // comparison is split/dividend-consistent across both code paths.
  const adjCloses = candles.map((c) => c.adjClose);
  const volumes = candles.map((c) => c.volume);
  if (closes.length < 50) return null; // not enough history → caller uses mock

  const price = closes[closes.length - 1];
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const rsiVal = rsi(closes, 14);
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => e12[i] - e26[i]);
  const macdSignal = emaSeries(macdLine, 9);
  const macd = macdLine[macdLine.length - 1] - macdSignal[macdSignal.length - 1];
  const vol30 = sma(volumes, 30);
  const lastVol = volumes[volumes.length - 1];
  const high52 = stats?.week52High ?? Math.max(...closes);
  const low52 = stats?.week52Low ?? Math.min(...closes);
  const range52 = high52 - low52 || 1;
  const pos52 = (price - low52) / range52;
  const ret10 = closes.length > 11 ? price / closes[closes.length - 11] - 1 : 0;
  const vol = annualisedVol(closes, 30);
  const mdd = maxDrawdown(closes.slice(-126));
  const upside = targets?.upsidePct ?? null;
  const pe = stats?.peRatio ?? null;
  const revGrowth = fin?.revenueGrowth ?? null;
  const opMargin = fin?.operatingMargin ?? null;
  const cash = fin?.totalCash ?? null;
  const debt = fin?.totalDebt ?? null;
  const newsNet = newsImpacts.reduce((a, b) => a + b, 0);

  // Relative strength vs QQQ over ~3 months (63 trading days).
  const REL_LOOKBACK = 63;
  let relDiff: number | null = null;
  if (adjCloses.length > REL_LOOKBACK && qqqCloses.length > REL_LOOKBACK) {
    const aFrom = adjCloses[adjCloses.length - 1 - REL_LOOKBACK];
    const aTo = adjCloses[adjCloses.length - 1];
    const qFrom = qqqCloses[qqqCloses.length - 1 - REL_LOOKBACK];
    const qTo = qqqCloses[qqqCloses.length - 1];
    if (aFrom > 0 && qFrom > 0) {
      const stockRet = aTo / aFrom - 1;
      const qqqRet = qTo / qFrom - 1;
      relDiff = stockRet - qqqRet;
    }
  }

  // Volume trend: 20d average volume vs 60d average volume.
  const vol20 = sma(volumes, 20);
  const vol60 = sma(volumes, 60);
  const volRatio = vol20 != null && vol60 != null && vol60 > 0 ? vol20 / vol60 : null;

  // [score] Relative Volume (RVOL): latest bar's volume vs the recent average
  // (20-bar). On a daily series this is "today's volume vs the 20d average".
  const lastVolume = volumes[volumes.length - 1];
  const rvol =
    vol20 != null && vol20 > 0 && Number.isFinite(lastVolume)
      ? lastVolume / vol20
      : null;

  // [score] Liquidity gate: today's dollar volume vs its ~20d average dollar
  // volume. Dollar volume = price * share volume, which captures tradability
  // better than share count alone. Null-safe across the whole series.
  const dollarVols = candles.map((c) => c.close * c.volume);
  const avgDollarVol = sma(dollarVols, 20);
  const lastDollarVol = dollarVols[dollarVols.length - 1];
  const liqRatio =
    avgDollarVol != null && avgDollarVol > 0 && Number.isFinite(lastDollarVol)
      ? lastDollarVol / avgDollarVol
      : null;

  const tri = (x: number, lo: number, hi: number): StatusTone =>
    x >= hi ? "positive" : x <= lo ? "negative" : "neutral";

  const cells: Cell[] = [
    // 0 — relative strength vs QQQ (3-month return differential)
    relDiff != null
      ? [
          `${pct(relDiff)} vs QQQ`,
          relDiff > 0.02 ? "positive" : relDiff < -0.02 ? "negative" : "neutral",
        ]
      : ["—", "neutral"],
    // 1 — volume trend: 20d avg vol vs 60d, confirmed by price vs 20d MA
    volRatio != null && ma20 != null
      ? [
          `${volRatio.toFixed(1)}× avg vol`,
          volRatio > 1.15 ? (price >= ma20 ? "positive" : "negative") : "neutral",
        ]
      : ["—", "neutral"],
    // 2 — price vs 52w range
    [
      pos52 >= 0.66 ? "Upper third" : pos52 <= 0.33 ? "Lower third" : "Mid-range",
      pos52 >= 0.66 ? "positive" : pos52 <= 0.33 ? "negative" : "neutral",
    ],
    // 3 — trend health
    ma20 != null && ma50 != null && ma200 != null
      ? price > ma20 && ma20 > ma50 && ma50 > ma200
        ? ["Higher highs", "positive"]
        : price < ma20 && ma20 < ma50
          ? ["Lower highs", "negative"]
          : ["Choppy", "neutral"]
      : ["—", "neutral"],
    // 4 — RSI(14)
    rsiVal != null
      ? [rsiVal, rsiVal > 75 || rsiVal < 30 ? "negative" : rsiVal >= 45 && rsiVal <= 70 ? "positive" : "neutral"]
      : ["—", "neutral"],
    // 5 — MACD (with NEUTRAL band: a flat tape scores 0.5, not 0/1)
    // [score] normalise the histogram by price so the dead-zone is comparable
    // across names; |hist| < 0.1% of price => flat => neutral.
    (() => {
      const flatBand = price > 0 ? price * 0.001 : 0;
      if (Math.abs(macd) <= flatBand) return ["Flat / no cross", "neutral"] as Cell;
      return macd > 0
        ? (["Bullish cross", "positive"] as Cell)
        : (["Bearish cross", "negative"] as Cell);
    })(),
    // 6 — volume vs 30d avg
    vol30 && lastVol
      ? [`${(lastVol / vol30).toFixed(1)}x avg`, tri(lastVol / vol30, 0.85, 1.15)]
      : ["—", "neutral"],
    // 7 — short-term return
    [pct(ret10), tri(ret10, -0.02, 0.02)],
    // 8 — relative volume (RVOL): latest bar volume vs 20-bar avg
    rvol != null
      ? [`${rvol.toFixed(1)}× RVOL`, rvol >= 1.5 ? "positive" : rvol < 0.7 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 9 — analyst target upside
    upside != null
      ? [pct(upside / 100), upside >= 8 ? "positive" : upside < 0 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 10 — valuation band vs peers/history (live PEG/PE)
    valCtx
      ? valCtx.band
      : pe != null
        ? [`P/E ${pe.toFixed(1)}`, pe < 25 ? "positive" : pe > 45 ? "negative" : "neutral"]
        : ["—", "neutral"],
    // 11 — earnings surprise trend (live Finnhub actual vs estimate) [fundamental]
    earnings != null ? [earnings.value, earnings.status] : ["n/a", "neutral"],
    // 12 — multiple expansion/compression (forward vs trailing P/E)
    valCtx ? valCtx.multiple : ["Stable", "neutral"],
    // 13 — revenue growth trend
    revGrowth != null
      ? [pct(revGrowth), revGrowth >= 0.1 ? "positive" : revGrowth < 0 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 14 — margin trend (level proxy)
    opMargin != null
      ? [pct(opMargin), opMargin >= 0.2 ? "positive" : opMargin < 0.05 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 15 — balance sheet / solvency
    cash != null && debt != null
      ? cash >= debt
        ? ["Net cash", "positive"]
        : debt > cash * 2
          ? ["Levered", "negative"]
          : ["Manageable", "neutral"]
      : ["—", "neutral"],
    // 16 — realised volatility
    vol != null
      ? [`${(vol * 100).toFixed(0)}%`, vol < 0.35 ? "positive" : vol > 0.6 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 17 — drawdown behaviour
    [`${(mdd * 100).toFixed(0)}%`, mdd > -0.15 ? "positive" : mdd < -0.35 ? "negative" : "neutral"],
    // 18 — position size (display-only; overwritten with live weight in
    // portfolio.ts and flagged additive so it never feeds the score — the
    // Rule-4 position cap in scoring.ts is the single owner of sizing effect).
    ["—", "neutral"],
    // 19 — liquidity gate: today's dollar volume vs ~20d avg dollar volume
    liqRatio != null
      ? [
          `${liqRatio.toFixed(1)}× $vol`,
          liqRatio >= 0.8 ? "positive" : liqRatio < 0.4 ? "negative" : "neutral",
        ]
      : ["—", "neutral"],
    // 20 — news / announcement sentiment
    [
      newsNet > 0 ? "Positive" : newsNet < 0 ? "Negative" : "Balanced",
      newsNet > 0 ? "positive" : newsNet < 0 ? "negative" : "neutral",
    ],
    // 21 — analyst revision momentum (Mboum recommendation-trend delta; the
    // single score-feeding analyst-revision signal. The forward-EPS estimate
    // revision in earnings-signals.ts is a distinct DISPLAY-ONLY overlay.)
    revision != null
      ? [
          revision.label,
          revision.direction === "upgrading"
            ? "positive"
            : revision.direction === "downgrading"
              ? "negative"
              : "neutral",
        ]
      : upside != null
        ? [upside >= 10 ? "Upward" : upside < 0 ? "Downward" : "Stable", upside >= 10 ? "positive" : upside < 0 ? "negative" : "neutral"]
        : ["—", "neutral"],
  ];

  const metrics: Metric[] = METRIC_DEFS.map((def, i) => {
    const [value, status] = cells[i] ?? ["—", "neutral"];
    return {
      name: def.name,
      value,
      category: def.category,
      status,
      description: def.desc[status],
      // [score] Position-size is display-only: the Rule-4 cap in scoring.ts is
      // the single owner of position-size effect (no double-count).
      ...(def.name === POSITION_SIZE_METRIC ? { additive: true as const } : {}),
    };
  });

  CACHE.set(ticker, { metrics, ts: Date.now() });
  return metrics;
}
