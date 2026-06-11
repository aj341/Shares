import { NextRequest, NextResponse } from "next/server";
import { fetchFlexStatement, isIbkrConfigured } from "@/lib/ibkr";
import { saveBrokerCash } from "@/lib/broker-cash";
import {
  appendTransaction,
  readPortfolio,
  setArchived,
} from "@/lib/portfolio-store";
import { derive } from "@/lib/portfolio-derivation";
import { buildTransaction } from "@/lib/transactions";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRICE_EPS = 0.01;

/**
 * Sync the ledger to IBKR via the Flex Web Service. Reconciles share counts +
 * avg cost per stock (ADJUSTMENT entries) and archives positions IBKR no longer
 * reports. Guarded by CRON_SECRET. `?debug=1` returns the parsed statement
 * WITHOUT mutating, so we can verify the query's fields.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const provided =
      req.nextUrl.searchParams.get("secret") || req.headers.get("x-cron-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" } satisfies ApiError, { status: 401 });
    }
  }

  if (!isIbkrConfigured()) {
    return NextResponse.json({
      ok: false,
      reason:
        "IBKR Flex token not found. Set it in Railway as IBKR_FLEX_TOKEN (or IBKR_TOKEN / IBKR_API_KEY).",
    });
  }

  try {
    const statement = await fetchFlexStatement();

    if (req.nextUrl.searchParams.get("debug") === "1") {
      return NextResponse.json({ ok: true, debug: true, ...statement });
    }

    // Stock positions only.
    const stocks = statement.positions.filter(
      (p) => p.assetCategory === "STK" || p.assetCategory === ""
    );
    if (stocks.length === 0) {
      return NextResponse.json({
        ok: true,
        reason: "no stock positions in Flex statement — skipped (nothing archived)",
        cash: statement.cash,
      });
    }

    const persisted = await readPortfolio();
    const before = derive(persisted);
    const current = new Map(before.positions.map((p) => [p.ticker, p]));
    const ibkrSymbols = new Set(stocks.map((s) => s.symbol));

    // STALENESS GUARD: the Flex statement reflects IBKR's last overnight
    // cycle. If our ledger has a MANUAL entry for a ticker dated AFTER the
    // statement was generated (same-day trade entered by hand), the statement
    // is the stale party — skip that ticker rather than reverting the human.
    // whenGenerated format: "yyyyMMdd;HHmmss" (statement-period end day).
    const stmtDate = statement.whenGenerated
      ? `${statement.whenGenerated.slice(0, 4)}-${statement.whenGenerated.slice(4, 6)}-${statement.whenGenerated.slice(6, 8)}`
      : null;
    const newerManualTickers = new Set<string>();
    if (stmtDate) {
      for (const tx of persisted.transactions) {
        if (tx.tradeDate > stmtDate && !tx.notes?.includes("IBKR Flex sync")) {
          newerManualTickers.add(tx.ticker);
        }
      }
    }

    // Cash moves with trades — when ANY manual entry outdates the statement,
    // the statement cash is stale too; keep the manual estimate until IBKR
    // publishes a fresh statement.
    const cashPersisted = newerManualTickers.size === 0;
    if (cashPersisted) {
      await saveBrokerCash(
        statement.cash.map((c) => ({ currency: c.currency, amount: c.endingCash }))
      ).catch(() => {});
    }

    const synced: string[] = [];
    const skippedStale: string[] = [];
    const tradeDate = new Date().toISOString().slice(0, 10);

    for (const s of stocks) {
      const cur = current.get(s.symbol);
      const sharesMatch = cur && Math.abs(cur.shares - s.quantity) < 1e-6;
      const priceMatch = cur && Math.abs(cur.entryPrice - s.avgPrice) < PRICE_EPS;
      if (sharesMatch && priceMatch) continue; // already in sync
      if (newerManualTickers.has(s.symbol)) {
        skippedStale.push(s.symbol);
        continue; // ledger knows about trades newer than this statement
      }

      const tx = buildTransaction({
        ticker: s.symbol,
        companyName: cur?.companyName ?? s.description ?? s.symbol,
        tradeType: "ADJUSTMENT",
        shares: 0,
        pricePerShare: 0,
        tradeDate,
        notes: "IBKR Flex sync",
        adjustment: { shares: s.quantity, avgPrice: s.avgPrice },
      });
      await appendTransaction(tx);
      synced.push(`${s.symbol} → ${s.quantity} @ ${s.avgPrice}`);
    }

    // Archive holdings IBKR no longer reports (sold out elsewhere).
    const archived: string[] = [];
    for (const p of before.positions) {
      if (!ibkrSymbols.has(p.ticker) && !newerManualTickers.has(p.ticker)) {
        await setArchived(p.ticker, true);
        archived.push(p.ticker);
      }
    }

    return NextResponse.json({
      ok: true,
      synced,
      skippedStale,
      cashPersisted,
      archived,
      cash: statement.cash,
      trades: statement.trades.length,
      performance: statement.performance.length,
      whenGenerated: statement.whenGenerated,
    });
  } catch (err) {
    const body: ApiError = {
      error: "IBKR sync failed",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
