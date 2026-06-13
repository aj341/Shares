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
