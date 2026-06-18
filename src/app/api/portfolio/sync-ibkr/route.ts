import { NextRequest, NextResponse } from "next/server";
import { fetchFlexStatement, isIbkrConfigured } from "@/lib/ibkr";
import { readBrokerCash, saveBrokerCash } from "@/lib/broker-cash";
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
/** Skip a fresh Flex round-trip if the broker book synced within this window. */
const THROTTLE_MS = 5 * 60 * 1000;

/**
 * Core realign: pull the Flex statement and reconcile the ledger to it.
 * `debug` returns the parsed statement WITHOUT mutating. Shared by the
 * scheduled GET (CRON_SECRET) and the in-app POST (Sync button / auto-sync).
 */
async function realignToIbkr(debug: boolean) {
  const statement = await fetchFlexStatement();

  if (debug) {
    return { ok: true, debug: true, ...statement };
  }

  // Stock positions only.
  const stocks = statement.positions.filter(
    (p) => p.assetCategory === "STK" || p.assetCategory === ""
  );
  if (stocks.length === 0) {
    return {
      ok: true,
      reason: "no stock positions in Flex statement — skipped (nothing archived)",
      cash: statement.cash,
    };
  }

  const persisted = await readPortfolio();
  const before = derive(persisted);
  const current = new Map(before.positions.map((p) => [p.ticker, p]));
  const ibkrSymbols = new Set(stocks.map((s) => s.symbol));

  // A position IBKR reports again must be UN-archived (else derive() hides it).
  const unarchived: string[] = [];
  for (const sym of ibkrSymbols) {
    if (persisted.archivedTickers.includes(sym)) {
      await setArchived(sym, false);
      unarchived.push(sym);
    }
  }

  // STALENESS GUARD: a manual entry dated AFTER the statement means the
  // statement is the stale party — skip that ticker rather than reverting it.
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
  // keep the manual estimate until IBKR publishes a fresh statement.
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

  // Don't archive a name you just bought by hand the statement hasn't caught up to.
  const recentManualBuys = new Set<string>();
  if (stmtDate) {
    for (const tx of persisted.transactions) {
      if (
        tx.tradeType === "BUY" &&
        tx.tradeDate >= stmtDate &&
        !tx.notes?.includes("IBKR Flex sync")
      ) {
        recentManualBuys.add(tx.ticker);
      }
    }
  }

  // Archive holdings IBKR no longer reports (sold out elsewhere).
  const archived: string[] = [];
  for (const p of before.positions) {
    if (
      !ibkrSymbols.has(p.ticker) &&
      !newerManualTickers.has(p.ticker) &&
      !recentManualBuys.has(p.ticker)
    ) {
      await setArchived(p.ticker, true);
      archived.push(p.ticker);
    }
  }

  return {
    ok: true,
    synced,
    skippedStale,
    unarchived,
    cashPersisted,
    archived,
    cash: statement.cash,
    trades: statement.trades.length,
    performance: statement.performance.length,
    whenGenerated: statement.whenGenerated,
  };
}

function failResponse(err: unknown) {
  const e = err as Error;
  const detail =
    e?.message ||
    e?.stack?.split("\n").slice(0, 3).join(" | ") ||
    (typeof err === "string" ? err : JSON.stringify(err)) ||
    `${e?.name ?? typeof err} (no message)`;
  const body: ApiError = { error: "IBKR sync failed", detail };
  return NextResponse.json(body, { status: 500 });
}

/**
 * Scheduled realign (GitHub Actions). Guarded by CRON_SECRET. `?debug=1`
 * returns the parsed statement WITHOUT mutating, to verify the query fields.
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
    const debug = req.nextUrl.searchParams.get("debug") === "1";
    return NextResponse.json(await realignToIbkr(debug));
  } catch (err) {
    return failResponse(err);
  }
}

/**
 * In-app realign — powers the "Sync IBKR" button and the auto-sync on load.
 * No secret (same-origin user action); throttled so repeated page loads don't
 * hammer the Flex service.
 */
export async function POST() {
  if (!isIbkrConfigured()) {
    return NextResponse.json({ ok: false, reason: "IBKR Flex token not configured." });
  }
  try {
    const bc = await readBrokerCash().catch(() => null);
    if (bc?.syncedAt) {
      const ageMs = Date.now() - new Date(bc.syncedAt).getTime();
      if (ageMs >= 0 && ageMs < THROTTLE_MS) {
        return NextResponse.json({ ok: true, skipped: "fresh", syncedAt: bc.syncedAt });
      }
    }
    return NextResponse.json(await realignToIbkr(false));
  } catch (err) {
    return failResponse(err);
  }
}
