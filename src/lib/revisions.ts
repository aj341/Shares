import "server-only";
import { mboumFetch } from "@/lib/mboum";

/**
 * Analyst-revision momentum tracking.
 *
 * Mboum's `recommendation-trend` module returns `body.trend`, an array of
 * monthly snapshots of analyst rating counts keyed by `period`
 * ("0m" = current month, "-1m" = prior month, "-2m", "-3m", ...). Each entry
 * has the shape { period, strongBuy, buy, hold, sell, strongSell }.
 *
 * We compare the net-bullish score of the current month against the prior
 * month to surface whether analysts are, on aggregate, upgrading or
 * downgrading their stance — a leading indicator distinct from a static
 * consensus snapshot.
 */

type TrendPeriod = {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
};

type RecommendationTrendBody = {
  trend?: TrendPeriod[];
};

export type RevisionTrend = {
  direction: "upgrading" | "stable" | "downgrading";
  netNowVsPrior: number;
  label: string;
};

/** Net bullish score: (strongBuy + buy) - (sell + strongSell). Hold is neutral. */
function netBullish(t: TrendPeriod): number {
  return t.strongBuy + t.buy - (t.sell + t.strongSell);
}

export async function getRevisionTrend(ticker: string): Promise<RevisionTrend | null> {
  let body: RecommendationTrendBody | null = null;
  try {
    const res = await mboumFetch<{ body?: RecommendationTrendBody }>(
      "/markets/stock/modules",
      { ticker, module: "recommendation-trend" },
      60 * 60 * 6
    );
    body = res?.body ?? null;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[revisions] request failed:", (err as Error).message);
    }
    return null;
  }

  const trend = body?.trend;
  if (!trend || trend.length === 0) return null;

  const cur = trend.find((t) => t.period === "0m");
  const prior = trend.find((t) => t.period === "-1m");
  if (!cur || !prior) return null;

  const delta = netBullish(cur) - netBullish(prior);
  const direction: RevisionTrend["direction"] =
    delta > 0 ? "upgrading" : delta < 0 ? "downgrading" : "stable";

  const label =
    direction === "upgrading"
      ? `Upward (+${delta})`
      : direction === "downgrading"
        ? `Downward (${delta})`
        : "Stable";

  return { direction, netNowVsPrior: delta, label };
}
