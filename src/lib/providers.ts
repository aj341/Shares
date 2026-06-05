import "server-only";
import { getQuote } from "@/lib/finnhub";
import { mboumFetch, getStockHistory } from "@/lib/mboum";

/**
 * Multi-source provider corroboration.
 *
 * Fetches the same ticker's current price from two independent providers
 * (Finnhub quote + Mboum quote) and reports how far they diverge. Used to flag
 * stale or anomalous prints before they drive a verdict.
 *
 * Either source may be null (unconfigured / rate-limited / unknown ticker); the
 * caller decides how to surface a partial check. When divergence can't be
 * computed we default to `agree: true` so a missing source never raises alarm.
 */

export type ProviderCheck = {
  ticker: string;
  finnhub: number | null;
  mboum: number | null;
  divergencePct: number | null;
  agree: boolean;
};

/** Mboum quote response — only the field we read. */
type MboumQuoteResponse = {
  body?: {
    primaryData?: { lastSalePrice?: string | null };
    secondaryData?: { lastSalePrice?: string | null };
  };
};

/** Parse Mboum's "$429.36" money string into a finite number, else null. */
function parseMoney(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Finnhub current price (`c`), null on failure or non-positive. */
async function finnhubPrice(ticker: string): Promise<number | null> {
  const q = await getQuote(ticker);
  const c = q?.c;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : null;
}

/**
 * Mboum price: live quote lastSalePrice first, falling back to the most recent
 * close from history. Null if neither is available.
 */
async function mboumPrice(ticker: string): Promise<number | null> {
  try {
    const data = await mboumFetch<MboumQuoteResponse>("/markets/quote", {
      ticker,
      type: "STOCKS",
    });
    const live =
      parseMoney(data.body?.primaryData?.lastSalePrice) ??
      parseMoney(data.body?.secondaryData?.lastSalePrice);
    if (live != null) return live;
  } catch {
    // fall through to history
  }

  const history = await getStockHistory(ticker, { monthsBack: 1 });
  const lastClose = history.at(-1)?.close;
  return typeof lastClose === "number" && Number.isFinite(lastClose) && lastClose > 0
    ? lastClose
    : null;
}

/**
 * Corroborate one ticker across Finnhub and Mboum.
 * divergencePct = |finnhub - mboum| / mboum * 100; agree when < 1.5% (or when
 * divergence is unknown).
 */
export async function getProviderCheck(ticker: string): Promise<ProviderCheck> {
  const symbol = ticker.toUpperCase();
  const [finnhub, mboum] = await Promise.all([
    finnhubPrice(symbol),
    mboumPrice(symbol),
  ]);

  const divergencePct =
    finnhub != null && mboum != null && mboum !== 0
      ? (Math.abs(finnhub - mboum) / mboum) * 100
      : null;

  const agree = divergencePct == null ? true : divergencePct < 1.5;

  return { ticker: symbol, finnhub, mboum, divergencePct, agree };
}
