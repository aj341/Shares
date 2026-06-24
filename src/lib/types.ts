/**
 * Canonical data contracts for the Shares dashboard.
 *
 * These types are the single source of truth shared by the API routes,
 * the scoring / redistribution / announcement engines, and the UI.
 * Do not redefine these shapes elsewhere — import from here.
 */

// [sizing] Concentration assessment shape (type-only import; erased at runtime,
// so no module cycle). Defined in src/lib/concentration.ts.
import type { ConcentrationAssessment } from "@/lib/concentration";

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

// [factors] Additive cross-sectional dimension (relative strength + factors).
// These are OPTIONAL on Holding / WatchlistItem and never feed the existing
// 0-100 score or Signal. Computed at portfolio-build level where the full set
// (holdings + watchlist) is known. See src/lib/factors.ts.
export type RelativeStrength = {
  /** Trailing total return, fraction. 3M ~= 63 trading days, 6M ~= 126. */
  ret3m: number | null;
  ret6m: number | null;
  /** Stock return minus QQQ return over the same window (fraction). */
  vsQqq3m: number | null;
  vsQqq6m: number | null;
  /** Stock return minus sector-ETF return (null when no ETF mapped). */
  vsSector3m: number | null;
  vsSector6m: number | null;
  /** Sector ETF used for vsSector* (e.g. "SMH"); null when unmapped. */
  sectorEtf: string | null;
  /** 1-based cross-sectional rank by vsQqq6m (1 = strongest); null if unranked. */
  rank: number | null;
  /** 0-100 percentile of that rank (higher = stronger). */
  percentile: number | null;
  /** Size of the ranked set (holdings + watchlist). */
  universeSize: number;
};

export type FactorScores = {
  /** Each sub-factor 0-100 ("higher is better"); null when data is missing. */
  momentum: number | null;
  lowVol: number | null;
  value: number | null;
  quality: number | null;
  /** Equal-weight mean of available sub-factors, 0-100; null if none. */
  composite: number | null;
  /** Raw inputs kept for transparency. */
  momentumRaw: number | null;
  volRaw: number | null;
  /** Cross-sectional rank/percentile by composite (set during ranking). */
  compositeRank?: number | null;
  compositePercentile?: number | null;
};

export type Metric = {
  name: string;
  value: string | number;
  category: MetricCategory;
  status: StatusTone;
  description: string;
  // [factors] true for additive display-only rows (e.g. relative-strength /
  // factor rows). These render in the MetricGrid but MUST be excluded from
  // scoring/impact so the existing 0-100 score & Signal are never affected.
  additive?: boolean;
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

// [exthours] Current US market session + a real pre/post-market print. Both are
// ADDITIVE and OPTIONAL on Holding; they never affect score/signal. When the
// regular session is closed and a valid extended print exists, portfolio.ts
// surfaces it as currentPrice/dayChangePct and records the provenance here so
// the UI can show a session badge. Mirrors @/lib/market-session's MarketSession
// (kept structural here so shared types stay free of the server-only import).
export type MarketSessionLabel = "pre" | "regular" | "post" | "closed";

export type ExtendedHoursInfo = {
  /** Extended-hours last price (USD), > 0. */
  price: number;
  /** Extended-hours % change vs the regular-session close (null when underivable). */
  changePct: number | null;
  /** Which extended session this print came from. */
  session: "pre" | "post";
};

// ---------------------------------------------------------------------------
// [calibration] Conviction overlay (ADDITIVE)
// ---------------------------------------------------------------------------
//
// A purely additive, historically-derived "how much has this signal/band earned
// our trust" overlay. It NEVER changes the base score or signal. Attached
// optionally to Holding / WatchlistItem by portfolio.ts. Mirrors the runtime
// `Conviction` type in @/lib/calibration (kept structurally identical here so
// shared types stay free of the server-only calibration import). null-safe:
// always optional; absence means "calibration unavailable / not computed".
export type ConvictionLevel = "High" | "Medium" | "Low" | "Unproven";

export type ConvictionOverlay = {
  level: ConvictionLevel;
  /** 0..1 normalized conviction weight (0.5 = neutral). */
  weight: number;
  /** 0..1 historical win-rate of this signal/band at the horizon. */
  winRate: number;
  /** Mean forward return (fraction) of this signal/band at the horizon. */
  avgReturn: number;
  sampleSize: number;
  /** Horizon in calendar days the overlay was read at. */
  horizon: number;
  /** Whether the match came from the exact signal, the score band, or neither. */
  basis: "signal" | "band" | "none";
};

// ---------------------------------------------------------------------------
// [earnings] Earnings catalyst signal (ADDITIVE)
// ---------------------------------------------------------------------------
//
// Optional, display-only earnings overlay attached to Holding / WatchlistItem
// by portfolio.ts / watchlist.ts. NEVER affects the base score or Signal.
// Structurally identical to the runtime `EarningsSignal` type in
// @/lib/earnings-signals (kept here so shared types stay free of the
// server-only import). null-safe: every field is optional; absence means the
// corresponding sub-signal was unavailable.
export type RevisionTrend = "up" | "flat" | "down";
export type PeadSignal = "drift_up" | "drift_down" | "none";

export type EarningsSignal = {
  /** Next confirmed earnings date, YYYY-MM-DD. */
  nextDate?: string;
  /** Whole calendar days until nextDate. */
  daysUntil?: number;
  /** True when nextDate is within ~5 trading days (~7 calendar days). */
  inPrePositioningWindow?: boolean;
  /** Most recent reported quarter date, YYYY-MM-DD. */
  lastReportDate?: string;
  /** Surprise % on the last reported quarter (actual vs estimate). */
  lastSurprisePct?: number;
  /** Are forward EPS/revenue estimates being revised up / flat / down? */
  revisionTrend?: RevisionTrend;
  /** Post-earnings-drift bias derived from the last surprise + recency. */
  peadSignal?: PeadSignal;
};
// [earnings] end
// [insider] Insider cluster-buy overlay (ADDITIVE)
// ---------------------------------------------------------------------------
//
// A SLOW fundamental overlay derived from filtered open-market insider buys
// (10b5-1 / automatic sells, option exercises and grants are excluded). It is
// purely additive: it NEVER feeds the existing 0-100 score or BUY/HOLD/SELL
// Signal. Attached optionally to Holding / WatchlistItem by portfolio.ts /
// watchlist.ts. Mirrors the runtime `InsiderOverlay` in @/lib/insider (kept
// structurally identical so shared types stay free of the server-only import).
// null-safe: always optional; absence means "insider data not computed".
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

// [intraday] Intraday technicals + micro-regime overlay (ADDITIVE)
// ---------------------------------------------------------------------------
//
// Display-only daily-trader overlay computed from Mboum intraday bars: anchored
// /session VWAP, price-vs-VWAP state, short-period ATR (suggested stop +
// VWAP±k·ATR bands) and a per-symbol micro-regime. It NEVER feeds the existing
// 0-100 score or BUY/HOLD/SELL Signal. Attached optionally to Holding /
// WatchlistItem by portfolio.ts. Mirrors the runtime `IntradayOverlay` in
// @/lib/intraday (kept structurally identical so shared types stay free of the
// server-only import). null-safe: always optional; every field may be null.
export type IntradayMicroRegime = "trend_up" | "trend_down" | "chop";
export type IntradayVwapState =
  | "reclaim"
  | "lose"
  | "above"
  | "below"
  | "at"
  | null;

export type IntradayOverlay = {
  vwap: number | null;
  anchoredVwap: number | null;
  priceVsVwapPct: number | null;
  vwapState: IntradayVwapState;
  atr: number | null;
  atrPct: number | null;
  suggestedStop: number | null;
  bands: { lower: number | null; upper: number | null } | null;
  microRegime: IntradayMicroRegime | null;
  adx: number | null;
  realizedVol: number | null;
  interval: string;
  bars: number;
};
// [intraday] end

export type Holding = {
  ticker: string;
  companyName: string;
  shares: number;
  entryPrice: number;
  currentPrice: number;
  dayChangePct: number;
  // [exthours] Current US market session (when known) + the extended-hours print
  // that's driving currentPrice/dayChangePct (present only when an extended print
  // is being surfaced because the regular market is closed). Additive/null-safe.
  session?: MarketSessionLabel;
  extendedHours?: ExtendedHoursInfo;
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
  // [factors] Optional additive cross-sectional fields (null-safe).
  relativeStrength?: RelativeStrength;
  factors?: FactorScores;
  // [calibration] Optional conviction overlay (additive; null-safe).
  conviction?: ConvictionOverlay;
  // [earnings] Optional additive earnings catalyst overlay (null-safe).
  earnings?: EarningsSignal;
  // [insider] Optional insider cluster-buy overlay (additive; null-safe).
  insider?: InsiderOverlay;
  // [intraday] Optional intraday technicals + micro-regime overlay (additive; null-safe).
  intraday?: IntradayOverlay;
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
  /**
   * Watchlist candidates that competed for capital this run, with their
   * 20-metric scores — visible proof the new-position contest happened even
   * when no candidate cleared the BUY bar.
   */
  candidatesConsidered?: Array<{ ticker: string; score: number | null }>;
  // [sizing] Concentration assessment of the BEFORE book + active limits.
  // Additive/optional — present only when the engine ran with concentration on.
  concentration?: ConcentrationAssessment;
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

export type WatchlistBucket = "best_entry" | "momentum" | "neutral" | "overbought";

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
  /** Score on the SAME 20-metric engine as holdings (quality; bucket = timing). */
  engineScore: number | null;
  engineSignal: Signal | null;
  // Editorial (curated, sourced framing — not financial advice)
  whyItFits: string;
  bullCase: string;
  keyRisk: string;
  technicalSignal: string;
  recentAnalystActions: AnalystAction[];
  // [factors] Optional additive cross-sectional fields (null-safe).
  relativeStrength?: RelativeStrength;
  factors?: FactorScores;
  // [calibration] Optional conviction overlay (additive; null-safe).
  conviction?: ConvictionOverlay;
  // [earnings] Optional additive earnings catalyst overlay (null-safe).
  earnings?: EarningsSignal;
  // [insider] Optional insider cluster-buy overlay (additive; null-safe).
  insider?: InsiderOverlay;
  // [intraday] Optional intraday technicals + micro-regime overlay (additive; null-safe).
  intraday?: IntradayOverlay;
};

export type WatchlistResponse = {
  items: WatchlistItem[];
  suggestionsCount: number;
  avgUpsidePct: number | null;
  bestEntry: string[];
  asOf: string;
  source: "mboum" | "none";
  // [wlfilter] Full ranked set: EVERY scanned, non-held universe name (not the
  // bucketed `items` suggestions subset). Powers the sector/industry filter and
  // the full redistribution candidate path. Empty when no scan has run.
  all: WatchlistItem[];
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

// [news] Hard-catalyst news triage. Types live in src/lib/catalysts.ts (their
// home is the feature module, kept out of this shared file). Re-exported here
// as a convenience so consumers and sibling features can `import type` them
// from "@/lib/types". Note: the `news` signal these produce can feed the
// top-3 engine's `Top3SignalInputs.news` slot (a sibling marker feature) —
// pass NewsCatalyst[] / a derived score without changing existing math.
export type {
  CatalystType,
  CatalystDirection,
  CatalystMateriality,
  CatalystClassification,
  NewsCatalyst,
  CatalystsResult,
} from "@/lib/catalysts";

// [scanner] "Today's Battle List" gap scanner + economic-calendar awareness.
// ADDITIVE: types live in their feature modules (src/lib/scanner.ts and
// src/lib/econ-calendar.ts) and are re-exported here for convenience, mirroring
// the [news] block above. None of these feed the 0-100 score or BUY/HOLD/SELL
// Signal — the scanner only READS the existing additive factor / relative-
// strength / insider fields and blends them into a separate "battle score".
export type {
  BattleCandidate,
  ScannerResponse,
  ScannerDirection,
  OpeningRange,
} from "@/lib/scanner";
export type {
  EconEvent,
  EconCalendar,
  EconImpact,
  BlackoutWindow,
} from "@/lib/econ-calendar";
