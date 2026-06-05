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

const CACHE = new Map<string, { metrics: Metric[]; ts: number }>();
const TTL_MS = 10 * 60 * 1000;

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

  const [candles, targets, stats, fin, earnings, valCtx] = await Promise.all([
    getStockHistory(ticker, { interval: "1d", monthsBack: 13 }),
    getPriceTargets(ticker),
    getKeyStats(ticker),
    getFinancials(ticker),
    getEarningsSurprise(ticker),
    getValuationContext(ticker),
  ]);

  const closes = candles.map((c) => c.close);
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

  const tri = (x: number, lo: number, hi: number): StatusTone =>
    x >= hi ? "positive" : x <= lo ? "negative" : "neutral";

  const cells: Cell[] = [
    // 0 — 20d vs 50d MA
    ma20 != null && ma50 != null
      ? [pct(ma20 / ma50 - 1), tri(ma20 / ma50 - 1, -0.005, 0.005)]
      : ["—", "neutral"],
    // 1 — 50d vs 200d MA
    ma50 != null && ma200 != null
      ? [
          ma50 >= ma200 ? "Golden-cross" : "Death-cross",
          ma50 >= ma200 ? "positive" : "negative",
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
    // 5 — MACD
    [macd >= 0 ? "Bullish cross" : "Bearish cross", macd >= 0 ? "positive" : "negative"],
    // 6 — volume vs 30d avg
    vol30 && lastVol
      ? [`${(lastVol / vol30).toFixed(1)}x avg`, tri(lastVol / vol30, 0.85, 1.15)]
      : ["—", "neutral"],
    // 7 — short-term return
    [pct(ret10), tri(ret10, -0.02, 0.02)],
    // 8 — analyst target upside
    upside != null
      ? [pct(upside / 100), upside >= 8 ? "positive" : upside < 0 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 9 — valuation band vs peers/history (live PEG/PE)
    valCtx
      ? valCtx.band
      : pe != null
        ? [`P/E ${pe.toFixed(1)}`, pe < 25 ? "positive" : pe > 45 ? "negative" : "neutral"]
        : ["—", "neutral"],
    // 10 — earnings surprise trend (live Finnhub actual vs estimate)
    earnings != null ? [earnings.value, earnings.status] : ["n/a", "neutral"],
    // 11 — multiple expansion/compression (forward vs trailing P/E)
    valCtx ? valCtx.multiple : ["Stable", "neutral"],
    // 12 — revenue growth trend
    revGrowth != null
      ? [pct(revGrowth), revGrowth >= 0.1 ? "positive" : revGrowth < 0 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 13 — margin trend (level proxy)
    opMargin != null
      ? [pct(opMargin), opMargin >= 0.2 ? "positive" : opMargin < 0.05 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 14 — balance sheet / solvency
    cash != null && debt != null
      ? cash >= debt
        ? ["Net cash", "positive"]
        : debt > cash * 2
          ? ["Levered", "negative"]
          : ["Manageable", "neutral"]
      : ["—", "neutral"],
    // 15 — realised volatility
    vol != null
      ? [`${(vol * 100).toFixed(0)}%`, vol < 0.35 ? "positive" : vol > 0.6 ? "negative" : "neutral"]
      : ["—", "neutral"],
    // 16 — drawdown behaviour
    [`${(mdd * 100).toFixed(0)}%`, mdd > -0.15 ? "positive" : mdd < -0.35 ? "negative" : "neutral"],
    // 17 — position size (placeholder; overwritten with live weight in portfolio.ts)
    ["—", "neutral"],
    // 18 — news / announcement sentiment
    [
      newsNet > 0 ? "Positive" : newsNet < 0 ? "Negative" : "Balanced",
      newsNet > 0 ? "positive" : newsNet < 0 ? "negative" : "neutral",
    ],
    // 19 — analyst revision / target proxy
    upside != null
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
    };
  });

  CACHE.set(ticker, { metrics, ts: Date.now() });
  return metrics;
}
