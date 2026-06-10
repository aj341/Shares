import type { Holding } from "@/lib/types";

/**
 * Thematic sector classification (not standard GICS — matches the dashboard's
 * AI/tech framing). Used by the Sector Allocation panel and the Stocks tab.
 */

export const SECTOR_BY_TICKER: Record<string, string> = {
  MSFT: "Cloud / AI",
  RBLX: "Gaming / Metaverse",
  GOOGL: "Ad Tech / AI",
  GOOG: "Ad Tech / AI",
  PLTR: "AI / Defense",
  MDB: "Cloud Database",
  NBIS: "AI Infrastructure",
  // Common watchlist names
  NVDA: "AI Infrastructure",
  AVGO: "Semiconductors",
  AMD: "Semiconductors",
  CRWD: "Cloud Security",
  AMZN: "Cloud / E-commerce",
  META: "AI / Social",
  AXON: "Defense / SaaS",
  ARM: "Semiconductors",
  // Screen universe — semis
  MU: "Semiconductors",
  INTC: "Semiconductors",
  LRCX: "Semiconductors",
  AMAT: "Semiconductors",
  KLAC: "Semiconductors",
  MRVL: "Semiconductors",
  TXN: "Semiconductors",
  ADI: "Semiconductors",
  ASML: "Semiconductors",
  NXPI: "Semiconductors",
  QCOM: "Semiconductors",
  // Screen universe — software / security
  ADBE: "Software",
  INTU: "Software",
  WDAY: "Software",
  SNPS: "Software",
  CDNS: "Software",
  DDOG: "Software",
  TEAM: "Software",
  PANW: "Cloud Security",
  FTNT: "Cloud Security",
  ZS: "Cloud Security",
  // Screen universe — internet / consumer
  NFLX: "Internet / Media",
  BKNG: "Internet / Travel",
  ABNB: "Internet / Travel",
  MELI: "Internet / E-commerce",
  PDD: "Internet / E-commerce",
  AAPL: "Consumer Tech",
  COST: "Consumer / Retail",
};

export function sectorFor(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "Other";
}

export type SectorSlice = {
  sector: string;
  weight: number; // % of total book incl. cash
  marketValue: number;
  tickers: string[];
};

/** Group holdings into sector slices, ranked by weight desc. */
export function groupBySector(holdings: Holding[]): SectorSlice[] {
  const map = new Map<string, SectorSlice>();
  for (const h of holdings) {
    const sector = sectorFor(h.ticker);
    const cur =
      map.get(sector) ?? { sector, weight: 0, marketValue: 0, tickers: [] };
    cur.weight += h.portfolioWeight;
    cur.marketValue += h.marketValue;
    cur.tickers.push(h.ticker);
    map.set(sector, cur);
  }
  return [...map.values()]
    .map((s) => ({ ...s, weight: Math.round(s.weight * 100) / 100 }))
    .sort((a, b) => b.weight - a.weight);
}
