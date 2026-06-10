import "server-only";

/**
 * Tradier options connector — used ONLY for the options-implied earnings move
 * (ATM straddle ÷ spot for the first expiry after the print). Works with the
 * free developer sandbox (delayed quotes are fine for this).
 *
 * Opt-in via TRADIER_TOKEN; TRADIER_BASE_URL overrides the sandbox default
 * (set to https://api.tradier.com/v1 for a production account). Gracefully
 * null everywhere — callers show the historical move alone without it.
 */

const BASE =
  process.env.TRADIER_BASE_URL?.trim() || "https://sandbox.tradier.com/v1";

export function isTradierConfigured(): boolean {
  return Boolean(process.env.TRADIER_TOKEN?.trim());
}

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: number | null }>();

async function tradierGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const token = process.env.TRADIER_TOKEN?.trim();
  if (!token) return null;
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function mid(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
  if (last != null && last > 0) return last;
  return null;
}

/**
 * Options-implied move (%) over the first expiry on/after `afterDate`
 * (YYYY-MM-DD): ATM call mid + ATM put mid, divided by spot. Null when
 * unconfigured or any leg is unavailable.
 */
export async function getImpliedMove(
  ticker: string,
  afterDate: string
): Promise<number | null> {
  if (!isTradierConfigured()) return null;
  const key = `${ticker}:${afterDate}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const compute = async (): Promise<number | null> => {
    const q = await tradierGet<{
      quotes?: { quote?: { last?: number } | Array<{ last?: number }> };
    }>("/markets/quotes", { symbols: ticker });
    const quote = Array.isArray(q?.quotes?.quote) ? q?.quotes?.quote[0] : q?.quotes?.quote;
    const spot = quote?.last ?? null;
    if (!spot || spot <= 0) return null;

    const ex = await tradierGet<{ expirations?: { date?: string[] | string } }>(
      "/markets/options/expirations",
      { symbol: ticker }
    );
    const dates = ex?.expirations?.date;
    const list = Array.isArray(dates) ? dates : dates ? [dates] : [];
    const expiry = list.find((d) => d >= afterDate);
    if (!expiry) return null;

    const ch = await tradierGet<{
      options?: {
        option?: Array<{
          strike: number;
          option_type: "call" | "put";
          bid: number | null;
          ask: number | null;
          last: number | null;
        }>;
      };
    }>("/markets/options/chains", { symbol: ticker, expiration: expiry });
    const options = ch?.options?.option ?? [];
    if (options.length === 0) return null;

    // ATM strike = closest to spot.
    let atm = options[0].strike;
    for (const o of options) {
      if (Math.abs(o.strike - spot) < Math.abs(atm - spot)) atm = o.strike;
    }
    const call = options.find((o) => o.strike === atm && o.option_type === "call");
    const put = options.find((o) => o.strike === atm && o.option_type === "put");
    const callMid = call ? mid(call.bid, call.ask, call.last) : null;
    const putMid = put ? mid(put.bid, put.ask, put.last) : null;
    if (callMid == null || putMid == null) return null;

    return Math.round(((callMid + putMid) / spot) * 1000) / 10; // % to 1dp
  };

  const value = await compute().catch(() => null);
  cache.set(key, { at: Date.now(), value });
  return value;
}
