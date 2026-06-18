import "server-only";
import { mboumFetch, isMboumConfigured } from "@/lib/mboum";
import {
  getMarketSession,
  type MarketSession,
} from "@/lib/market-session";

/**
 * [exthours] Extended-hours (pre / post-market) pricing from Mboum.
 *
 * Mboum's `/markets/quote` endpoint (Nasdaq-backed) returns a `body` with a
 * `primaryData` block (the regular-session print) and, during pre/after-hours,
 * a `secondaryData` block holding the EXTENDED-HOURS print. `marketStatus`
 * tells us which session Nasdaq currently considers active.
 *
 * This module's only job: when the REGULAR session is closed, fetch a real
 * pre/post-market print so the dashboard can surface a live price instead of
 * yesterday's close (the IBKR-shows-live-pre-market pain). It NEVER fabricates:
 * any missing / unparseable / non-positive field yields null, and the caller
 * falls back to the existing prior-close behavior.
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

/** Mboum / Nasdaq quote response — only the fields we read. */
type MboumQuoteBody = {
  marketStatus?: string | null;
  primaryData?: {
    lastSalePrice?: string | null;
    netChange?: string | null;
    percentageChange?: string | null;
  } | null;
  secondaryData?: {
    lastSalePrice?: string | null;
    netChange?: string | null;
    percentageChange?: string | null;
  } | null;
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
 * Fetch a real extended-hours print for `ticker`, or null.
 *
 * Returns non-null ONLY when:
 *   - Mboum is configured, AND
 *   - the resolved session is "pre" or "post" (never "regular"/"closed"), AND
 *   - a positive secondaryData lastSalePrice is present.
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

  const price = parseMoney(body.secondaryData?.lastSalePrice);
  if (price == null) return null; // no valid extended print -> fall back

  // Prefer the explicit extended % change; otherwise derive it from the
  // regular-session close (primaryData price / previous close).
  const regularClose =
    parseMoney(body.primaryData?.lastSalePrice) ??
    parseMoney(body.keyStats?.PreviousClose?.value);
  let changePct = parsePct(body.secondaryData?.percentageChange);
  if (changePct == null && regularClose != null && regularClose > 0) {
    changePct = ((price - regularClose) / regularClose) * 100;
  }

  // `session` is provably "pre" | "post" here (guarded above); assert for TS.
  return { session: session as "pre" | "post", price, changePct, regularClose };
}
