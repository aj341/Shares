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

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cache: { at: number; rates: FxRates } | null = null;

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

  let rates: FxRates;
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=AUD,EUR,GBP",
      { next: { revalidate: 21600 } }
    );
    if (!res.ok) throw new Error(`frankfurter ${res.status}`);
    const data = (await res.json()) as {
      date?: string;
      rates?: { AUD?: number; EUR?: number; GBP?: number };
    };
    const r = data.rates ?? {};
    if (!r.AUD || !r.EUR || !r.GBP) throw new Error("incomplete FX payload");
    rates = build({ AUD: r.AUD, EUR: r.EUR, GBP: r.GBP }, true, data.date ?? new Date().toISOString());
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[fx] using fallback rates:", (err as Error).message);
    }
    rates = build(FALLBACK_USD, false, new Date().toISOString());
  }

  cache = { at: now, rates };
  return rates;
}

/** Convert an amount in `currency` to AUD using the supplied rates. */
export function toAud(amount: number, currency: string, rates: FxRates): number {
  const factor = rates.toAud[currency.toUpperCase()] ?? rates.usdToAud;
  return amount * factor;
}
