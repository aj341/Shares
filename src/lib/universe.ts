/**
 * Screening universe: ~40 liquid Nasdaq-100 large caps across software,
 * semiconductors, internet and consumer tech. Plain data — no fetching.
 *
 * Portfolio holdings (MSFT/GOOG/PLTR/MDB/NBIS/RBLX) may appear here; they are
 * excluded from the screen OUTPUT at read time (see getTopRanked in
 * watchlist-screen.ts), not from the scan itself, so their ranks still
 * contribute to the cross-sectional z-scores.
 */

export type UniverseEntry = {
  ticker: string;
  companyName: string;
  subSectors: string[];
};

export const UNIVERSE: UniverseEntry[] = [
  // --- Semiconductors / AI hardware ---
  { ticker: "NVDA", companyName: "NVIDIA Corporation", subSectors: ["AI Infrastructure", "Semiconductors"] },
  { ticker: "AVGO", companyName: "Broadcom Inc.", subSectors: ["AI Networking", "Custom Silicon", "Semiconductors"] },
  { ticker: "AMD", companyName: "Advanced Micro Devices, Inc.", subSectors: ["AI Semiconductors", "High-Performance Computing"] },
  { ticker: "QCOM", companyName: "QUALCOMM Incorporated", subSectors: ["Mobile Silicon", "Edge AI", "Semiconductors"] },
  { ticker: "TXN", companyName: "Texas Instruments Incorporated", subSectors: ["Analog Semiconductors", "Industrial"] },
  { ticker: "AMAT", companyName: "Applied Materials, Inc.", subSectors: ["Semiconductor Equipment"] },
  { ticker: "LRCX", companyName: "Lam Research Corporation", subSectors: ["Semiconductor Equipment"] },
  { ticker: "KLAC", companyName: "KLA Corporation", subSectors: ["Semiconductor Equipment", "Process Control"] },
  { ticker: "MU", companyName: "Micron Technology, Inc.", subSectors: ["Memory", "AI Storage", "Semiconductors"] },
  { ticker: "ASML", companyName: "ASML Holding N.V.", subSectors: ["Lithography", "Semiconductor Equipment"] },
  { ticker: "ARM", companyName: "Arm Holdings plc", subSectors: ["Semiconductor IP", "Edge AI"] },
  { ticker: "MRVL", companyName: "Marvell Technology, Inc.", subSectors: ["AI Networking", "Custom Silicon"] },
  { ticker: "NXPI", companyName: "NXP Semiconductors N.V.", subSectors: ["Automotive Silicon", "Embedded"] },
  { ticker: "ADI", companyName: "Analog Devices, Inc.", subSectors: ["Analog Semiconductors", "Industrial"] },
  { ticker: "INTC", companyName: "Intel Corporation", subSectors: ["CPUs", "Foundry", "Semiconductors"] },

  // --- Software ---
  { ticker: "MSFT", companyName: "Microsoft Corporation", subSectors: ["Cloud", "AI Platforms", "Enterprise Software"] },
  { ticker: "ADBE", companyName: "Adobe Inc.", subSectors: ["Creative Software", "AI Tools"] },
  { ticker: "INTU", companyName: "Intuit Inc.", subSectors: ["Fintech Software", "SMB Platforms"] },
  { ticker: "PANW", companyName: "Palo Alto Networks, Inc.", subSectors: ["Cybersecurity", "AI Security Platform"] },
  { ticker: "CRWD", companyName: "CrowdStrike Holdings, Inc.", subSectors: ["AI-Native Cybersecurity", "Cloud Security Platform"] },
  { ticker: "FTNT", companyName: "Fortinet, Inc.", subSectors: ["Network Security", "Cybersecurity"] },
  { ticker: "ZS", companyName: "Zscaler, Inc.", subSectors: ["Zero Trust Security", "Cloud Security"] },
  { ticker: "DDOG", companyName: "Datadog, Inc.", subSectors: ["Observability", "Cloud Software"] },
  { ticker: "TEAM", companyName: "Atlassian Corporation", subSectors: ["Collaboration Software", "DevTools"] },
  { ticker: "WDAY", companyName: "Workday, Inc.", subSectors: ["Enterprise SaaS", "HR/Finance Software"] },
  { ticker: "SNPS", companyName: "Synopsys, Inc.", subSectors: ["EDA Software", "Semiconductor Design"] },
  { ticker: "CDNS", companyName: "Cadence Design Systems, Inc.", subSectors: ["EDA Software", "Semiconductor Design"] },

  // --- Internet / platforms ---
  { ticker: "GOOGL", companyName: "Alphabet Inc.", subSectors: ["Search", "Cloud", "AI Platforms"] },
  { ticker: "AMZN", companyName: "Amazon.com, Inc.", subSectors: ["Cloud Infrastructure", "AI Services", "E-commerce"] },
  { ticker: "META", companyName: "Meta Platforms, Inc.", subSectors: ["AI-Powered Social", "Digital Advertising", "Open AI Models"] },
  { ticker: "NFLX", companyName: "Netflix, Inc.", subSectors: ["Streaming", "Consumer Internet"] },
  { ticker: "BKNG", companyName: "Booking Holdings Inc.", subSectors: ["Online Travel", "Consumer Internet"] },
  { ticker: "ABNB", companyName: "Airbnb, Inc.", subSectors: ["Online Travel", "Marketplaces"] },
  { ticker: "MELI", companyName: "MercadoLibre, Inc.", subSectors: ["E-commerce", "Fintech", "LatAm Internet"] },
  { ticker: "PDD", companyName: "PDD Holdings Inc.", subSectors: ["E-commerce", "Consumer Internet"] },

  // --- Consumer tech / other large caps ---
  { ticker: "AAPL", companyName: "Apple Inc.", subSectors: ["Consumer Hardware", "Services", "Edge AI"] },
  { ticker: "TSLA", companyName: "Tesla, Inc.", subSectors: ["EVs", "Autonomy", "Energy"] },
  { ticker: "COST", companyName: "Costco Wholesale Corporation", subSectors: ["Consumer Staples", "Retail"] },
  { ticker: "CSCO", companyName: "Cisco Systems, Inc.", subSectors: ["Networking", "Enterprise Infrastructure"] },
  { ticker: "PYPL", companyName: "PayPal Holdings, Inc.", subSectors: ["Payments", "Fintech"] },
];

/** Lookup by ticker for enrichment of screened candidates. */
export function universeEntryFor(ticker: string): UniverseEntry | null {
  return UNIVERSE.find((u) => u.ticker === ticker) ?? null;
}
