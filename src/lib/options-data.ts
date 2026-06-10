import "server-only";
import { mboumFetch } from "@/lib/mboum";
import { getImpliedMove as tradierImpliedMove, isTradierConfigured } from "@/lib/tradier";

/**
 * Options-implied earnings move with a PROVIDER CHAIN, because availability
 * differs by region/plan:
 *   1. Mboum /markets/options — works the moment AJ's plan includes Options.
 *   2. Marketdata.app — free tier, AU-friendly (MARKETDATA_TOKEN).
 *   3. Tradier sandbox — US-only signup (TRADIER_TOKEN).
 * Implied move = ATM call mid + ATM put mid over the first expiry ≥ the print
 * date, divided by spot. Null when no provider succeeds — callers degrade.
 */

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: number | null }>();

function mid(bid?: number | null, ask?: number | null, last?: number | null): number | null {
  if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
  if (last != null && last > 0) return last;
  return null;
}

// --- Provider 1: Mboum (Yahoo-shaped optionChain) ---------------------------

type YahooOption = { strike: number; bid?: number; ask?: number; lastPrice?: number };
type MboumOptionsBody = {
  body?: Array<{
    expirationDates?: number[];
    quote?: { regularMarketPrice?: number };
    options?: Array<{ calls?: YahooOption[]; puts?: YahooOption[] }>;
  }>;
};

async function mboumImpliedMove(ticker: string, afterDate: string): Promise<number | null> {
  try {
    const first = await mboumFetch<MboumOptionsBody>("/markets/options", { ticker }, 1800);
    const root = first?.body?.[0];
    const spot = root?.quote?.regularMarketPrice;
    const expiries = root?.expirationDates ?? [];
    if (!spot || spot <= 0 || expiries.length === 0) return null;
    const afterEpoch = Date.parse(`${afterDate}T00:00:00Z`) / 1000;
    const expiry = expiries.find((e) => e >= afterEpoch);
    if (!expiry) return null;

    const chain = await mboumFetch<MboumOptionsBody>(
      "/markets/options",
      { ticker, expiration: String(expiry) },
      1800
    );
    const opt = chain?.body?.[0]?.options?.[0];
    const calls = opt?.calls ?? [];
    const puts = opt?.puts ?? [];
    if (calls.length === 0 || puts.length === 0) return null;

    const atm = (xs: YahooOption[]) =>
      xs.reduce((b, o) => (Math.abs(o.strike - spot) < Math.abs(b.strike - spot) ? o : b));
    const c = atm(calls);
    const p = atm(puts);
    const cm = mid(c.bid, c.ask, c.lastPrice);
    const pm = mid(p.bid, p.ask, p.lastPrice);
    if (cm == null || pm == null) return null;
    return Math.round(((cm + pm) / spot) * 1000) / 10;
  } catch {
    return null;
  }
}

// --- Provider 2: Marketdata.app ---------------------------------------------

function marketdataToken(): string | null {
  return process.env.MARKETDATA_TOKEN?.trim() || null;
}

async function mdGet<T>(url: string): Promise<T | null> {
  const token = marketdataToken();
  if (!token) return null;
  try {
    const res = await fetch(url, {
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

async function marketdataImpliedMove(ticker: string, afterDate: string): Promise<number | null> {
  if (!marketdataToken()) return null;
  const q = await mdGet<{ last?: number[] }>(
    `https://api.marketdata.app/v1/stocks/quotes/${encodeURIComponent(ticker)}/`
  );
  const spot = q?.last?.[0];
  if (!spot || spot <= 0) return null;

  const ex = await mdGet<{ expirations?: string[] }>(
    `https://api.marketdata.app/v1/options/expirations/${encodeURIComponent(ticker)}/`
  );
  const expiry = (ex?.expirations ?? []).find((d) => d >= afterDate);
  if (!expiry) return null;

  // Column-oriented chain: parallel arrays per contract.
  const ch = await mdGet<{
    side?: string[];
    strike?: number[];
    bid?: number[];
    ask?: number[];
    last?: number[];
  }>(
    `https://api.marketdata.app/v1/options/chain/${encodeURIComponent(ticker)}/?expiration=${expiry}`
  );
  const n = ch?.strike?.length ?? 0;
  if (!ch || n === 0) return null;

  let callMid: number | null = null;
  let putMid: number | null = null;
  let bestCall = Infinity;
  let bestPut = Infinity;
  for (let i = 0; i < n; i++) {
    const dist = Math.abs((ch.strike?.[i] ?? 0) - spot);
    const m = mid(ch.bid?.[i], ch.ask?.[i], ch.last?.[i]);
    if (m == null) continue;
    if (ch.side?.[i] === "call" && dist < bestCall) {
      bestCall = dist;
      callMid = m;
    } else if (ch.side?.[i] === "put" && dist < bestPut) {
      bestPut = dist;
      putMid = m;
    }
  }
  if (callMid == null || putMid == null) return null;
  return Math.round(((callMid + putMid) / spot) * 1000) / 10;
}

// --- Public chain -------------------------------------------------------------

export async function getImpliedMove(
  ticker: string,
  afterDate: string
): Promise<number | null> {
  const key = `${ticker}:${afterDate}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = await mboumImpliedMove(ticker, afterDate);
  if (value == null) value = await marketdataImpliedMove(ticker, afterDate);
  if (value == null && isTradierConfigured()) {
    value = await tradierImpliedMove(ticker, afterDate).catch(() => null);
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}
