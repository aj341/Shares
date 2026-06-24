import "server-only";

// [wfa] ORDER TICKETS — display-only, NO execution.
// ---------------------------------------------------------------------------
// *** THIS MODULE NEVER PLACES AN ORDER. ***
// IBKR Flex is READ-ONLY; there is no order API anywhere in this app. An "order
// ticket" here is a COPYABLE, PRE-FILLED summary the user TYPES MANUALLY into
// IBKR. It is purely a convenience that turns an existing recommendation (from
// the redistribution engine or a Top-3 move) into a ready-to-read ticket with a
// suggested limit, a suggested stop and the dollar/percent risk on the book.
//
// ADDITIVE: it consumes the redistribution + top-moves output as-is and never
// changes their sizing/scoring. Sizing comes STRAIGHT from the recommendation's
// share count (which the redistribution engine already produced respecting the
// concentration / position-sizing limits) — we do not re-size.
//
// STOP LOGIC (honest about data):
//   IBKR Flex / Mboum daily candles in this app expose CLOSE only (no intraday
//   high/low), so a textbook Wilder ATR (which needs the true range) cannot be
//   computed. Instead we derive an ATR-LIKE daily move from close-to-close
//   absolute returns over a lookback (default 14 sessions):
//       atrLikePct = mean(|close_t/close_{t-1} - 1|) * 100
//   The suggested stop is then `stopAtrMult` (default 2x) of that daily move
//   away from the limit, on the correct side of the trade. When no history is
//   available we fall back to a flat `fallbackStopPct` (default 8%). The ticket
//   labels which method was used so the user knows the basis.

import { getStockHistory, isMboumConfigured, type MboumCandle } from "@/lib/mboum";
import type {
  PortfolioResponse,
  RedistributionResponse,
  TradeRecommendation,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Tunables (local, labelled).
// ---------------------------------------------------------------------------

/** Limit offset from the last price: BUY pays up to +x%, SELL/TRIM accepts -x%. */
const LIMIT_SLIPPAGE_PCT = 0.3;
/** ATR-like multiplier for the stop distance. */
const STOP_ATR_MULT = 2;
/** Sessions of close-to-close moves used for the ATR-like estimate. */
const ATR_LOOKBACK = 14;
/** Flat stop used when no price history is available. */
const FALLBACK_STOP_PCT = 8;
/** Min/max clamp on the stop distance (% of price) so a quiet/volatile name
 *  never produces a silly stop. */
const MIN_STOP_PCT = 3;
const MAX_STOP_PCT = 20;

export type OrderSide = "BUY" | "SELL" | "TRIM";
export type StopBasis = "atr_like" | "percent" | "none";
export type TicketOrigin = "redistribution" | "top3";

export type OrderTicket = {
  ticker: string;
  companyName?: string;
  side: OrderSide;
  /** Whole shares — taken directly from the source recommendation. */
  quantity: number;
  /** Reference last price (USD). */
  lastPrice: number;
  /** Suggested LIMIT price (USD): buy slightly above, sell slightly below last. */
  limitPrice: number;
  /** Suggested protective STOP price (USD); null when not applicable. */
  stopPrice: number | null;
  stopBasis: StopBasis;
  /** Stop distance from the limit, as a % of the limit price. */
  stopDistancePct: number | null;
  /** Notional value of the order at the limit (USD). */
  notionalUsd: number;
  /** Dollar risk if the stop is hit from the limit (USD). null when no stop. */
  riskUsd: number | null;
  /** Risk as a % of the whole book (display currency basis). null when no stop. */
  riskPctOfBook: number | null;
  /** Where this ticket came from (redistribution rec or a Top-3 ADD move). */
  origin: TicketOrigin;
  /** Carried straight from the source — explains WHY the trade exists. */
  rationale: string;
  /** Pre-formatted, copyable one-liner for manual entry into IBKR. */
  copyText: string;
};

export type OrderTicketsResult = {
  tickets: OrderTicket[];
  /** Total dollar risk across all tickets that carry a stop (USD). */
  totalRiskUsd: number;
  /** Total dollar risk as a % of the book. */
  totalRiskPctOfBook: number;
  /** Book value used for the %-of-book risk (display currency, e.g. AUD). */
  bookValue: number;
  /** USD->display-ccy rate used for the risk %, so the math is transparent. */
  fxUsdToBook: number;
  stopConfig: {
    atrMult: number;
    atrLookback: number;
    fallbackStopPct: number;
    limitSlippagePct: number;
  };
  asOf: string;
  /** ALWAYS true — loud, machine-readable reminder this app cannot trade. */
  displayOnly: true;
  disclaimer: string;
  hasData: boolean;
};

const DISCLAIMER =
  "DISPLAY ONLY — these tickets do NOT place orders. IBKR Flex is read-only; " +
  "there is no order API. Copy the details and enter them MANUALLY in IBKR. " +
  "Sizing/limits/stops are suggestions from the app's own engine, not financial advice.";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * ATR-like daily move (%) from close-to-close absolute returns. Returns null
 * when there isn't enough history. NOTE: not a true Wilder ATR — daily candles
 * here carry close only (no intraday high/low), so this is an honest proxy.
 */
export function atrLikePctFromCandles(
  candles: MboumCandle[],
  lookback = ATR_LOOKBACK
): number | null {
  const closes = (candles ?? [])
    .map((c) => c.close)
    .filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 3) return null;
  const recent = closes.slice(-(lookback + 1));
  const moves: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    moves.push(Math.abs(recent[i] / recent[i - 1] - 1));
  }
  if (moves.length === 0) return null;
  const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
  return mean * 100;
}

/** Suggested limit price for a side, last price + slippage on the correct side. */
function limitFor(side: OrderSide, lastPrice: number): number {
  const slip = LIMIT_SLIPPAGE_PCT / 100;
  // BUY pays up to slightly above last; SELL/TRIM accepts slightly below last.
  const px = side === "BUY" ? lastPrice * (1 + slip) : lastPrice * (1 - slip);
  return round2(px);
}

/**
 * Suggested stop given the limit and side. Long trades (BUY) stop BELOW; exits
 * (SELL/TRIM) are reducing a long, so a protective stop also sits BELOW the
 * limit (it caps how far the remaining position can fall while you work
 * the order). Returns the stop, its basis and the distance %.
 */
function stopFor(
  side: OrderSide,
  limitPrice: number,
  atrLikePct: number | null
): { stopPrice: number | null; basis: StopBasis; distancePct: number | null } {
  if (!(limitPrice > 0)) return { stopPrice: null, basis: "none", distancePct: null };

  let distancePct: number;
  let basis: StopBasis;
  if (atrLikePct != null && atrLikePct > 0) {
    distancePct = clamp(atrLikePct * STOP_ATR_MULT, MIN_STOP_PCT, MAX_STOP_PCT);
    basis = "atr_like";
  } else {
    distancePct = FALLBACK_STOP_PCT;
    basis = "percent";
  }
  // All our trades reduce or open LONG exposure, so the stop is always below.
  const stopPrice = round2(limitPrice * (1 - distancePct / 100));
  return { stopPrice, basis, distancePct: round2(distancePct) };
}

function buildCopyText(t: {
  side: OrderSide;
  ticker: string;
  quantity: number;
  limitPrice: number;
  stopPrice: number | null;
}): string {
  const parts = [
    `${t.side} ${t.quantity} ${t.ticker}`,
    `LIMIT $${t.limitPrice.toFixed(2)}`,
  ];
  if (t.stopPrice != null) parts.push(`STOP $${t.stopPrice.toFixed(2)}`);
  parts.push("DAY");
  return parts.join("  |  ");
}

// ---------------------------------------------------------------------------
// Core: build tickets from recommendations (PURE given candle lookups).
// ---------------------------------------------------------------------------

export type BuildOrderTicketsOpts = {
  /** Injectable candle provider (defaults to Mboum). */
  getHistory?: (ticker: string) => Promise<MboumCandle[]>;
  /** Cap the number of tickets generated (keeps candle fetches bounded). */
  maxTickets?: number;
};

/**
 * Build display-only tickets from the redistribution recommendations and,
 * optionally, additional ADD candidates surfaced by the Top-3 engine. Each
 * recommendation's SHARE COUNT is used verbatim (no re-sizing). null-safe:
 * empty inputs -> empty (but well-formed) result; never throws.
 */
export async function buildOrderTickets(
  recommendations: TradeRecommendation[],
  ctx: {
    /** Total book value in the DISPLAY currency (e.g. AUD) for %-of-book risk. */
    bookValue: number;
    /** 1 USD in the display currency. Prices are USD; risk % is book-relative. */
    fxUsdToBook: number;
  },
  opts: BuildOrderTicketsOpts = {}
): Promise<OrderTicketsResult> {
  const getHistory =
    opts.getHistory ??
    ((t: string) =>
      isMboumConfigured()
        ? getStockHistory(t, { interval: "1d", monthsBack: 3 })
        : Promise.resolve([] as MboumCandle[]));
  const maxTickets = opts.maxTickets ?? 12;

  const fx = ctx.fxUsdToBook > 0 ? ctx.fxUsdToBook : 1;
  const bookValue = ctx.bookValue > 0 ? ctx.bookValue : 0;

  // Keep only actionable recs with a positive share count + price.
  const actionable = (recommendations ?? [])
    .filter(
      (r) =>
        r &&
        r.shares > 0 &&
        r.estimatedPrice > 0 &&
        (r.action === "BUY" || r.action === "SELL" || r.action === "TRIM")
    )
    .slice(0, maxTickets);

  // One candle fetch per distinct ticker, concurrently (for the ATR-like stop).
  const tickers = [...new Set(actionable.map((r) => r.ticker))];
  const candleCache = new Map<string, MboumCandle[]>();
  await Promise.all(
    tickers.map(async (t) => {
      const c = await getHistory(t).catch(() => [] as MboumCandle[]);
      candleCache.set(t, c);
    })
  );

  const tickets: OrderTicket[] = [];
  for (const r of actionable) {
    const side = r.action as OrderSide;
    const lastPrice = r.estimatedPrice;
    const limitPrice = limitFor(side, lastPrice);
    const atrLikePct = atrLikePctFromCandles(candleCache.get(r.ticker) ?? []);
    const { stopPrice, basis, distancePct } = stopFor(side, limitPrice, atrLikePct);

    const notionalUsd = round2(r.shares * limitPrice);
    // Risk = shares * (limit - stop), only meaningful for an opening BUY; for a
    // reducing SELL/TRIM the stop just caps slippage on the exit, so we still
    // show $ risk against the shares being transacted for consistency.
    const riskUsd =
      stopPrice != null ? round2(r.shares * Math.abs(limitPrice - stopPrice)) : null;
    const riskPctOfBook =
      riskUsd != null && bookValue > 0
        ? round2(((riskUsd * fx) / bookValue) * 100)
        : null;

    tickets.push({
      ticker: r.ticker,
      side,
      quantity: r.shares,
      lastPrice: round2(lastPrice),
      limitPrice,
      stopPrice,
      stopBasis: basis,
      stopDistancePct: distancePct,
      notionalUsd,
      riskUsd,
      riskPctOfBook,
      origin: "redistribution",
      rationale: r.rationale,
      copyText: buildCopyText({
        side,
        ticker: r.ticker,
        quantity: r.shares,
        limitPrice,
        stopPrice,
      }),
    });
  }

  const totalRiskUsd = round2(
    tickets.reduce((s, t) => s + (t.riskUsd ?? 0), 0)
  );
  const totalRiskPctOfBook =
    bookValue > 0 ? round2(((totalRiskUsd * fx) / bookValue) * 100) : 0;

  return {
    tickets,
    totalRiskUsd,
    totalRiskPctOfBook,
    bookValue: round2(bookValue),
    fxUsdToBook: fx,
    stopConfig: {
      atrMult: STOP_ATR_MULT,
      atrLookback: ATR_LOOKBACK,
      fallbackStopPct: FALLBACK_STOP_PCT,
      limitSlippagePct: LIMIT_SLIPPAGE_PCT,
    },
    asOf: new Date().toISOString(),
    displayOnly: true,
    disclaimer: DISCLAIMER,
    hasData: tickets.length > 0,
  };
}

/**
 * Convenience: build tickets straight from a redistribution response + the
 * portfolio (for book value + FX). Reuses the engine's already-sized recs.
 */
export async function buildOrderTicketsFromRedistribution(
  redistribution: RedistributionResponse,
  portfolio: PortfolioResponse,
  opts: BuildOrderTicketsOpts = {}
): Promise<OrderTicketsResult> {
  return buildOrderTickets(
    redistribution.recommendations ?? [],
    {
      bookValue: portfolio.totalPortfolioValue,
      fxUsdToBook: portfolio.fxUsdToAud > 0 ? portfolio.fxUsdToAud : 1,
    },
    opts
  );
}
