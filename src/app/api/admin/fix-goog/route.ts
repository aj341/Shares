import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, isDatabaseConfigured, withTransaction } from "@/lib/db";
import { getDerivedPortfolio } from "@/lib/portfolio-derivation";
import { activeBackend } from "@/lib/portfolio-store";

export const dynamic = "force-dynamic";

/**
 * ONE-TIME ADMIN ROUTE — reclassify the opening Alphabet holding from
 * Class A (GOOGL) to Class C (GOOG).
 *
 * The opening 50 shares were seeded as GOOGL but should have been GOOG. This
 * removes that seed row and re-inserts the 50 shares as a CASH-NEUTRAL opening
 * GOOG position (net_cash_impact = 0, matching the original seed), so the cash
 * balance is untouched. The user's separately-added GOOG lot is left intact;
 * holdings fold by ticker, so the result is a single GOOG position.
 *
 * Idempotent and guarded by a token. Delete this file once it has been run.
 */

const TOKEN = "fix-goog-9f3a2c7e";
const PRICE = 351.37;
const SHARES = 50;

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        backend: activeBackend(),
        message:
          "No DATABASE_URL — this deploy is file-backed, not Postgres. The code seed already opens GOOG (Class C), so a fresh state is correct; nothing to migrate here.",
      },
      { status: 200 }
    );
  }

  try {
    await ensureSchema();

    const result = await withTransaction(async (c) => {
      const del = await c.query(
        "DELETE FROM portfolio_transactions WHERE ticker = 'GOOGL'"
      );
      await c.query("DELETE FROM portfolio_archived WHERE ticker = 'GOOGL'");

      // Cash-neutral opening GOOG lot (mirrors the original seed semantics).
      const ins = await c.query(
        `INSERT INTO portfolio_transactions
           (id, ticker, company_name, trade_type, shares, price_per_share,
            gross_amount, fees, net_cash_impact, trade_date, notes, opening,
            adjustment, created_at)
         VALUES ('seed-GOOG', 'GOOG', 'Alphabet Inc. (Class C)', 'BUY', $1, $2,
            $3, 0, 0, '2025-01-01', 'Opening position (reclassified to Class C)',
            TRUE, NULL, '2025-01-01T00:00:00.000Z')
         ON CONFLICT (id) DO NOTHING`,
        [SHARES, PRICE, Math.round(SHARES * PRICE * 100) / 100]
      );

      // Normalise the company name across any user-added GOOG lots too.
      await c.query(
        "UPDATE portfolio_transactions SET company_name = 'Alphabet Inc. (Class C)' WHERE ticker = 'GOOG'"
      );

      return { googlRowsDeleted: del.rowCount ?? 0, googOpeningInserted: ins.rowCount ?? 0 };
    });

    const { positions, cash } = await getDerivedPortfolio();
    const goog = positions.find((p) => p.ticker === "GOOG") ?? null;

    return NextResponse.json({
      ok: true,
      backend: activeBackend(),
      ...result,
      goog,
      cash,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Migration failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
