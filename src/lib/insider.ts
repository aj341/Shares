import "server-only";
import { mboumFetch, isMboumConfigured } from "@/lib/mboum";

/**
 * Insider cluster-buy overlay (SLOW fundamental signal).
 *
 * Raw insider feeds are extremely noisy: most rows are planned 10b5-1 sales,
 * option exercises, tax-withholding dispositions and tiny gifts/awards. This
 * module exists to do the OPPOSITE of a fast trade trigger — it filters that
 * noise hard and only surfaces conviction OPEN-MARKET BUYING (or meaningful
 * net selling). It is purely additive: it never touches the 0-100 score or
 * the BUY/HOLD/SELL Signal. It is read at portfolio/watchlist build time and
 * attached to Holding.insider / WatchlistItem.insider, and exposed on
 * /api/insider for the overlay panel.
 *
 * Data source (Mboum, business plan):
 *   - Per ticker: GET /v1/markets/stock/modules?ticker=<T>&module=insider-transactions
 *     (Yahoo-style Form-4 detail: filerName, filerRelation, transactionText,
 *      value{raw}, shares{raw}, startDate{raw}). PRIMARY — cleanest per-name.
 *   - Cross-market sweep: GET /v1/markets/insider-trades?ticker=<T>&type=Buy&minValue=<N>
 *     (kept as a documented fallback; the global feed mixes congress/insider
 *      rows and only gives estimated USD midpoints, so it is secondary.)
 *
 * Everything degrades to `signal: "none"` when keys/data are missing — callers
 * must treat the overlay as optional.
 */

// ---------------------------------------------------------------------------
// Tunable thresholds (all overridable via env; safe defaults documented)
// ---------------------------------------------------------------------------

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Window (days) over which distinct buyers count toward a "cluster". */
export const INSIDER_CLUSTER_WINDOW_DAYS = envNum("INSIDER_CLUSTER_WINDOW_DAYS", 30);
/** Minimum USD value for a single transaction to count at all (kills noise). */
export const INSIDER_MIN_TXN_USD = envNum("INSIDER_MIN_TXN_USD", 25_000);
/** Distinct open-market buyers in the window required to call a cluster. */
export const INSIDER_CLUSTER_MIN_BUYERS = envNum("INSIDER_CLUSTER_MIN_BUYERS", 2);
/** A single CEO/CFO open-market buy at/above this size is treated as a cluster. */
export const INSIDER_BIG_BOSS_BUY_USD = envNum("INSIDER_BIG_BOSS_BUY_USD", 500_000);
/** Net BUY dollars to call a single "notable" buy (below cluster strength). */
export const INSIDER_NOTABLE_BUY_USD = envNum("INSIDER_NOTABLE_BUY_USD", 100_000);
/** Net SELL dollars (open-market, non-planned) to flag "selling". */
export const INSIDER_NOTABLE_SELL_USD = envNum("INSIDER_NOTABLE_SELL_USD", 250_000);
/** Only consider filings within this lookback (days). */
export const INSIDER_LOOKBACK_DAYS = envNum("INSIDER_LOOKBACK_DAYS", 120);

// ---------------------------------------------------------------------------
// Public shapes (mirror the optional fields added to types.ts)
// ---------------------------------------------------------------------------

export type InsiderSignal = "cluster_buy" | "notable_buy" | "selling" | "none";

export type InsiderOverlay = {
  signal: InsiderSignal;
  /** Distinct open-market buyers inside the cluster window. */
  buyerCount: number;
  /** Net open-market dollar flow over the lookback: + = buying, - = selling. */
  netDollar: number;
  /** ISO date (YYYY-MM-DD) of the most recent qualifying transaction, or null. */
  lastDate: string | null;
};

/** Normalised, already-filtered open-market transaction. */
type CleanTxn = {
  filer: string;
  relation: string;
  side: "buy" | "sell";
  usd: number;
  dateMs: number;
  isBoss: boolean;
};

// ---------------------------------------------------------------------------
// Mboum response shapes (defensive — fields are best-effort)
// ---------------------------------------------------------------------------

type RawNum = { raw?: number; fmt?: string } | number | null | undefined;
function num(v: RawNum): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw : null;
}

type ModuleTxn = {
  filerName?: string;
  filerRelation?: string;
  transactionText?: string;
  moneyText?: string;
  ownership?: string;
  startDate?: RawNum;
  value?: RawNum;
  shares?: RawNum;
};

type InsiderTxModule = {
  transactions?: ModuleTxn[];
};

// ---------------------------------------------------------------------------
// Classification helpers — the heart of the noise filter
// ---------------------------------------------------------------------------

const BOSS_RE = /\b(chief exec|ceo|chief financ|cfo|president|chair)\b/i;

/**
 * Decide whether a Form-4 row is a genuine OPEN-MARKET trade we care about.
 * Returns "buy" | "sell" | null (null = exclude: planned/automatic, options,
 * grants/awards, gifts, tax withholding, conversions, etc.).
 *
 * Yahoo/Mboum `transactionText` examples we exclude:
 *   "Sale (Automatic Sell)" / "10b5-1" plan sells, "Conversion/Exercise of
 *   Derivative Security", "Stock Award(Grant)", "Stock Gift", "Payment of
 *   Exercise Price or Tax Liability", "Disposition (Non Open Market)".
 */
function classify(text: string): "buy" | "sell" | null {
  const t = text.toLowerCase();

  // Hard exclusions — planned / automatic / non-open-market / derivative.
  if (/10b5-1|automatic/.test(t)) return null;
  if (/option|exercise|conversion|derivative|warrant/.test(t)) return null;
  if (/award|grant|gift|inheritance|bona fide/.test(t)) return null;
  if (/tax|withhold|payment of exercise/.test(t)) return null;
  if (/non open market|non-open market|disposition \(non/.test(t)) return null;

  // Open-market purchase.
  if (/purchase|\bbuy\b|open market buy|acquisition \(open/.test(t)) return "buy";
  // Open-market sale (after we've excluded automatic/planned above).
  if (/sale|sell|disposition/.test(t)) return "sell";

  return null;
}

/** USD value of a row: prefer explicit value, else shares * price-from-money. */
function txnUsd(t: ModuleTxn): number | null {
  const v = num(t.value);
  if (v != null && v > 0) return v;
  // moneyText can read like "Sale at $123.45 per share." — best effort only.
  const shares = num(t.shares);
  const m = t.moneyText?.match(/\$([\d,]+(?:\.\d+)?)/);
  if (shares != null && m) {
    const px = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(px) && px > 0) return Math.round(shares * px);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch + clean
// ---------------------------------------------------------------------------

async function fetchModuleTxns(ticker: string): Promise<ModuleTxn[]> {
  try {
    const res = await mboumFetch<{ body?: InsiderTxModule }>(
      "/markets/stock/modules",
      { ticker, module: "insider-transactions" },
      60 * 60 * 6 // cache 6h at the fetch layer — this is a SLOW overlay.
    );
    return res?.body?.transactions ?? [];
  } catch {
    return [];
  }
}

function cleanTxns(rows: ModuleTxn[]): CleanTxn[] {
  const cutoff = Date.now() - INSIDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const out: CleanTxn[] = [];
  for (const r of rows) {
    const side = classify(r.transactionText ?? "");
    if (!side) continue;
    const usd = txnUsd(r);
    if (usd == null || usd < INSIDER_MIN_TXN_USD) continue; // kill tiny-dollar.
    const dateRaw = num(r.startDate);
    const dateMs = dateRaw != null ? dateRaw * 1000 : NaN;
    if (!Number.isFinite(dateMs) || dateMs < cutoff) continue;
    const relation = r.filerRelation ?? "";
    out.push({
      filer: (r.filerName ?? "").trim() || "Insider",
      relation,
      side,
      usd,
      dateMs,
      isBoss: BOSS_RE.test(relation),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Pure signal logic over already-cleaned, open-market transactions. */
export function detectSignal(txns: CleanTxn[]): InsiderOverlay {
  if (txns.length === 0) {
    return { signal: "none", buyerCount: 0, netDollar: 0, lastDate: null };
  }

  const buys = txns.filter((t) => t.side === "buy");
  const sells = txns.filter((t) => t.side === "sell");
  const buyUsd = buys.reduce((s, t) => s + t.usd, 0);
  const sellUsd = sells.reduce((s, t) => s + t.usd, 0);
  const netDollar = Math.round(buyUsd - sellUsd);
  const lastDate = isoDate(Math.max(...txns.map((t) => t.dateMs)));

  // Distinct buyers inside the cluster window (anchored on the latest BUY).
  const latestBuyMs = buys.length ? Math.max(...buys.map((t) => t.dateMs)) : 0;
  const windowMs = INSIDER_CLUSTER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowBuyers = new Set(
    buys.filter((t) => latestBuyMs - t.dateMs <= windowMs).map((t) => t.filer.toLowerCase())
  );
  const buyerCount = windowBuyers.size;

  // Big-boss single buy short-circuits to a cluster-grade signal.
  const bigBossBuy = buys.some((t) => t.isBoss && t.usd >= INSIDER_BIG_BOSS_BUY_USD);

  let signal: InsiderSignal = "none";
  if (buyerCount >= INSIDER_CLUSTER_MIN_BUYERS || bigBossBuy) {
    signal = "cluster_buy";
  } else if (buyUsd >= INSIDER_NOTABLE_BUY_USD && buyUsd > sellUsd) {
    signal = "notable_buy";
  } else if (sellUsd >= INSIDER_NOTABLE_SELL_USD && netDollar < 0) {
    signal = "selling";
  }

  return { signal, buyerCount, netDollar, lastDate };
}

// ---------------------------------------------------------------------------
// Per-ticker overlay (cached) + batch
// ---------------------------------------------------------------------------

const CACHE = new Map<string, { ts: number; data: InsiderOverlay }>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — SLOW overlay, limit Mboum calls.

const NONE: InsiderOverlay = { signal: "none", buyerCount: 0, netDollar: 0, lastDate: null };

/** Insider overlay for one ticker. Null-safe; "none" when unavailable. */
export async function getInsiderOverlay(ticker: string): Promise<InsiderOverlay> {
  const key = ticker.toUpperCase();
  if (!isMboumConfigured()) return NONE;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  const rows = await fetchModuleTxns(key);
  const data = detectSignal(cleanTxns(rows));
  CACHE.set(key, { ts: Date.now(), data });
  return data;
}

/**
 * Batch overlay keyed by ticker. Used by portfolio.ts / watchlist.ts to attach
 * the additive `insider` field. Resilient: any per-ticker failure yields "none"
 * for that ticker and never rejects the whole batch.
 */
export async function getInsiderOverlays(
  tickers: string[]
): Promise<Record<string, InsiderOverlay>> {
  const uniq = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  const entries = await Promise.all(
    uniq.map(async (t) => [t, await getInsiderOverlay(t).catch(() => NONE)] as const)
  );
  return Object.fromEntries(entries);
}
