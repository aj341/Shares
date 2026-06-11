import "server-only";

/**
 * Foreign-exchange rates for displaying the portfolio in AUD.
 *
 * The scoring / redistribution engine works in USD (US equities are USD-priced);
 * we convert to AUD purely for display. Rates come from Frankfurter (ECB
 * reference rates, no API key) and are cached; a static fallback keeps the app
 * working if the call fails. We never block the dashboard on this.
 */

export type FxRates = {
  /** Multiply an amount in this currency by the factor to get AUD. */
  toAud: Record<string, number>;
  /** 1 USD in AUD. */
  usdToAud: number;
  /** 1 AUD in USD. */
  audToUsd: number;
  asOf: string;
  live: boolean;
};

// Rough fallback (≈ mid-2026) if the FX API is unavailable. AUD is weak vs USD.
const FALLBACK_USD = { AUD: 1.53, EUR: 0.92, GBP: 0.79 };

// 15 minutes: the dominant USD→AUD leg is LIVE (Mboum hourly FX candles), so
// short caching keeps the portfolio value tracking IBKR's intraday marks.
const TTL_MS = 15 * 60 * 1000;
let cache: { at: number; rates: FxRates } | null = null;

/**
 * Live AUD/USD from Mboum's FX candles (AUDUSD=X, hourly — Yahoo CCY feed).
 * Returns 1 USD in AUD, or null on any failure.
 */
async function liveUsdToAud(): Promise<number | null> {
  try {
    const { getStockHistory, isMboumConfigured } = await import("@/lib/mboum");
    if (!isMboumConfigured()) return null;
    const candles = await getStockHistory("AUDUSD=X", { interval: "1h", days: 5 });
    const last = candles[candles.length - 1];
    if (!last || last.close <= 0) return null;
    return 1 / last.close; // AUDUSD=X quotes 1 AUD in USD
  } catch {
    return null;
  }
}

function build(ratesPerUsd: { AUD: number; EUR: number; GBP: number }, live: boolean, asOf: string): FxRates {
  const usdToAud = ratesPerUsd.AUD;
  const toAud: Record<string, number> = {
    AUD: 1,
    USD: usdToAud,
    // 1 EUR = (USD→AUD) / (USD→EUR) AUD, etc.
    EUR: usdToAud / ratesPerUsd.EUR,
    GBP: usdToAud / ratesPerUsd.GBP,
  };
  return { toAud, usdToAud, audToUsd: 1 / usdToAud, asOf, live };
}

export async function getFxRates(): Promise<FxRates> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rates;

  // Daily ECB reference for the EUR/GBP crosses (small cash balances)…
  let perUsd = { ...FALLBACK_USD };
  let live = false;
  let asOf = new Date().toISOString();
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=AUD,EUR,GBP",
      { next: { revalidate: 21600 } }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        date?: string;
        rates?: { AUD?: number; EUR?: number; GBP?: number };
      };
      const r = data.rates ?? {};
      if (r.AUD && r.EUR && r.GBP) {
        perUsd = { AUD: r.AUD, EUR: r.EUR, GBP: r.GBP };
        live = true;
        asOf = data.date ?? asOf;
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[fx] frankfurter unavailable:", (err as Error).message);
    }
  }

  // …but the DOMINANT USD→AUD leg gets a live intraday override so the
  // portfolio value tracks the broker's marks, not yesterday's fix.
  const intraday = await liveUsdToAud();
  if (intraday != null) {
    perUsd.AUD = intraday;
    live = true;
    asOf = new Date().toISOString();
  }

  const rates = build(perUsd, live, asOf);
  cache = { at: now, rates };
  return rates;
}

/** Convert an amount in `currency` to AUD using the supplied rates. */
export function toAud(amount: number, currency: string, rates: FxRates): number {
  const factor = rates.toAud[currency.toUpperCase()] ?? rates.usdToAud;
  return amount * factor;
}
