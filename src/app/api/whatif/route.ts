import { NextResponse } from "next/server";
import { buildWhatIf } from "@/lib/whatif";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * [whatif] Sell-decision counterfactual — "what if I hadn't sold?" (ADDITIVE,
 * read-only).
 *
 * For every SELL / TRIM row in the portfolio_transactions ledger, computes what
 * NOT selling would be worth now (decisionPnl = soldShares x (sellPrice -
 * currentPrice)), a daily counterfactual curve from the sell date to now, a
 * per-sell verdict (good call / sold too early / neutral), and an aggregate of
 * total decision P&L + a hit rate. Live price from Finnhub, daily closes from
 * Mboum; null-safe when either is missing. Never mutates anything and never
 * touches the scoring / redistribution engines.
 */
export async function GET() {
  try {
    const whatif = await buildWhatIf();
    return NextResponse.json({
      ...whatif,
      methodology: {
        decisionPnl:
          "decisionPnl = soldShares x (sellPrice - currentPrice), USD. " +
          "Positive => price fell after the sale (GOOD call: selling banked " +
          "value you'd have lost). Negative => price rose (sold too early).",
        decisionPnlPct:
          "Decision P&L as a % of the sell proceeds (soldShares x sellPrice).",
        series:
          "Daily counterfactual value soldShares x close[t] from the sell date " +
          "to the latest Mboum bar, vs the realised-at-sale value " +
          "soldShares x sellPrice. best/worst/current mark how the decision " +
          "aged (max gain, max cost, latest).",
        verdict:
          "good when decisionPnl% > +0.25%, early when < -0.25%, else neutral " +
          "(a wash). unknown when there is no current price.",
        aggregate:
          "totalDecisionPnl = sum over priced sells. hitRate = good / " +
          "(good + early); neutral decisions are excluded from the denominator.",
        sellVsTrim:
          "Full SELL (position -> 0) and TRIM (partial, residual remains) are " +
          "both SELL rows in the ledger; classified per-row by residual shares.",
        limitations:
          "Daily closes only (no intraday path); current price is a single " +
          "live quote, so the verdict is as-of-now and will move with the " +
          "market; sells with no live price are listed but excluded from the " +
          "aggregate; ignores fees, taxes, dividends and any redeployment of " +
          "the sale proceeds (it answers strictly 'had I kept these shares').",
      },
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build sell-decision counterfactual",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
