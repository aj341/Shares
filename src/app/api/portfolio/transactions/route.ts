import { NextRequest, NextResponse } from "next/server";
import { appendTransaction, readPortfolio } from "@/lib/portfolio-store";
import { derive, sharesOwned } from "@/lib/portfolio-derivation";
import { buildTransaction, ValidationError, type TradeInput } from "@/lib/transactions";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** List the full transaction ledger (newest first). */
export async function GET() {
  try {
    const state = await readPortfolio();
    const transactions = [...state.transactions].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1
    );
    return NextResponse.json({ transactions });
  } catch (err) {
    return fail("Failed to list transactions", err);
  }
}

/** Record a BUY / SELL / ADJUSTMENT transaction. */
export async function POST(req: NextRequest) {
  try {
    const input = (await req.json()) as TradeInput;

    // Validate sells against current holdings before mutating.
    if (input.tradeType === "SELL") {
      const state = await readPortfolio();
      const owned = sharesOwned(state, input.ticker?.trim().toUpperCase() ?? "");
      if (input.shares > owned) {
        const body: ApiError = {
          error: "Sell quantity exceeds shares owned",
          detail: `You own ${owned} shares of ${input.ticker}.`,
        };
        return NextResponse.json(body, { status: 400 });
      }
    }

    const tx = buildTransaction(input);
    const next = await appendTransaction(tx);
    const { positions, cash } = derive(next);
    return NextResponse.json({ ok: true, transaction: tx, currentCash: cash, positions });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message } satisfies ApiError, {
        status: 400,
      });
    }
    return fail("Failed to record transaction", err);
  }
}

function fail(error: string, err: unknown) {
  const body: ApiError = { error, detail: (err as Error).message };
  return NextResponse.json(body, { status: 500 });
}
