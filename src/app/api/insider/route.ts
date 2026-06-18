import { NextResponse } from "next/server";
import {
  getInsiderOverlays,
  INSIDER_CLUSTER_WINDOW_DAYS,
  INSIDER_MIN_TXN_USD,
  INSIDER_CLUSTER_MIN_BUYERS,
  INSIDER_BIG_BOSS_BUY_USD,
  INSIDER_NOTABLE_BUY_USD,
  INSIDER_NOTABLE_SELL_USD,
  INSIDER_LOOKBACK_DAYS,
  type InsiderOverlay,
} from "@/lib/insider";
import { buildPortfolio } from "@/lib/portfolio";
import { buildWatchlist } from "@/lib/watchlist";
import { isMboumConfigured } from "@/lib/mboum";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export type InsiderResponse = {
  /** Overlay per ticker (already filtered to open-market signals). */
  byTicker: Record<string, InsiderOverlay>;
  /** Tickers with a buy signal, strongest first (cluster > notable). */
  clusterBuys: string[];
  /** The exact filter thresholds in effect (for the panel footnote). */
  thresholds: {
    clusterWindowDays: number;
    minTxnUsd: number;
    clusterMinBuyers: number;
    bigBossBuyUsd: number;
    notableBuyUsd: number;
    notableSellUsd: number;
    lookbackDays: number;
  };
  asOf: string;
  source: "mboum" | "none";
};

/**
 * Insider cluster-buy overlay. SLOW fundamental signal (6h cached upstream).
 *
 * Tickers come from the live book + watchlist by default; pass `?tickers=A,B`
 * to scope it. Returns "none" everywhere when Mboum is unconfigured.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const param = url.searchParams.get("tickers");
    const asOf = new Date().toISOString();

    if (!isMboumConfigured()) {
      const body: InsiderResponse = {
        byTicker: {},
        clusterBuys: [],
        thresholds: thresholds(),
        asOf,
        source: "none",
      };
      return NextResponse.json(body);
    }

    let tickers: string[];
    if (param) {
      tickers = param.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    } else {
      const [portfolio, watch] = await Promise.all([
        buildPortfolio().catch(() => null),
        buildWatchlist().catch(() => null),
      ]);
      tickers = [
        ...(portfolio?.holdings.map((h) => h.ticker) ?? []),
        ...(watch?.items.map((i) => i.ticker) ?? []),
      ];
    }

    const byTicker = await getInsiderOverlays(tickers);

    const rank: Record<string, number> = { cluster_buy: 0, notable_buy: 1 };
    const clusterBuys = Object.entries(byTicker)
      .filter(([, o]) => o.signal === "cluster_buy" || o.signal === "notable_buy")
      .sort((a, b) => {
        const r = rank[a[1].signal] - rank[b[1].signal];
        return r !== 0 ? r : b[1].netDollar - a[1].netDollar;
      })
      .map(([t]) => t);

    const body: InsiderResponse = {
      byTicker,
      clusterBuys,
      thresholds: thresholds(),
      asOf,
      source: "mboum",
    };
    return NextResponse.json(body);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build insider overlay",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}

function thresholds(): InsiderResponse["thresholds"] {
  return {
    clusterWindowDays: INSIDER_CLUSTER_WINDOW_DAYS,
    minTxnUsd: INSIDER_MIN_TXN_USD,
    clusterMinBuyers: INSIDER_CLUSTER_MIN_BUYERS,
    bigBossBuyUsd: INSIDER_BIG_BOSS_BUY_USD,
    notableBuyUsd: INSIDER_NOTABLE_BUY_USD,
    notableSellUsd: INSIDER_NOTABLE_SELL_USD,
    lookbackDays: INSIDER_LOOKBACK_DAYS,
  };
}
