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

/**
 * Provenance of the data behind a holding's score/signal.
 * - "live": real quote + real computed metrics.
 * - "degraded": app is in live mode but a real feed failed; mock/stale values
 *   are shown for display ONLY — the holding is forced to HOLD and excluded
 *   from trade recommendations and alerts.
 * - "mock": the whole app is in mock mode (no API keys, dev).
 */
export type DataQuality = "live" | "degraded" | "mock";

export type Holding = {
  ticker: string;
  companyName: string;
  shares: number;
  entryPrice: number;
  currentPrice: number;
  dayChangePct: number;
  dataQuality: DataQuality;
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
  /** Regime-aware cash buffer used for this plan (fraction, e.g. 0.05). */
  targetCashBufferPct?: number;
  /** Human label of the market regime that set the buffer. */
  regimeLabel?: string;
};

// ---------------------------------------------------------------------------
// API envelopes
// ---------------------------------------------------------------------------

/** One currency bucket's cash, expressed as its AUD market value. */
export type CashBalance = {
  currency: string;
  amountAud: number;
};

export type PortfolioResponse = {
  holdings: Holding[];
  /** Combined cash in the display currency (AUD). */
  cash: number;
  totalPortfolioValue: number;
  totalCostBasis: number;
  totalUnrealisedPnl: number;
  totalUnrealisedPnlPct: number;
  asOf: string;
  source: DataSource;
  /** Display currency for values/cash (per-share prices stay in USD). */
  displayCurrency: string;
  /** Per-currency cash breakdown (for the dedicated Cash section). */
  cashBalances: CashBalance[];
  /** 1 USD in AUD, used to convert USD-priced holdings for display. */
  fxUsdToAud: number;
  /** Whether the FX rate is live (vs static fallback). */
  fxLive: boolean;
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
  // (currency fields below the aliases)
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

  // Currency / cash (additive).
  displayCurrency: string;
  cashBalances: CashBalance[];
  fxUsdToAud: number;
  fxLive: boolean;
};

/** One row of the performance chart: a date plus rebased % returns per series. */
export type PerformancePoint = { date: string } & Record<string, number>;

export type PerformanceResponse = {
  /** Rebased to 0% at the start of the window. Includes a "Portfolio" series. */
  series: PerformancePoint[];
  /** Absolute market value per date, in AUD (for the $ view). Same dates as `series`. */
  seriesValue: PerformancePoint[];
  /** Currency of seriesValue (AUD). */
  valueCurrency: string;
  tickers: string[];
  /** The range key this series was built for (e.g. "6M"). */
  range: string;
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

// ---------------------------------------------------------------------------
// Daily AI Brief + Catalyst Radar
// ---------------------------------------------------------------------------

/** One upcoming catalyst (earnings/dividend) for a holding or watchlist name. */
export type CatalystItem = {
  ticker: string;
  type: string;
  date: string;
  detail: string;
  daysAway: number;
};

export type BriefWatchItem = {
  ticker: string;
  urgency: "high" | "medium" | "low";
  note: string;
};

export type DailyBrief = {
  generatedAt: string;
  /** Overall posture for the book today. */
  stance: "risk-on" | "neutral" | "risk-off" | "mixed";
  headline: string;
  /** 2–4 sentence narrative. */
  summary: string;
  watchItems: BriefWatchItem[];
  /** Nearest upcoming catalysts across the book. */
  catalysts: CatalystItem[];
  source: "llm" | "heuristic";
  hasData: boolean;
  disclaimer: string;
};

// ---------------------------------------------------------------------------
// Conversational assistant ("Ask")
// ---------------------------------------------------------------------------

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AssistantResponse = {
  reply: string;
  /** "llm" when answered by Claude; "unavailable" when the key is unset. */
  source: "llm" | "unavailable";
};

export type PnlPeriod = "daily" | "weekly" | "monthly" | "total";

export type PnlByPeriod = Record<PnlPeriod, { value: number; pct: number }>;

// ---------------------------------------------------------------------------
// Per-stock technicals (Stocks tab) — computed from Mboum history + modules
// ---------------------------------------------------------------------------

export type StockTechnicals = {
  ticker: string;
  rsi: number | null;
  ma20: number | null;
  ma50: number | null;
  priceVsMa20: "above" | "below" | null;
  priceVsMa50: "above" | "below" | null;
  week52High: number | null;
  week52Low: number | null;
  peRatio: number | null;
  targetMean: number | null;
  targetUpsidePct: number | null;
  bullishPct: number | null;
  analystConsensus: "bullish" | "neutral" | "bearish" | "mixed" | null;
  /** Recent close prices for the sparkline (ascending). */
  sparkline: number[];
};

export type StocksResponse = {
  byTicker: Record<string, StockTechnicals>;
  asOf: string;
  source: "mboum" | "none";
};

// ---------------------------------------------------------------------------
// Watchlist (suggested additions)
// ---------------------------------------------------------------------------

export type WatchlistBucket = "best_entry" | "neutral" | "overbought";

export type AnalystAction = {
  firm: string;
  action: string; // e.g. "raised target to $275"
  date: string;
};

export type WatchlistItem = {
  ticker: string;
  companyName: string;
  sector: string;
  subSectors: string[];
  price: number | null;
  upsidePct: number | null;
  rsi: number | null;
  targetMean: number | null;
  peRatio: number | null;
  bullishPct: number | null;
  analystRating: string | null;
  week52High: number | null;
  week52Low: number | null;
  bucket: WatchlistBucket;
  signalLabel: string;
  // Editorial (curated, sourced framing — not financial advice)
  whyItFits: string;
  bullCase: string;
  keyRisk: string;
  technicalSignal: string;
  recentAnalystActions: AnalystAction[];
};

export type WatchlistResponse = {
  items: WatchlistItem[];
  suggestionsCount: number;
  avgUpsidePct: number | null;
  bestEntry: string[];
  asOf: string;
  source: "mboum" | "none";
};

// ---------------------------------------------------------------------------
// Article Impact Analyzer
// ---------------------------------------------------------------------------

export type ImpactScore = -3 | -2 | -1 | 0 | 1 | 2 | 3;

export type ArticleImpactAnalysis = {
  url: string;
  canonicalUrl?: string;
  source?: string;
  headline: string;
  publishDate?: string;
  author?: string;
  detectedTickers: string[];
  selectedTicker: string;
  summaryBullets: string[];
  executiveSentiment: {
    hasExecComments: boolean;
    tone: ExecTone;
    keyPoints: string[];
  };
  storyVsFinancials: {
    financialsSupportStory: "yes" | "partly" | "no" | "unclear";
    notes: string;
  };
  outsideResearch: {
    thesisChange:
      | "confirming"
      | "incremental"
      | "material"
      | "overhyped"
      | "underappreciated";
    supportingPoints: string[];
    conflictingPoints: string[];
  };
  impactAssessment: {
    verdict: "positive" | "neutral" | "negative" | "mixed";
    impactScore: ImpactScore;
    timeHorizon: "intraday" | "short_term" | "medium_term" | "long_term";
    expectedMarketSensitivity: "low" | "medium" | "high";
    confidence: "low" | "medium" | "high";
    actionHint: "buy" | "hold" | "trim" | "sell" | "watch";
    rationale: string;
  };
  followUp: string[];
  /** "llm" when synthesized by Claude, "heuristic" when rule-based fallback. */
  engine: "llm" | "heuristic";
  createdAt: string;
};

export type PortfolioAlert = {
  ticker: string;
  kind:
    | "signal_change"
    | "rsi_extreme"
    | "high_impact_news"
    | "near_cap"
    | "watchlist_entry"
    | "earnings_imminent";
  message: string;
  severity: "info" | "warning" | "critical";
};

export type ExtractedArticle = {
  url: string;
  canonicalUrl?: string;
  source?: string;
  headline: string;
  author?: string;
  publishDate?: string;
  body: string;
};

export type TickerDetection = {
  primary: string | null;
  detected: string[];
  /** ticker -> mention count, for ranking/secondary display */
  counts: Record<string, number>;
};
