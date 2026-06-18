import { NextResponse } from "next/server";
import { buildPortfolio } from "@/lib/portfolio";
import { buildWatchlist } from "@/lib/watchlist";
import { buildCatalysts, type CatalystName, type CatalystsResult } from "@/lib/catalysts";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
// Allow time for news fetch + Claude classification across names.
export const maxDuration = 60;

/**
 * GET /api/catalysts
 *
 * Additive endpoint. Pulls recent news for held positions + watchlist names,
 * classifies each via Claude into hard-catalyst buckets, and returns ONLY the
 * hard catalysts (catalystType != none AND materiality high/medium). Held
 * positions rank first. Fully null-safe: empty list when news/Claude/keys are
 * missing — never throws to the client (returns 200 with an empty result).
 *
 * Query: ?days=14 (news lookback), ?maxNames=40 (cost guard).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = clampInt(url.searchParams.get("days"), 14, 1, 30);
  const maxNames = clampInt(url.searchParams.get("maxNames"), 40, 1, 80);

  try {
    const [portfolio, watchlist] = await Promise.all([
      buildPortfolio().catch(() => null),
      buildWatchlist().catch(() => null),
    ]);

    const names: CatalystName[] = [];
    for (const h of portfolio?.holdings ?? []) {
      if (h.ticker) names.push({ ticker: h.ticker, held: true });
    }
    for (const w of watchlist?.items ?? []) {
      if (w.ticker) names.push({ ticker: w.ticker, held: false });
    }

    const result = await buildCatalysts(names, { days, maxNames });
    return NextResponse.json(result);
  } catch (err) {
    // Graceful: surface an empty, well-formed result rather than a 500 so the
    // additive UI panel degrades cleanly.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[api/catalysts] failed:", (err as Error).message);
    }
    const empty: CatalystsResult = {
      catalysts: [],
      asOf: new Date().toISOString(),
      classified: false,
    };
    const _err: ApiError = { error: "catalysts unavailable", detail: (err as Error).message };
    void _err;
    return NextResponse.json(empty);
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
