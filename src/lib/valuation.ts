import "server-only";
import { MBOUM_BASE_URL } from "@/lib/constants";

/**
 * Valuation / P-E context data source (Mboum).
 *
 * Provides two scoring cells used by the live-metrics grid:
 *   - band     "Valuation band vs peers/history" — driven by pegRatio (preferred)
 *              or trailingPE thresholds.
 *   - multiple "Multiple expansion/compression"  — forwardPE vs trailingPE.
 *
 * Auth: `Authorization: Bearer <MBOUM_API_KEY>` against https://api.mboum.com/v1
 * Source module: `default-key-statistics` (returns forwardPE, pegRatio, trailingEps;
 * note trailingPE is frequently null in the feed — handled gracefully).
 */

export type ValCell = [string | number, "positive" | "neutral" | "negative"];

/** Mboum wraps numbers as { raw, fmt }; pull the numeric value. */
type RawNum = { raw?: number; fmt?: string } | number | unknown[] | null | undefined;

function num(v: RawNum): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return null;
  const raw = (v as { raw?: number }).raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[valuation] request failed:", (err as Error).message);
    }
    return null;
  }
}

type KeyStatsBody = {
  trailingPE?: RawNum;
  forwardPE?: RawNum;
  pegRatio?: RawNum;
};

/**
 * Fetch valuation context for a ticker. Returns null only on total failure
 * (missing key / no usable data); otherwise always returns both cells, falling
 * back to neutral/Stable defaults when individual metrics are unavailable.
 */
export async function getValuationContext(
  ticker: string
): Promise<{ band: ValCell; multiple: ValCell } | null> {
  const key = process.env.MBOUM_API_KEY?.trim();
  if (!key) return null;

  const url = new URL(`${MBOUM_BASE_URL}/markets/stock/modules`);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("module", "default-key-statistics");

  const body = await safe(async () => {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      next: { revalidate: 60 * 60 * 6 }, // ~6h
    });
    if (!res.ok) {
      throw new Error(`Mboum valuation request failed (${res.status})`);
    }
    const json = (await res.json()) as { body?: KeyStatsBody };
    return json.body ?? null;
  });

  if (!body) return null;

  const trailingPE = num(body.trailingPE);
  const forwardPE = num(body.forwardPE);
  const pegRatio = num(body.pegRatio);

  // No usable valuation data at all → treat as total failure.
  if (trailingPE === null && forwardPE === null && pegRatio === null) {
    return null;
  }

  return {
    band: computeBand(trailingPE, pegRatio),
    multiple: computeMultiple(trailingPE, forwardPE),
  };
}

/**
 * Valuation band: prefer pegRatio when present, else fall back to trailingPE.
 *   pegRatio < 1               → positive ("PEG 0.8")
 *   pegRatio > 2 OR trailingPE > 45 → negative ("Rich")
 *   else                       → neutral  ("In line")
 */
function computeBand(trailingPE: number | null, pegRatio: number | null): ValCell {
  if (pegRatio !== null) {
    if (pegRatio < 1) return [`PEG ${round1(pegRatio)}`, "positive"];
    if (pegRatio > 2) return ["Rich", "negative"];
    return ["In line", "neutral"];
  }
  if (trailingPE !== null) {
    if (trailingPE > 45) return ["Rich", "negative"];
    return [`P/E ${round1(trailingPE)}`, "neutral"];
  }
  return ["In line", "neutral"];
}

/**
 * Multiple expansion/compression: compare forwardPE vs trailingPE.
 *   forwardPE meaningfully < trailingPE → "Compressing" positive
 *   forwardPE meaningfully > trailingPE → "Expanding"  negative
 *   ~equal                              → "Stable"     neutral
 * If only one PE is available, return ["Stable", "neutral"].
 */
function computeMultiple(trailingPE: number | null, forwardPE: number | null): ValCell {
  if (trailingPE === null || forwardPE === null) return ["Stable", "neutral"];

  // "Meaningful" = a >5% difference relative to the trailing multiple.
  const threshold = Math.abs(trailingPE) * 0.05;
  const delta = forwardPE - trailingPE;

  if (delta < -threshold) return ["Compressing", "positive"];
  if (delta > threshold) return ["Expanding", "negative"];
  return ["Stable", "neutral"];
}

function round1(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}
