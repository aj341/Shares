import { NextResponse } from "next/server";
import { fetchFlexStatement, isIbkrConfigured } from "@/lib/ibkr";
import { getFxRates } from "@/lib/fx";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Realized P&L straight from IBKR's FIFO books (Flex statement period —
 * the query is configured for the last 30 days). Per-symbol totals with the
 * short/long-term split (long-term = held >12 months, CGT-discount relevant)
 * plus an AUD grand total. Stocks only; commissions included by IBKR.
 */
export async function GET() {
  if (!isIbkrConfigured()) {
    return NextResponse.json({ items: [], totalRealizedAud: null, hasData: false });
  }
  try {
    const [statement, fx] = await Promise.all([fetchFlexStatement(), getFxRates()]);

    // Currency per symbol comes from the trades section (performance rows
    // don't carry one); default USD for US stocks.
    const ccyBySymbol = new Map<string, string>();
    for (const t of statement.trades) {
      if (!ccyBySymbol.has(t.symbol)) ccyBySymbol.set(t.symbol, t.currency);
    }

    const items = statement.performance
      .filter(
        (p) =>
          p.assetCategory === "STK" &&
          p.realizedTotal != null &&
          p.realizedTotal !== 0
      )
      .map((p) => {
        const currency = ccyBySymbol.get(p.symbol) ?? "USD";
        const factor = fx.toAud[currency] ?? fx.usdToAud;
        return {
          symbol: p.symbol,
          currency,
          realized: p.realizedTotal as number,
          realizedShortTerm: p.realizedShortTerm,
          realizedLongTerm: p.realizedLongTerm,
          realizedAud: Math.round((p.realizedTotal as number) * factor * 100) / 100,
        };
      })
      .sort((a, b) => b.realizedAud - a.realizedAud);

    const totalRealizedAud =
      Math.round(items.reduce((s, i) => s + i.realizedAud, 0) * 100) / 100;

    return NextResponse.json({
      items,
      totalRealizedAud,
      hasData: items.length > 0,
      whenGenerated: statement.whenGenerated,
    });
  } catch (err) {
    const body: ApiError = {
      error: "Failed to read realized P&L",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
