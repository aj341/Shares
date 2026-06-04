import { NextRequest, NextResponse } from "next/server";
import { appendTransaction } from "@/lib/portfolio-store";
import { derive } from "@/lib/portfolio-derivation";
import {
  buildCashAdjustment,
  ValidationError,
  type CashAdjustmentInput,
} from "@/lib/transactions";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Apply a manual cash deposit/withdrawal (signed amount). */
export async function POST(req: NextRequest) {
  try {
    const input = (await req.json()) as CashAdjustmentInput;
    const tx = buildCashAdjustment(input);
    const next = await appendTransaction(tx);
    const { cash } = derive(next);
    return NextResponse.json({ ok: true, transaction: tx, currentCash: cash });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message } satisfies ApiError, {
        status: 400,
      });
    }
    const body: ApiError = {
      error: "Failed to adjust cash",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
