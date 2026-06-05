import "server-only";
import type {
  Announcement,
  ExecTone,
  Metric,
  MetricCategory,
  Signal,
  StatusTone,
  StockVerdict,
} from "@/lib/types";

/**
 * Derives a StockVerdict from the LIVE metrics + live news + score, instead of
 * curated mock text. Deterministic and fast (no per-load LLM cost). Every field
 * is explained from the underlying data.
 */

const CAT_LABEL: Record<MetricCategory, string> = {
  trend: "Trend",
  momentum: "Momentum",
  valuation: "Valuation",
  fundamental: "Fundamentals",
  risk: "Risk",
  sentiment: "Sentiment",
};

function catScore(metrics: Metric[], cat: MetricCategory): number {
  return metrics
    .filter((m) => m.category === cat)
    .reduce((s, m) => s + (m.status === "positive" ? 1 : m.status === "negative" ? -1 : 0), 0);
}

const clamp3 = (n: number) => Math.max(-3, Math.min(3, Math.round(n)));

export function buildLiveVerdict(args: {
  ticker: string;
  metrics: Metric[];
  score: number;
  signal: Signal;
  announcements: Announcement[];
}): StockVerdict {
  const { metrics, score, signal, announcements } = args;

  const pos = metrics.filter((m) => m.status === "positive").length;
  const neg = metrics.filter((m) => m.status === "negative").length;
  const net = pos - neg;
  const newsNet = announcements.reduce((s, a) => s + a.impactScore, 0);

  const verdict: StatusTone =
    score >= 70 && net >= 0 ? "positive" : score < 50 || net <= -4 ? "negative" : "neutral";

  const impactScore = clamp3(net / 4 + (newsNet > 1 ? 1 : newsNet < -1 ? -1 : 0));

  // Category drivers, ranked.
  const cats = (Object.keys(CAT_LABEL) as MetricCategory[])
    .map((c) => ({ c, s: catScore(metrics, c) }))
    .sort((a, b) => b.s - a.s);
  const strong = cats.filter((x) => x.s > 0).map((x) => CAT_LABEL[x.c]);
  const weak = cats.filter((x) => x.s < 0).map((x) => CAT_LABEL[x.c]);

  const thesisUpdate =
    (strong.length ? `${strong.join(" & ")} constructive` : "No clear strengths") +
    (weak.length ? `; ${weak.join(" & ").toLowerCase()} weak.` : ".");

  const fund = catScore(metrics, "fundamental");
  const val = catScore(metrics, "valuation");
  const financialsSupportStory: "yes" | "partly" | "no" | "unclear" =
    fund > 0 && val >= 0 ? "yes" : fund > 0 && val < 0 ? "partly" : fund < 0 ? "no" : "unclear";

  const tone: ExecTone = announcements.length
    ? newsNet >= 2
      ? "promotional"
      : newsNet > 0
        ? "aligned"
        : newsNet < 0
          ? "cautious"
          : "no_signal"
    : "no_signal";

  const actionHint: StockVerdict["actionHint"] =
    signal === "STRONG_BUY" || signal === "BUY"
      ? "buy"
      : signal === "TRIM"
        ? "trim"
        : signal === "SELL"
          ? "sell"
          : "hold";

  const negNames = metrics.filter((m) => m.status === "negative").map((m) => m.name);
  const followUp = [
    "Confirm at the next earnings call.",
    ...negNames.slice(0, 3).map((n) => `Investigate weak signal: ${n}.`),
  ];

  return {
    summaryBullets: [
      `Score ${score}/100 (${signal.replace("_", " ")}); ${pos} positive vs ${neg} negative signals.`,
      strong.length ? `Strength in ${strong.join(", ").toLowerCase()}.` : "No standout strengths.",
      weak.length ? `Watch ${weak.join(", ").toLowerCase()}.` : "No major weaknesses flagged.",
      announcements.length
        ? `Recent news skews ${newsNet > 0 ? "positive" : newsNet < 0 ? "negative" : "neutral"}.`
        : "No recent news flow.",
    ],
    verdict,
    impactScore,
    thesisUpdate,
    marketReactionView:
      newsNet > 0
        ? "Recent flow supportive; momentum aligned with the data."
        : newsNet < 0
          ? "Recent flow cautious; watch for follow-through."
          : "Quiet news flow; price driven by technically/fundamentals.",
    actionHint,
    execCommentary: {
      hasExecComments: announcements.length > 0,
      tone,
      keyPoints: announcements.slice(0, 2).map((a) => a.title),
    },
    factAlignment: {
      financialsSupportStory,
      notes:
        financialsSupportStory === "yes"
          ? "Fundamentals and valuation both support the current price action."
          : financialsSupportStory === "partly"
            ? "Fundamentals are sound but valuation is stretched versus the data."
            : financialsSupportStory === "no"
              ? "Fundamental signals are weak relative to the narrative."
              : "Insufficient fundamental signal to judge — treat as unclear.",
    },
    researchStatus: {
      ourResearchComplete: "partial",
      recommendedFollowUp: followUp,
    },
  };
}
