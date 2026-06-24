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

  // --- Diversification candidates (added 2026-06-25) ---
  { ticker: "VLO", companyName: "Valero Energy", subSectors: ["Refiners", "Oil & Gas"] },
  { ticker: "LNG", companyName: "Cheniere Energy", subSectors: ["LNG Export", "Natural Gas"] },
  { ticker: "VG", companyName: "Venture Global", subSectors: ["LNG Export"] },
  { ticker: "EXE", companyName: "Expand Energy", subSectors: ["Natural Gas E&P"] },
  { ticker: "COP", companyName: "ConocoPhillips", subSectors: ["Oil & Gas E&P"] },
  { ticker: "SLB", companyName: "SLB", subSectors: ["Oilfield Services"] },
  { ticker: "XOM", companyName: "Exxon Mobil", subSectors: ["Integrated Oil & Gas"] },
  { ticker: "CCJ", companyName: "Cameco", subSectors: ["Uranium", "Nuclear Fuel"] },
  { ticker: "LEU", companyName: "Centrus Energy", subSectors: ["Uranium Enrichment", "HALEU"] },
  { ticker: "GS", companyName: "Goldman Sachs", subSectors: ["Investment Banking"] },
  { ticker: "MS", companyName: "Morgan Stanley", subSectors: ["Investment Banking", "Wealth"] },
  { ticker: "CME", companyName: "CME Group", subSectors: ["Exchanges", "Derivatives"] },
  { ticker: "MET", companyName: "MetLife", subSectors: ["Insurance"] },
  { ticker: "KKR", companyName: "KKR & Co.", subSectors: ["Alt Asset Management"] },
  { ticker: "UNH", companyName: "UnitedHealth Group", subSectors: ["Managed Care"] },
  { ticker: "ISRG", companyName: "Intuitive Surgical", subSectors: ["Surgical Robotics", "Medical Devices"] },
  { ticker: "TEM", companyName: "Tempus AI", subSectors: ["AI Diagnostics", "Health Data"] },
  { ticker: "HWM", companyName: "Howmet Aerospace", subSectors: ["Aero Components"] },
  { ticker: "GE", companyName: "GE Aerospace", subSectors: ["Jet Engines", "Aftermarket"] },
  { ticker: "GD", companyName: "General Dynamics", subSectors: ["Defense", "Shipbuilding"] },
  { ticker: "RTX", companyName: "RTX Corp", subSectors: ["Missiles", "Engines"] },
  { ticker: "RKLB", companyName: "Rocket Lab", subSectors: ["Space Launch"] },
  { ticker: "KTOS", companyName: "Kratos Defense", subSectors: ["Drones", "Autonomy"] },
  { ticker: "MP", companyName: "MP Materials", subSectors: ["Rare Earths", "Critical Minerals"] },
  { ticker: "SCCO", companyName: "Southern Copper", subSectors: ["Copper"] },
  { ticker: "FCX", companyName: "Freeport-McMoRan", subSectors: ["Copper"] },
  { ticker: "AEM", companyName: "Agnico Eagle Mines", subSectors: ["Gold"] },
  { ticker: "CDE", companyName: "Coeur Mining", subSectors: ["Silver", "Gold"] },
  { ticker: "HL", companyName: "Hecla Mining", subSectors: ["Silver"] },
  { ticker: "UUUU", companyName: "Energy Fuels", subSectors: ["Uranium", "Rare Earths"] },
  { ticker: "ALB", companyName: "Albemarle", subSectors: ["Lithium"] },
  { ticker: "GEV", companyName: "GE Vernova", subSectors: ["Power", "Grid", "Electrification"] },
  { ticker: "VRT", companyName: "Vertiv Holdings", subSectors: ["Data-Center Power", "Cooling"] },
  { ticker: "ETN", companyName: "Eaton", subSectors: ["Electrical Equipment"] },
  { ticker: "PWR", companyName: "Quanta Services", subSectors: ["Grid Construction"] },
  { ticker: "PH", companyName: "Parker Hannifin", subSectors: ["Motion & Control"] },
  { ticker: "DAL", companyName: "Delta Air Lines", subSectors: ["Airlines"] },
  { ticker: "ROST", companyName: "Ross Stores", subSectors: ["Off-Price Retail"] },
  { ticker: "TOL", companyName: "Toll Brothers", subSectors: ["Homebuilders"] },
  { ticker: "EAT", companyName: "Brinker International", subSectors: ["Restaurants"] },
  { ticker: "RCL", companyName: "Royal Caribbean", subSectors: ["Cruises", "Travel"] },
  { ticker: "WYNN", companyName: "Wynn Resorts", subSectors: ["Casinos", "Gaming"] },
  { ticker: "WING", companyName: "Wingstop", subSectors: ["Restaurants"] },
  { ticker: "PCG", companyName: "PG&E", subSectors: ["Electric Utility"] },
  { ticker: "ETR", companyName: "Entergy", subSectors: ["Electric Utility"] },
  { ticker: "AEP", companyName: "American Electric Power", subSectors: ["Electric Utility", "Transmission"] },
  { ticker: "NRG", companyName: "NRG Energy", subSectors: ["Independent Power"] },
  { ticker: "CEG", companyName: "Constellation Energy", subSectors: ["Nuclear Power"] },
  { ticker: "VST", companyName: "Vistra", subSectors: ["Independent Power"] },
  { ticker: "TLN", companyName: "Talen Energy", subSectors: ["Independent Power", "Nuclear"] },
  { ticker: "RDDT", companyName: "Reddit", subSectors: ["Social", "Digital Ads"] },
  { ticker: "ASTS", companyName: "AST SpaceMobile", subSectors: ["Satellite Telecom"] },
  { ticker: "VZ", companyName: "Verizon", subSectors: ["Telecom Carrier"] },
  { ticker: "T", companyName: "AT&T", subSectors: ["Telecom Carrier"] },
  { ticker: "TMUS", companyName: "T-Mobile US", subSectors: ["Telecom Carrier"] },
  { ticker: "TTWO", companyName: "Take-Two Interactive", subSectors: ["Gaming", "Entertainment"] },
  { ticker: "DIS", companyName: "Walt Disney", subSectors: ["Media", "Streaming"] },
  { ticker: "WELL", companyName: "Welltower", subSectors: ["Healthcare REIT", "Senior Housing"] },
  { ticker: "PSA", companyName: "Public Storage", subSectors: ["Self-Storage REIT"] },
  { ticker: "SPG", companyName: "Simon Property Group", subSectors: ["Retail REIT"] },
  { ticker: "PLD", companyName: "Prologis", subSectors: ["Industrial REIT", "Logistics"] },
  { ticker: "IRM", companyName: "Iron Mountain", subSectors: ["Data Storage REIT"] },
  { ticker: "DLR", companyName: "Digital Realty", subSectors: ["Data-Center REIT"] },
  { ticker: "EQIX", companyName: "Equinix", subSectors: ["Data-Center REIT"] },
];

/** Lookup by ticker for enrichment of screened candidates. */
export function universeEntryFor(ticker: string): UniverseEntry | null {
  return UNIVERSE.find((u) => u.ticker === ticker) ?? null;
}
