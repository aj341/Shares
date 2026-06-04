import { NextRequest, NextResponse } from "next/server";
import {
  appendTransaction,
  readPortfolio,
  setArchived,
} from "@/lib/portfolio-store";
import { derive, sharesOwned } from "@/lib/portfolio-derivation";
import { buildTransaction, ValidationError } from "@/lib/transactions";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

type PatchBody = {
  shares: number;
  avgPrice: number;
  companyName?: string;
  notes?: string;
  tradeDate?: string;
};

/** Manual adjustment of a holding (admin mode → ADJUSTMENT ledger entry). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params;
    const body = (await req.json()) as PatchBody;
    const tx = buildTransaction({
      ticker,
      companyName: body.companyName,
      tradeType: "ADJUSTMENT",
      shares: 0,
      pricePerShare: 0,
      tradeDate: body.tradeDate ?? new Date().toISOString().slice(0, 10),
      notes: body.notes,
      adjustment: { shares: body.shares, avgPrice: body.avgPrice },
    });
    const next = await appendTransaction(tx);
    const { positions, cash } = derive(next);
    return NextResponse.json({ ok: true, transaction: tx, currentCash: cash, positions });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message } satisfies ApiError, {
        status: 400,
      });
    }
    return fail("Failed to adjust holding", err);
  }
}

/** Archive a holding. Only allowed at 0 shares unless ?force=true. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params;
    const t = ticker.toUpperCase();
    const force = req.nextUrl.searchParams.get("force") === "true";
    const state = await readPortfolio();
    const owned = sharesOwned(state, t);
    if (owned > 0 && !force) {
      const body: ApiError = {
        error: "Holding is not fully exited",
        detail: `You still own ${owned} shares of ${t}. Sell to zero or pass force=true.`,
      };
      return NextResponse.json(body, { status: 400 });
    }
    const next = await setArchived(t, true);
    const { positions, cash } = derive(next);
    return NextResponse.json({ ok: true, archived: t, currentCash: cash, positions });
  } catch (err) {
    return fail("Failed to archive holding", err);
  }
}

function fail(error: string, err: unknown) {
  const body: ApiError = { error, detail: (err as Error).message };
  return NextResponse.json(body, { status: 500 });
}
