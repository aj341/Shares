import type {
  Announcement,
  Metric,
  MetricCategory,
  StatusTone,
  StockVerdict,
} from "@/lib/types";

/**
 * Mock data layer — used when DATA_SOURCE=mock (default) or when a live
 * provider call fails. Shapes match the contracts exactly so the UI and engines
 * behave identically against mock or live data.
 *
 * Prices are illustrative snapshots, not live quotes.
 */

export type AnalystView = {
  consensus: "bullish" | "neutral" | "bearish" | "mixed";
  targetUpsidePct: number | null;
};

// ---------------------------------------------------------------------------
// Quotes (current price + day change). entryPrice comes from constants.ts.
// ---------------------------------------------------------------------------

export const MOCK_QUOTES: Record<
  string,
  { currentPrice: number; dayChangePct: number }
> = {
  MSFT: { currentPrice: 498.12, dayChangePct: 0.84 },
  RBLX: { currentPrice: 74.6, dayChangePct: -2.1 },
  GOOGL: { currentPrice: 372.05, dayChangePct: 1.22 },
  GOOG: { currentPrice: 373.46, dayChangePct: 1.2 },
  PLTR: { currentPrice: 168.9, dayChangePct: 3.45 },
  MDB: { currentPrice: 341.18, dayChangePct: -1.4 },
  NBIS: { currentPrice: 245.7, dayChangePct: 2.05 },
};

export const MOCK_ANALYST: Record<string, AnalystView> = {
  MSFT: { consensus: "bullish", targetUpsidePct: 11.4 },
  RBLX: { consensus: "mixed", targetUpsidePct: 18.2 },
  GOOGL: { consensus: "bullish", targetUpsidePct: 9.1 },
  GOOG: { consensus: "bullish", targetUpsidePct: 9.1 },
  PLTR: { consensus: "mixed", targetUpsidePct: -6.5 },
  MDB: { consensus: "neutral", targetUpsidePct: 14.0 },
  NBIS: { consensus: "bullish", targetUpsidePct: 22.7 },
};

// ---------------------------------------------------------------------------
// Metric definitions — the canonical 20 metrics, in contract order.
// ---------------------------------------------------------------------------

type MetricDef = {
  name: string;
  category: MetricCategory;
  desc: Record<StatusTone, string>;
};

export const METRIC_DEFS: MetricDef[] = [
  // Trend (4)
  {
    name: "20d MA vs 50d MA",
    category: "trend",
    desc: {
      positive: "Short-term average above the 50d — near-term uptrend intact.",
      neutral: "20d and 50d averages are converging — direction unresolved.",
      negative: "20d average has crossed below the 50d — near-term weakness.",
    },
  },
  {
    name: "50d MA vs 200d MA",
    category: "trend",
    desc: {
      positive: "Golden-cross posture — primary trend is constructive.",
      neutral: "50d hovering around the 200d — no decisive primary trend.",
      negative: "Death-cross posture — primary trend is deteriorating.",
    },
  },
  {
    name: "Price vs 52-week range",
    category: "trend",
    desc: {
      positive: "Trading in the upper third of its 52-week range.",
      neutral: "Mid-range within its 52-week band.",
      negative: "Languishing in the lower third of its 52-week range.",
    },
  },
  {
    name: "Trend health",
    category: "trend",
    desc: {
      positive: "Higher highs and higher lows — clean trend structure.",
      neutral: "Choppy, range-bound price structure.",
      negative: "Lower highs and lower lows — broken trend structure.",
    },
  },
  // Momentum (4)
  {
    name: "RSI(14)",
    category: "momentum",
    desc: {
      positive: "RSI in a healthy 50–70 zone — momentum without exhaustion.",
      neutral: "RSI near 50 — balanced momentum.",
      negative: "RSI extended (>75) or weak (<35) — momentum risk.",
    },
  },
  {
    name: "MACD signal",
    category: "momentum",
    desc: {
      positive: "MACD above signal line with a widening histogram.",
      neutral: "MACD hugging the signal line — no clear cross.",
      negative: "MACD below signal line — bearish momentum.",
    },
  },
  {
    name: "Volume vs 30d average",
    category: "momentum",
    desc: {
      positive: "Above-average volume confirming the move.",
      neutral: "Volume tracking its 30-day average.",
      negative: "Thin volume — move lacks participation.",
    },
  },
  {
    name: "Short-term return",
    category: "momentum",
    desc: {
      positive: "Positive 1–4 week return, outpacing the index.",
      neutral: "Flat short-term return.",
      negative: "Negative short-term return, lagging the index.",
    },
  },
  // Valuation (4)
  {
    name: "Analyst target upside",
    category: "valuation",
    desc: {
      positive: "Mean target implies meaningful upside to current price.",
      neutral: "Mean target roughly in line with current price.",
      negative: "Price sits at or above the mean analyst target.",
    },
  },
  {
    name: "Valuation band vs peers/history",
    category: "valuation",
    desc: {
      positive: "Trading below its own history and peer median.",
      neutral: "Valuation broadly in line with peers and history.",
      negative: "Rich multiple versus peers and its own history.",
    },
  },
  {
    name: "Earnings surprise trend",
    category: "valuation",
    desc: {
      positive: "Consistent positive EPS surprises.",
      neutral: "Mixed surprise history.",
      negative: "Recent misses or guidance cuts.",
    },
  },
  {
    name: "Multiple expansion/compression",
    category: "valuation",
    desc: {
      positive: "Multiple compressing into growth — re-rating room.",
      neutral: "Stable multiple.",
      negative: "Multiple expanding faster than fundamentals — froth risk.",
    },
  },
  // Fundamental (3)
  {
    name: "Revenue growth trend",
    category: "fundamental",
    desc: {
      positive: "Accelerating or durable double-digit revenue growth.",
      neutral: "Steady but unspectacular revenue growth.",
      negative: "Decelerating revenue growth.",
    },
  },
  {
    name: "Margin trend",
    category: "fundamental",
    desc: {
      positive: "Expanding operating margins.",
      neutral: "Flat margin profile.",
      negative: "Margin compression.",
    },
  },
  {
    name: "Balance sheet / solvency proxy",
    category: "fundamental",
    desc: {
      positive: "Net cash, strong coverage — robust balance sheet.",
      neutral: "Manageable leverage.",
      negative: "Elevated leverage or weak coverage.",
    },
  },
  // Risk (3)
  {
    name: "Realised volatility",
    category: "risk",
    desc: {
      positive: "Below-peer realised volatility.",
      neutral: "Volatility in line with the sector.",
      negative: "Elevated realised volatility.",
    },
  },
  {
    name: "Drawdown behaviour",
    category: "risk",
    desc: {
      positive: "Shallow drawdowns with quick recoveries.",
      neutral: "Average drawdown profile.",
      negative: "Deep, slow-to-recover drawdowns.",
    },
  },
  {
    name: "Position size vs 35% cap",
    category: "risk",
    desc: {
      positive: "Comfortably within the 35% single-position cap.",
      neutral: "Approaching the 35% position cap.",
      negative: "At or above the 35% position cap.",
    },
  },
  // Sentiment (2)
  {
    name: "News / announcement sentiment",
    category: "sentiment",
    desc: {
      positive: "Recent news flow skews positive.",
      neutral: "Balanced or quiet news flow.",
      negative: "Recent news flow skews negative.",
    },
  },
  {
    name: "Insider / analyst revision proxy",
    category: "sentiment",
    desc: {
      positive: "Upward estimate revisions / insider buying.",
      neutral: "Stable estimates.",
      negative: "Downward estimate revisions / insider selling.",
    },
  },
];

// ---------------------------------------------------------------------------
// Per-ticker metric values, aligned by index to METRIC_DEFS (20 entries each).
// Tuple = [value, status].
// ---------------------------------------------------------------------------

type Cell = [string | number, StatusTone];

const METRIC_TABLE: Record<string, Cell[]> = {
  MSFT: [
    ["+2.1%", "positive"], ["+6.4%", "positive"], ["Upper third", "positive"], ["Higher highs", "positive"],
    [61, "positive"], ["Bullish cross", "positive"], ["1.1x avg", "neutral"], ["+4.2%", "positive"],
    ["+11.4%", "positive"], ["Peer median", "neutral"], ["4 beats", "positive"], ["Stable", "neutral"],
    ["+14% YoY", "positive"], ["Expanding", "positive"], ["Net cash", "positive"],
    ["Low", "positive"], ["Shallow", "positive"], ["18.4%", "positive"],
    ["Positive", "positive"], ["Upward", "positive"],
  ],
  RBLX: [
    ["-1.4%", "negative"], ["-2.0%", "negative"], ["Lower third", "negative"], ["Lower highs", "negative"],
    [42, "neutral"], ["Bearish cross", "negative"], ["0.8x avg", "negative"], ["-9.1%", "negative"],
    ["+18.2%", "positive"], ["Rich", "negative"], ["Mixed", "neutral"], ["Expanding", "negative"],
    ["+29% YoY", "positive"], ["Improving", "positive"], ["Net cash", "positive"],
    ["High", "negative"], ["Deep", "negative"], ["5.1%", "positive"],
    ["Negative", "negative"], ["Downward", "negative"],
  ],
  GOOGL: [
    ["+1.6%", "positive"], ["+5.1%", "positive"], ["Upper third", "positive"], ["Higher highs", "positive"],
    [58, "positive"], ["Bullish cross", "positive"], ["1.0x avg", "neutral"], ["+3.0%", "positive"],
    ["+9.1%", "positive"], ["Below history", "positive"], ["3 beats", "positive"], ["Stable", "neutral"],
    ["+13% YoY", "positive"], ["Expanding", "positive"], ["Net cash", "positive"],
    ["Low", "positive"], ["Shallow", "positive"], ["13.4%", "positive"],
    ["Positive", "positive"], ["Upward", "positive"],
  ],
  // Class C (GOOG) tracks the same underlying business as Class A (GOOGL).
  GOOG: [
    ["+1.6%", "positive"], ["+5.1%", "positive"], ["Upper third", "positive"], ["Higher highs", "positive"],
    [58, "positive"], ["Bullish cross", "positive"], ["1.0x avg", "neutral"], ["+3.0%", "positive"],
    ["+9.1%", "positive"], ["Below history", "positive"], ["3 beats", "positive"], ["Stable", "neutral"],
    ["+13% YoY", "positive"], ["Expanding", "positive"], ["Net cash", "positive"],
    ["Low", "positive"], ["Shallow", "positive"], ["13.4%", "positive"],
    ["Positive", "positive"], ["Upward", "positive"],
  ],
  PLTR: [
    ["+3.4%", "positive"], ["+8.9%", "positive"], ["Upper third", "positive"], ["Higher highs", "positive"],
    [79, "negative"], ["Bullish cross", "positive"], ["1.6x avg", "positive"], ["+22.0%", "positive"],
    ["-6.5%", "negative"], ["Very rich", "negative"], ["4 beats", "positive"], ["Expanding", "negative"],
    ["+27% YoY", "positive"], ["Expanding", "positive"], ["Net cash", "positive"],
    ["High", "negative"], ["Moderate", "neutral"], ["18.6%", "positive"],
    ["Positive", "positive"], ["Upward", "positive"],
  ],
  MDB: [
    ["-0.6%", "negative"], ["+0.4%", "neutral"], ["Mid-range", "neutral"], ["Choppy", "neutral"],
    [46, "neutral"], ["Flat", "neutral"], ["0.9x avg", "neutral"], ["-3.2%", "negative"],
    ["+14.0%", "positive"], ["Peer median", "neutral"], ["Mixed", "neutral"], ["Stable", "neutral"],
    ["+19% YoY", "positive"], ["Flat", "neutral"], ["Net cash", "positive"],
    ["Elevated", "negative"], ["Moderate", "neutral"], ["8.9%", "positive"],
    ["Neutral", "neutral"], ["Stable", "neutral"],
  ],
  NBIS: [
    ["+4.1%", "positive"], ["+10.2%", "positive"], ["Upper third", "positive"], ["Higher highs", "positive"],
    [67, "positive"], ["Bullish cross", "positive"], ["1.9x avg", "positive"], ["+13.2%", "positive"],
    ["+22.7%", "positive"], ["Rich", "negative"], ["2 beats", "positive"], ["Expanding", "negative"],
    ["+62% YoY", "positive"], ["Improving", "positive"], ["Net cash", "positive"],
    ["High", "negative"], ["Deep", "negative"], ["12.6%", "positive"],
    ["Positive", "positive"], ["Upward", "positive"],
  ],
};

export function getMockMetrics(ticker: string): Metric[] {
  const cells = METRIC_TABLE[ticker];
  if (!cells) return [];
  return METRIC_DEFS.map((def, i) => {
    const [value, status] = cells[i] ?? ["—", "neutral"];
    return {
      name: def.name,
      value,
      category: def.category,
      status,
      description: def.desc[status],
    };
  });
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export const MOCK_ANNOUNCEMENTS: Record<string, Announcement[]> = {
  MSFT: [
    {
      date: "2026-05-28",
      title: "Azure AI capacity expansion and new Copilot enterprise tier",
      source: "Microsoft IR",
      type: "product",
      summary:
        "Microsoft outlined accelerated Azure AI capacity buildout and a higher-margin Copilot enterprise SKU, with management guiding to continued cloud share gains.",
      impact: "positive",
      impactScore: 2,
    },
    {
      date: "2026-04-25",
      title: "FQ3 earnings beat — cloud revenue +27%",
      source: "Press release",
      type: "earnings",
      summary:
        "Revenue and EPS topped consensus on Azure strength; operating margins expanded YoY.",
      impact: "positive",
      impactScore: 3,
    },
  ],
  RBLX: [
    {
      date: "2026-05-20",
      title: "Bookings growth decelerates, EBITDA guidance trimmed",
      source: "Earnings call",
      type: "earnings",
      summary:
        "Daily active users grew but bookings growth slowed and management trimmed full-year adjusted EBITDA guidance, citing higher infrastructure and trust-and-safety spend.",
      impact: "negative",
      impactScore: -2,
    },
    {
      date: "2026-04-30",
      title: "New age-verification and safety controls rolled out",
      source: "Company blog",
      type: "product",
      summary:
        "Roblox shipped expanded safety tooling; near-term cost headwind but addresses regulatory scrutiny.",
      impact: "neutral",
      impactScore: 0,
    },
  ],
  GOOGL: [
    {
      date: "2026-05-22",
      title: "Gemini enterprise adoption and Cloud backlog at record",
      source: "Alphabet IR",
      type: "product",
      summary:
        "Management highlighted record Cloud backlog and accelerating Gemini enterprise seats, reinforcing the AI-monetisation thesis.",
      impact: "positive",
      impactScore: 2,
    },
    {
      date: "2026-04-24",
      title: "Q1 earnings beat; first-ever capital return increase",
      source: "Press release",
      type: "earnings",
      summary:
        "Search and Cloud both beat; buyback expanded. Regulatory overhang acknowledged but no new adverse ruling.",
      impact: "positive",
      impactScore: 2,
    },
  ],
  GOOG: [
    {
      date: "2026-05-22",
      title: "Gemini enterprise adoption and Cloud backlog at record",
      source: "Alphabet IR",
      type: "product",
      summary:
        "Management highlighted record Cloud backlog and accelerating Gemini enterprise seats, reinforcing the AI-monetisation thesis.",
      impact: "positive",
      impactScore: 2,
    },
    {
      date: "2026-04-24",
      title: "Q1 earnings beat; first-ever capital return increase",
      source: "Press release",
      type: "earnings",
      summary:
        "Search and Cloud both beat; buyback expanded. Regulatory overhang acknowledged but no new adverse ruling.",
      impact: "positive",
      impactScore: 2,
    },
  ],
  PLTR: [
    {
      date: "2026-05-26",
      title: "Large multi-year US government AI platform award",
      source: "Press release",
      type: "product",
      summary:
        "Palantir announced a sizeable multi-year government AIP expansion, supporting the commercial + government dual-engine narrative.",
      impact: "positive",
      impactScore: 2,
    },
    {
      date: "2026-05-05",
      title: "Q1 beat and raise, but valuation flagged by sell-side",
      source: "Earnings call",
      type: "earnings",
      summary:
        "Strong US commercial growth and a guidance raise; several analysts reiterated that the multiple already prices in years of execution.",
      impact: "positive",
      impactScore: 1,
    },
  ],
  MDB: [
    {
      date: "2026-05-29",
      title: "Atlas consumption growth steadies; FY guide unchanged",
      source: "Earnings call",
      type: "earnings",
      summary:
        "Atlas consumption stabilised after a soft patch; management kept full-year guidance, neither reassuring nor alarming the market.",
      impact: "neutral",
      impactScore: 0,
    },
    {
      date: "2026-05-02",
      title: "New vector-search GA for AI workloads",
      source: "Company blog",
      type: "product",
      summary:
        "GA of native vector search positions Atlas for AI-application data workloads; revenue impact not yet quantified.",
      impact: "positive",
      impactScore: 1,
    },
  ],
  NBIS: [
    {
      date: "2026-05-30",
      title: "GPU cloud capacity sold out through next quarter",
      source: "Company update",
      type: "product",
      summary:
        "Nebius reported its AI GPU cloud capacity is effectively sold out near-term with a sizeable contracted backlog, underpinning the hyper-growth narrative.",
      impact: "positive",
      impactScore: 3,
    },
    {
      date: "2026-05-08",
      title: "Capital raise to fund datacentre expansion",
      source: "Filing",
      type: "filing",
      summary:
        "Raised capital to accelerate datacentre buildout — supports growth but adds execution and dilution risk.",
      impact: "neutral",
      impactScore: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export const MOCK_VERDICTS: Record<string, StockVerdict> = {
  MSFT: {
    summaryBullets: [
      "Cloud + AI monetisation compounding with margin expansion.",
      "Earnings beat reinforces durable double-digit growth.",
      "Balance sheet and capital return remain best-in-class.",
    ],
    verdict: "positive",
    impactScore: 2,
    thesisUpdate:
      "Thesis intact and strengthening — Azure/Copilot remain the core growth engine.",
    marketReactionView:
      "Market reaction constructive; rally backed by fundamentals, not just multiple.",
    actionHint: "hold",
    execCommentary: {
      hasExecComments: true,
      tone: "aligned",
      keyPoints: [
        "Management guidance matches reported cloud acceleration.",
        "Commentary on AI capacity is specific and capacity-backed.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "yes",
      notes: "Reported revenue/margin trend corroborates the AI growth story.",
    },
    researchStatus: {
      ourResearchComplete: "yes",
      recommendedFollowUp: ["Monitor Azure capex/ROIC as buildout scales."],
    },
  },
  RBLX: {
    summaryBullets: [
      "Bookings growth decelerating into rising cost base.",
      "Safety/compliance spend pressures near-term margins.",
      "Trend and momentum both negative; sentiment soft.",
    ],
    verdict: "negative",
    impactScore: -2,
    thesisUpdate:
      "Thesis weakening — engagement holds but monetisation efficiency is the question.",
    marketReactionView:
      "Negative reaction justified; guidance cut is a genuine fundamental signal.",
    actionHint: "trim",
    execCommentary: {
      hasExecComments: true,
      tone: "cautious",
      keyPoints: [
        "Management framed the guide-down as investment, not demand weakness.",
        "Tone defensive on monetisation pace.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "partly",
      notes:
        "Engagement story holds; monetisation/margin story not yet supported by financials.",
    },
    researchStatus: {
      ourResearchComplete: "partial",
      recommendedFollowUp: [
        "Rebuild bookings-per-DAU model post guide-down.",
        "Quantify trust-and-safety opex trajectory.",
      ],
    },
  },
  GOOGL: {
    summaryBullets: [
      "Search resilient; Cloud backlog at record with Gemini momentum.",
      "Beat-and-raise with expanded capital return.",
      "Valuation still reasonable versus history.",
    ],
    verdict: "positive",
    impactScore: 2,
    thesisUpdate: "Thesis intact — AI monetisation fears continue to ease.",
    marketReactionView: "Reaction positive and fundamentally supported.",
    actionHint: "hold",
    execCommentary: {
      hasExecComments: true,
      tone: "aligned",
      keyPoints: [
        "Management quantified Cloud backlog and Gemini adoption.",
        "Measured tone on regulatory risk.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "yes",
      notes: "Cloud/Search results corroborate the AI-monetisation narrative.",
    },
    researchStatus: {
      ourResearchComplete: "yes",
      recommendedFollowUp: ["Track antitrust remedy timelines for tail risk."],
    },
  },
  // Class C (GOOG) shares the Class A (GOOGL) thesis — same business, non-voting.
  GOOG: {
    summaryBullets: [
      "Search resilient; Cloud backlog at record with Gemini momentum.",
      "Beat-and-raise with expanded capital return.",
      "Valuation still reasonable versus history.",
    ],
    verdict: "positive",
    impactScore: 2,
    thesisUpdate: "Thesis intact — AI monetisation fears continue to ease.",
    marketReactionView: "Reaction positive and fundamentally supported.",
    actionHint: "hold",
    execCommentary: {
      hasExecComments: true,
      tone: "aligned",
      keyPoints: [
        "Management quantified Cloud backlog and Gemini adoption.",
        "Measured tone on regulatory risk.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "yes",
      notes: "Cloud/Search results corroborate the AI-monetisation narrative.",
    },
    researchStatus: {
      ourResearchComplete: "yes",
      recommendedFollowUp: ["Track antitrust remedy timelines for tail risk."],
    },
  },
  PLTR: {
    summaryBullets: [
      "Strong government + commercial execution; new multi-year award.",
      "Beat-and-raise, but valuation is extended.",
      "RSI overbought against a large unrealised gain.",
    ],
    verdict: "neutral",
    impactScore: 1,
    thesisUpdate:
      "Thesis intact operationally, but risk/reward skews to valuation, not fundamentals.",
    marketReactionView:
      "Market euphoric; price has run ahead of analyst targets — momentum-driven.",
    actionHint: "trim",
    execCommentary: {
      hasExecComments: true,
      tone: "promotional",
      keyPoints: [
        "Management messaging notably promotional on AIP demand.",
        "Limited specificity on margin durability at scale.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "partly",
      notes:
        "Growth real, but current multiple implies years of flawless execution.",
    },
    researchStatus: {
      ourResearchComplete: "partial",
      recommendedFollowUp: [
        "Stress-test valuation under slower commercial growth.",
        "Confirm contract revenue-recognition cadence.",
      ],
    },
  },
  MDB: {
    summaryBullets: [
      "Atlas consumption stabilising after a soft patch.",
      "Guidance unchanged; vector-search optionality emerging.",
      "Trend mixed; the market wants a clearer re-acceleration signal.",
    ],
    verdict: "neutral",
    impactScore: 0,
    thesisUpdate: "Thesis on hold — waiting for consumption re-acceleration proof.",
    marketReactionView: "Muted reaction; market in show-me mode.",
    actionHint: "hold",
    execCommentary: {
      hasExecComments: true,
      tone: "cautious",
      keyPoints: [
        "Management cautious but not defensive on consumption trends.",
        "AI/vector messaging present but not yet quantified.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "unclear",
      notes: "AI-data narrative plausible but not yet evidenced in consumption.",
    },
    researchStatus: {
      ourResearchComplete: "partial",
      recommendedFollowUp: [
        "Track Atlas consumption cohorts next quarter.",
        "Size the vector-search revenue opportunity.",
      ],
    },
  },
  NBIS: {
    summaryBullets: [
      "AI GPU cloud effectively sold out with contracted backlog.",
      "Hyper-growth narrative intact; capital raise funds expansion.",
      "High volatility and rich valuation are the key risks.",
    ],
    verdict: "positive",
    impactScore: 2,
    thesisUpdate:
      "Thesis strengthening on demand signals; execution and dilution are the watch-items.",
    marketReactionView:
      "Positive reaction; momentum strong but volatility elevated.",
    actionHint: "hold",
    execCommentary: {
      hasExecComments: true,
      tone: "promotional",
      keyPoints: [
        "Management bullish on contracted backlog and sold-out capacity.",
        "Promotional tone; execution risk under-emphasised.",
      ],
    },
    factAlignment: {
      financialsSupportStory: "partly",
      notes:
        "Demand signals strong; durable margins at scale still unproven.",
    },
    researchStatus: {
      ourResearchComplete: "partial",
      recommendedFollowUp: [
        "Model dilution from the capital raise.",
        "Verify backlog conversion and utilisation assumptions.",
      ],
    },
  },
};
