/**
 * Canonical data contracts for the Shares dashboard.
 *
 * These types are the single source of truth shared by the API routes,
 * the scoring / redistribution / announcement engines, and the UI.
 * Do not redefine these shapes elsewhere — import from here.
 */

// ---------------------------------------------------------------------------
// Core domain
// ---------------------------------------------------------------------------

export type Signal = "STRONG_BUY" | "BUY" | "HOLD" | "TRIM" | "SELL";

export type MetricCategory =
  | "trend"
  | "momentum"
  | "valuation"
  | "fundamental"
  | "risk"
  | "sentiment";

export type StatusTone = "positive" | "neutral" | "negative";

export type Metric = {
  name: string;
  value: string | number;
  category: MetricCategory;
  status: StatusTone;
  description: string;
};

export type AnnouncementType =
  | "earnings"
  | "filing"
  | "product"
  | "analyst"
  | "macro"
  | "other";

export type Announcement = {
  date: string;
  title: string;
  source: string;
  type: AnnouncementType;
  url?: string;
  summary: string;
  impact: StatusTone;
  /** Discrete impact magnitude, -3 (very negative) to +3 (very positive). */
  impactScore: number;
};

export type ExecTone =
  | "aligned"
  | "cautious"
  | "promotional"
  | "contradictory"
  | "no_signal";

export type ExecCommentary = {
  hasExecComments: boolean;
  tone: ExecTone;
  keyPoints: string[];
};

export type FactAlignment = {
  financialsSupportStory: "yes" | "partly" | "no" | "unclear";
  notes: string;
};

export type ResearchStatus = {
  ourResearchComplete: "yes" | "partial" | "no";
  recommendedFollowUp: string[];
};

export type StockVerdict = {
  summaryBullets: string[];
  verdict: StatusTone;
  /** Overall verdict impact, -3 to +3. */
  impactScore: number;
  thesisUpdate: string;
  marketReactionView: string;
  actionHint: "buy" | "hold" | "trim" | "sell" | "no_change";
  execCommentary: ExecCommentary;
  factAlignment: FactAlignment;
  researchStatus: ResearchStatus;
};

export type Holding = {
  ticker: string;
  companyName: string;
  shares: number;
  entryPrice: number;
  currentPrice: number;
  dayChangePct: number;
  costBasis: number;
  marketValue: number;
  unrealisedPnl: number;
  unrealisedPnlPct: number;
  portfolioWeight: number;
  score: number;
  signal: Signal;
  metrics: Metric[];
  announcements: Announcement[];
  verdict: StockVerdict;
};

// ---------------------------------------------------------------------------
// Analysis surfaces
// ---------------------------------------------------------------------------

export type DisagreementRow = {
  ticker: string;
  companyVerdict: StatusTone;
  companyImpactScore: number;
  execTone: ExecCommentary["tone"];
  analystConsensus: "bullish" | "neutral" | "bearish" | "mixed";
  analystTargetUpsidePct: number | null;
  ourScore: number;
  ourSignal: Holding["signal"];
  disagreementLevel: "low" | "medium" | "high";
  disagreementNotes: string;
};

export type TradeRecommendation = {
  action: "BUY" | "SELL" | "TRIM";
  ticker: string;
  shares: number;
  estimatedPrice: number;
  estimatedProceedsOrCost: number;
  estimatedRealisedPnl?: number;
  rationale: string;
};

export type AllocationSnapshot = {
  ticker: string;
  companyName: string;
  marketValue: number;
  weight: number;
};

export type RedistributionSummary = {
  totalProceeds: number;
  totalInvested: number;
  newCashBalance: number;
  maxWeightBefore: number;
  maxWeightAfter: number;
  tickersFullySold: string[];
};

// ---------------------------------------------------------------------------
// API envelopes
// ---------------------------------------------------------------------------

export type PortfolioResponse = {
  holdings: Holding[];
  cash: number;
  totalPortfolioValue: number;
  totalCostBasis: number;
  totalUnrealisedPnl: number;
  totalUnrealisedPnlPct: number;
  asOf: string;
  source: DataSource;
};

export type ScoresResponse = {
  scores: Array<{
    ticker: string;
    score: number;
    signal: Signal;
    breakdown: ScoreBreakdown;
  }>;
  asOf: string;
  source: DataSource;
};

export type AnnouncementsResponse = {
  byTicker: Record<
    string,
    { announcements: Announcement[]; verdict: StockVerdict }
  >;
  disagreement: DisagreementRow[];
  asOf: string;
  source: DataSource;
};

export type RedistributionResponse = {
  recommendations: TradeRecommendation[];
  before: AllocationSnapshot[];
  after: AllocationSnapshot[];
  summary: RedistributionSummary;
  asOf: string;
  source: DataSource;
};

export type DashboardKpis = {
  totalPortfolioValue: number;
  totalCostBasis: number;
  totalUnrealisedPnl: number;
  totalUnrealisedPnlPct: number;
  currentCash: number;
  holdingsCount: number;
  winRatePct: number;
  winners: number;
  losers: number;
  avgScore: number;
  bullishPct: number;
  mood: "Bullish" | "Neutral" | "Bearish";
  maxConcentration: number;
  safetyRating: number;
};

export type DashboardResponse = {
  // Nested shape (original — kept for backward compatibility).
  portfolio: PortfolioResponse;
  redistribution: RedistributionResponse;
  disagreement: DisagreementRow[];
  asOf: string;
  source: DataSource;

  // Normalized top-level aliases (additive — do not remove the nested fields).
  currentCash: number;
  totalPortfolioValue: number;
  holdings: Holding[];
  beforeAllocations: AllocationSnapshot[];
  afterAllocations: AllocationSnapshot[];
  tradeRecommendations: TradeRecommendation[];
  redistributionSummary: RedistributionSummary;
  disagreementRows: DisagreementRow[];
  kpis: DashboardKpis;
};

/** One row of the performance chart: a date plus rebased % returns per series. */
export type PerformancePoint = { date: string } & Record<string, number>;

export type PerformanceResponse = {
  /** Rebased to 0% at the start of the window. Includes a "Portfolio" series. */
  series: PerformancePoint[];
  tickers: string[];
  rangeLabel: string;
  hasData: boolean;
  /** "mboum" when real history loaded, "none" when unavailable. */
  source: "mboum" | "none";
  /** Portfolio P&L over daily/weekly/monthly windows + total (null when no history). */
  pnlByPeriod: PnlByPeriod | null;
  asOf: string;
};

// ---------------------------------------------------------------------------
// Scoring internals
// ---------------------------------------------------------------------------

export type ScoreBreakdown = {
  /** Raw 0-100 sub-score for each category before weighting. */
  categories: Record<MetricCategory, number>;
  /** Weighted contribution of each category to the final score. */
  weighted: Record<MetricCategory, number>;
  /** Score before override rules were applied. */
  rawScore: number;
  /** Human-readable list of overrides that fired. */
  overridesApplied: string[];
};

export type DataSource = "mock" | "finnhub" | "mboum";

export type ApiError = {
  error: string;
  detail?: string;
};

// ---------------------------------------------------------------------------
// Portfolio management — transaction ledger (source of truth)
// ---------------------------------------------------------------------------

export type TradeType = "BUY" | "SELL" | "ADJUSTMENT";

export type PortfolioTransaction = {
  id: string;
  ticker: string;
  companyName: string;
  tradeType: TradeType;
  shares: number;
  pricePerShare: number;
  grossAmount: number;
  fees: number;
  /** Negative for buys (cash out), positive for sells (cash in), delta for cash adjustments. */
  netCashImpact: number;
  tradeDate: string; // YYYY-MM-DD
  notes?: string;
  createdAt: string; // ISO timestamp
  /** True for the initial seeded positions — establishes shares without spending the opening cash. */
  opening?: boolean;
  /** For ADJUSTMENT rows: explicit override of shares / avg price (manual mode). */
  adjustment?: { shares: number; avgPrice: number };
};

export type PortfolioState = {
  currentCash: number;
  transactions: PortfolioTransaction[];
  holdings: Holding[];
};

/** What the file/DB repository persists. Holdings are derived, not stored. */
export type PersistedPortfolio = {
  openingCash: number;
  transactions: PortfolioTransaction[];
  archivedTickers: string[];
  seededAt: string;
};

/** A position folded out of the ledger, before market enrichment. */
export type DerivedPosition = {
  ticker: string;
  companyName: string;
  shares: number;
  entryPrice: number; // weighted average cost / share
  manuallyAdjusted: boolean;
  realisedPnl: number;
};

// ---------------------------------------------------------------------------
// Period P&L (daily / weekly / monthly / total)
// ---------------------------------------------------------------------------

export type PnlPeriod = "daily" | "weekly" | "monthly" | "total";

export type PnlByPeriod = Record<PnlPeriod, { value: number; pct: number }>;
