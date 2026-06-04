import "server-only";
import type { TickerDetection } from "@/lib/types";

/**
 * Heuristic ticker detection from article text. Combines three signals:
 *  1. Explicit cashtags ($MSFT) and exchange refs (NASDAQ: MSFT) — high weight.
 *  2. Company-name aliases (case-insensitive) — medium weight.
 *  3. Bare uppercase ticker tokens (case-sensitive) — low weight.
 * Title mentions are weighted ~3x. Returns the ranked primary + all detected.
 */

const DICTIONARY: Record<string, string[]> = {
  MSFT: ["microsoft"],
  GOOGL: ["alphabet", "google"],
  GOOG: ["alphabet", "google"],
  RBLX: ["roblox"],
  PLTR: ["palantir"],
  MDB: ["mongodb", "mongo db"],
  NBIS: ["nebius"],
  NVDA: ["nvidia"],
  AVGO: ["broadcom"],
  AMD: ["advanced micro devices", "amd"],
  CRWD: ["crowdstrike"],
  AMZN: ["amazon", "amazon.com", "aws"],
  META: ["meta platforms", "facebook", "instagram"],
  AXON: ["axon enterprise", "axon"],
  PANW: ["palo alto networks", "palo alto"],
  AAPL: ["apple"],
  TSLA: ["tesla"],
  NFLX: ["netflix"],
  ORCL: ["oracle"],
  ARM: ["arm holdings"],
  SNOW: ["snowflake"],
  INTC: ["intel"],
  IBM: ["ibm", "international business machines"],
  ADBE: ["adobe"],
  CRM: ["salesforce"],
  UBER: ["uber"],
  SHOP: ["shopify"],
};

const ALL_TICKERS = Object.keys(DICTIONARY);

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export function detectTickers(headline: string, body: string): TickerDetection {
  const titleLc = headline.toLowerCase();
  const bodyLc = body.toLowerCase();
  const full = `${headline}\n${body}`;
  const fullLc = `${titleLc}\n${bodyLc}`;

  const counts: Record<string, number> = {};

  // 1. Explicit cashtags + exchange references (strong).
  const explicit = new Set<string>();
  for (const m of full.matchAll(/\$([A-Z]{1,5})\b/g)) explicit.add(m[1]);
  for (const m of full.matchAll(/\b(?:NASDAQ|NYSE|NYSEARCA|AMEX)\s*[:\-]?\s*([A-Z]{1,5})\b/g))
    explicit.add(m[1]);

  for (const t of ALL_TICKERS) {
    let score = 0;

    if (explicit.has(t)) score += 8;

    // 2. Company-name aliases (case-insensitive, word boundary).
    for (const alias of DICTIONARY[t]) {
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      const titleHits = countMatches(titleLc, re);
      const bodyHits = countMatches(bodyLc, re);
      score += titleHits * 3 + bodyHits;
    }

    // 3. Bare uppercase ticker token (case-sensitive to avoid common words).
    const tickerRe = new RegExp(`\\b${t}\\b`, "g");
    const titleTk = countMatches(headline, tickerRe);
    const bodyTk = countMatches(body, tickerRe);
    score += titleTk * 3 + bodyTk;

    if (score > 0) counts[t] = score;
  }

  // Collapse GOOG/GOOGL duplicates → keep the higher.
  if (counts.GOOG && counts.GOOGL) {
    counts.GOOGL = Math.max(counts.GOOGL, counts.GOOG);
    delete counts.GOOG;
  }

  const detected = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return { primary: detected[0] ?? null, detected, counts };
}
