import "server-only";
import { mboumFetch, isMboumConfigured } from "@/lib/mboum";
import {
  getMarketSession,
  type MarketSession,
} from "@/lib/market-session";

/**
 * [exthours] Extended-hours (pre / post-market) pricing from Mboum.
 *
 * Mboum's `/markets/quote` endpoint (Nasdaq-backed) returns a `body` with TWO
 * print blocks plus a `marketStatus` string. IMPORTANT — which block holds the
 * live extended print is NOT fixed by name. Verified against live Nasdaq data
 * during pre-market (NBIS, 2026-06-25 07:24 ET):
 *
 *   primaryData   = LIVE pre-market print  ($271.40, +4.52%, isRealTime: true)
 *   secondaryData = prior regular close    ($259.66, "Closed at ... 4:00 PM ET",
 *                                            isRealTime: false)
 *
 * The earlier implementation read `secondaryData` as the extended price, which
 * is exactly inverted — it surfaced yesterday's 4 PM close and labelled it
 * "pre". The fix: select the block flagged `isRealTime` as the live extended
 * print, and treat the other (the "Closed at ..." block) as the regular close
 * we measure change against. This is robust for both pre- and after-hours,
 * regardless of which named block Nasdaq puts the live print in.
 *
 * This module NEVER fabricates: any missing / unparseable / non-positive field
 * yields null and the caller falls back to the existing prior-close behavior.
 *
 * Endpoint: GET /markets/quote?ticker=<SYM>&type=STOCKS
 */

export type ExtendedQuote = {
  /** The extended session this print belongs to (guaranteed pre or post). */
  session: "pre" | "post";
  /** Extended-hours last price (USD), > 0. */
  price: number;
  /** Extended-hours % change vs the regular-session close, if derivable. */
  changePct: number | null;
  /** Regular-session close we measured the change against, when known. */
  regularClose: number | null;
};

/** One Nasdaq print block — only the fields we read. */
type MboumPrintBlock = {
  lastSalePrice?: string | null;
  netChange?: string | null;
  percentageChange?: string | null;
  isRealTime?: boolean | null;
  lastTradeTimestamp?: string | null;
} | null;

/** Mboum / Nasdaq quote response — only the fields we read. */
type MboumQuoteBody = {
  marketStatus?: string | null;
  primaryData?: MboumPrintBlock;
  secondaryData?: MboumPrintBlock;
  keyStats?: { PreviousClose?: { value?: string | null } } | null;
};
type MboumQuoteResponse = { body?: MboumQuoteBody | null };

/** Parse Mboum's "$429.36" / "429.36" money string into a positive number, else null. */
function parseMoney(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse a "+1.23%" / "-0.45" percent string into a finite number, else null. */
function parsePct(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** True when a block looks like a stale "Closed at ..." regular-session print. */
function isClosedBlock(b: MboumPrintBlock): boolean {
  if (!b) return false;
  if (b.isRealTime === true) return false;
  return /closed/i.test(b.lastTradeTimestamp ?? "");
}

/**
 * Map Nasdaq's `marketStatus` string to our session enum. Falls back to the
 * provided clock-derived session when the field is absent/unrecognized, so we
 * never mislabel a valid print.
 */
function sessionFromStatus(
  status: string | null | undefined,
  fallback: MarketSession
): MarketSession {
  const s = (status ?? "").toLowerCase();
  if (s.includes("pre")) return "pre";
  if (s.includes("after") || s.includes("post")) return "post";
  if (s.includes("open") || s.includes("regular")) return "regular";
  if (s.includes("closed")) return fallback === "regular" ? "closed" : fallback;
  return fallback;
}

/**
 * Pick the LIVE extended print block and the prior-close block from the two
 * Nasdaq blocks. The live print is whichever block is flagged `isRealTime`;
 * the other is the regular close. Defensive fallbacks keep us correct even if
 * the flag is ever missing.
 */
function selectBlocks(body: MboumQuoteBody): {
  live: MboumPrintBlock;
  close: MboumPrintBlock;
} {
  const pd = body.primaryData ?? null;
  const sd = body.secondaryData ?? null;

  // Primary signal: the realtime block is the live extended print.
  if (pd?.isRealTime === true) return { live: pd, close: sd };
  if (sd?.isRealTime === true) return { live: sd, close: pd };

  // Secondary signal: if one block is explicitly "Closed at ...", the other is live.
  if (isClosedBlock(sd) && pd) return { live: pd, close: sd };
  if (isClosedBlock(pd) && sd) return { live: sd, close: pd };

  // Fallback: Nasdaq's primaryData is the "current" sale; treat it as live.
  return { live: pd ?? sd, close: pd ? sd : null };
}

/**
 * Fetch a real extended-hours print for `ticker`, or null.
 *
 * Returns non-null ONLY when:
 *   - Mboum is configured, AND
 *   - the resolved session is "pre" or "post" (never "regular"/"closed"), AND
 *   - a positive live-block lastSalePrice is present.
 *
 * `clockSession` is the wall-clock session (US/Eastern); it is used both as the
 * gate (we don't bother fetching during the regular session) and as the
 * fallback label when the feed omits `marketStatus`.
 */
export async function getExtendedHoursQuote(
  ticker: string,
  clockSession: MarketSession = getMarketSession()
): Promise<ExtendedQuote | null> {
  // During regular hours the Finnhub path owns the price — do nothing here.
  if (clockSession === "regular") return null;
  if (!isMboumConfigured()) return null;

  let body: MboumQuoteBody | null | undefined;
  try {
    // Short revalidate: extended-hours prints move; don't serve a stale cache.
    const data = await mboumFetch<MboumQuoteResponse>(
      "/markets/quote",
      { ticker: ticker.toUpperCase(), type: "STOCKS" },
      30
    );
    body = data.body;
  } catch {
    return null; // never throw into the portfolio build
  }
  if (!body) return null;

  const session = sessionFromStatus(body.marketStatus, clockSession);
  // Only surface a price for the two extended sessions. If Nasdaq says the
  // regular market is open or fully closed, leave the prior-close path alone.
  if (session !== "pre" && session !== "post") return null;

  const { live, close } = selectBlocks(body);

  const price = parseMoney(live?.lastSalePrice);
  if (price == null) return null; // no valid extended print -> fall back

  // The live block's own % change is already measured vs the regular close.
  // If absent, derive it from the close block (or keyStats.PreviousClose).
  const regularClose =
    parseMoney(close?.lastSalePrice) ??
    parseMoney(body.keyStats?.PreviousClose?.value);
  let changePct = parsePct(live?.percentageChange);
  if (changePct == null && regularClose != null && regularClose > 0) {
    changePct = ((price - regularClose) / regularClose) * 100;
  }

  // `session` is provably "pre" | "post" here (guarded above); assert for TS.
  return { session: session as "pre" | "post", price, changePct, regularClose };
}
