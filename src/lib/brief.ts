import "server-only";
import { buildPortfolio } from "@/lib/portfolio";
import { getUpcomingEvents } from "@/lib/events";
import { getMarketRegime, type MarketRegime } from "@/lib/regime";
import { getRevisionTrend, type RevisionTrend } from "@/lib/revisions";
import type {
  BriefWatchItem,
  CatalystItem,
  DailyBrief,
  Holding,
} from "@/lib/types";

/**
 * Daily AI Brief: a "what to watch today" synthesis across the book, combining
 * current signals, recent high-impact news, analyst-revision deltas, P&L and
 * upcoming earnings. Uses Claude when ANTHROPIC_API_KEY is set; otherwise a
 * deterministic heuristic. Cached (briefs are expensive and change slowly).
 *
 * Tooling/data only — not financial advice.
 */

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
const DISCLAIMER = "Generated from your holdings' data. Not financial advice.";
const TTL_MS = 4 * 60 * 60 * 1000; // 4h
const MAX_CATALYSTS = 8;

let cache: { at: number; brief: DailyBrief } | null = null;

type Ctx = {
  holding: Holding;
  revision: RevisionTrend | null;
  nextEarningsInDays: number | null;
};

export async function buildBrief(opts?: { force?: boolean }): Promise<DailyBrief> {
  const now = Date.now();
  // `force` bypasses the cache — used by the nightly cron so the evening brief
  // always reflects the just-completed IBKR realign, not a stale afternoon view.
  if (!opts?.force && cache && now - cache.at < TTL_MS) return cache.brief;

  const portfolio = await buildPortfolio();
  const tickers = portfolio.holdings.map((h) => h.ticker);

  const [events, revisions, regime] = await Promise.all([
    getUpcomingEvents(tickers).catch(() => []),
    Promise.all(tickers.map((t) => getRevisionTrend(t).catch(() => null))),
    getMarketRegime().catch(() => null),
  ]);

  const catalysts: CatalystItem[] = events.slice(0, MAX_CATALYSTS).map((e) => ({
    ticker: e.ticker,
    type: e.type,
    date: e.date,
    detail: e.detail,
    daysAway: e.daysAway,
  }));

  const earningsByTicker = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "earnings") continue;
    const prev = earningsByTicker.get(e.ticker);
    if (prev == null || e.daysAway < prev) earningsByTicker.set(e.ticker, e.daysAway);
  }

  const ctx: Ctx[] = portfolio.holdings.map((h, i) => ({
    holding: h,
    revision: revisions[i],
    nextEarningsInDays: earningsByTicker.get(h.ticker) ?? null,
  }));

  const llm = await synthesizeWithLlm(ctx, regime).catch(() => null);
  const core = llm ?? heuristicBrief(ctx, regime);

  const brief: DailyBrief = {
    generatedAt: new Date().toISOString(),
    ...core,
    catalysts,
    source: llm ? "llm" : "heuristic",
    hasData: portfolio.holdings.length > 0,
    disclaimer: DISCLAIMER,
  };

  cache = { at: now, brief };
  return brief;
}

// --- Heuristic fallback ----------------------------------------------------

type BriefCore = Pick<DailyBrief, "stance" | "headline" | "summary" | "watchItems">;

function heuristicBrief(ctx: Ctx[], regime: MarketRegime | null): BriefCore {
  const watchItems: BriefWatchItem[] = [];

  for (const c of ctx) {
    const h = c.holding;
    const reasons: string[] = [];
    let urgency: BriefWatchItem["urgency"] = "low";

    // Imminent earnings.
    if (c.nextEarningsInDays != null && c.nextEarningsInDays <= 7) {
      reasons.push(
        `reports earnings in ${c.nextEarningsInDays} day${c.nextEarningsInDays === 1 ? "" : "s"}`
      );
      urgency = c.nextEarningsInDays <= 2 ? "high" : "medium";
    }

    // High-impact news.
    const news = h.announcements
      .slice()
      .sort((a, b) => Math.abs(b.impactScore) - Math.abs(a.impactScore))[0];
    if (news && Math.abs(news.impactScore) >= 2) {
      reasons.push(
        `${news.impactScore > 0 ? "positive" : "negative"} news — "${news.title}"`
      );
      if (news.impactScore <= -2) urgency = "high";
      else if (urgency === "low") urgency = "medium";
    }

    // Analyst revisions.
    if (c.revision && c.revision.direction !== "stable") {
      reasons.push(`analysts ${c.revision.direction}`);
      if (urgency === "low") urgency = "medium";
    }

    // Extreme signal.
    if (h.signal === "STRONG_BUY" || h.signal === "SELL") {
      reasons.push(`signal is ${h.signal.replace("_", " ")}`);
      if (urgency === "low") urgency = "medium";
    }

    if (reasons.length) {
      watchItems.push({ ticker: h.ticker, urgency, note: capitalise(reasons.join("; ")) + "." });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  watchItems.sort((a, b) => order[a.urgency] - order[b.urgency]);

  // Stance: the MARKET regime leads (holdings' own signals are circular — six
  // correlated names all sour together, too late); holdings refine within it.
  const buys = ctx.filter((c) => c.holding.signal === "BUY" || c.holding.signal === "STRONG_BUY").length;
  const sells = ctx.filter((c) => c.holding.signal === "SELL" || c.holding.signal === "TRIM").length;
  const holdingsLean: BriefCore["stance"] =
    buys > sells * 2 ? "risk-on" : sells > buys ? "risk-off" : buys && sells ? "mixed" : "neutral";
  const stance: BriefCore["stance"] =
    regime?.regime === "risk_off"
      ? "risk-off"
      : regime?.regime === "caution"
      ? holdingsLean === "risk-on"
        ? "mixed"
        : holdingsLean
      : holdingsLean;

  const highCount = watchItems.filter((w) => w.urgency === "high").length;
  const headline = highCount
    ? `${highCount} holding${highCount === 1 ? "" : "s"} need attention today`
    : watchItems.length
    ? "A few items worth a look today"
    : "Quiet day across the book";

  const nearest = ctx
    .filter((c) => c.nextEarningsInDays != null)
    .sort((a, b) => (a.nextEarningsInDays! - b.nextEarningsInDays!))[0];
  const summary = [
    regime ? `${regime.label}.` : "",
    `Signals lean ${stance.replace("-", " ")} (${buys} buy / ${sells} reduce across ${ctx.length} holdings).`,
    nearest
      ? `Next earnings: ${nearest.holding.ticker} in ${nearest.nextEarningsInDays} day${nearest.nextEarningsInDays === 1 ? "" : "s"}.`
      : "No earnings in the next two weeks.",
    watchItems.length ? "See watch items below." : "Nothing flagged as urgent.",
  ]
    .filter(Boolean)
    .join(" ");

  return { stance, headline, summary, watchItems: watchItems.slice(0, 8) };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- LLM synthesis ---------------------------------------------------------

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    stance: { type: "string", enum: ["risk-on", "neutral", "risk-off", "mixed"] },
    headline: { type: "string" },
    summary: { type: "string" },
    watchItems: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          urgency: { type: "string", enum: ["high", "medium", "low"] },
          note: { type: "string" },
        },
        required: ["ticker", "urgency", "note"],
      },
    },
  },
  required: ["stance", "headline", "summary", "watchItems"],
} as const;

const SYSTEM = `You are an equity analyst assistant writing a concise pre-market brief for a
personal portfolio dashboard. You are given structured data the app already holds for each
holding (signal, score, unrealised P&L %, top recent news + impact, analyst-revision direction,
days until next earnings).

Rules:
- Write a tight "what to watch today" brief, not a generic market summary.
- Prioritise: imminent earnings, high-impact news, analyst revisions, and signal extremes.
- watchItems: one per holding that genuinely warrants attention; set urgency honestly.
- Be specific and ground every claim in the provided data. Do NOT invent figures or news.
- Do not give buy/sell instructions or predict prices — describe what to monitor and why.
- Keep the summary to 2–4 sentences.`;

async function synthesizeWithLlm(
  ctx: Ctx[],
  regime: MarketRegime | null
): Promise<BriefCore | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || ctx.length === 0) return null;

  const lines = ctx.map((c) => {
    const h = c.holding;
    const news = h.announcements
      .slice()
      .sort((a, b) => Math.abs(b.impactScore) - Math.abs(a.impactScore))[0];
    const newsStr = news ? `top news (impact ${news.impactScore}): "${news.title}"` : "no notable news";
    const rev = c.revision ? `analysts ${c.revision.direction}` : "no revision data";
    const earn = c.nextEarningsInDays != null ? `earnings in ${c.nextEarningsInDays}d` : "no earnings <14d";
    return `- ${h.ticker} (${h.companyName}): signal ${h.signal}, score ${h.score}, P&L ${h.unrealisedPnlPct.toFixed(1)}%; ${earn}; ${rev}; ${newsStr}`;
  });

  const regimeLine = regime
    ? `MARKET REGIME: ${regime.label} (QQQ ${regime.qqqVs200dmaPct}% vs 200dma, vol percentile ${regime.volPercentile}). Let the regime LEAD the stance — the holdings' own signals are correlated and lag in drawdowns.\n\n`
    : "";
  const prompt = `${regimeLine}Today's holdings snapshot:\n${lines.join("\n")}\n\nReturn the brief via the return_brief tool.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: SYSTEM,
        tools: [
          { name: "return_brief", description: "Return the structured daily brief.", input_schema: TOOL_SCHEMA },
        ],
        tool_choice: { type: "tool", name: "return_brief" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; input?: unknown }> };
    const tool = data.content?.find((c) => c.type === "tool_use");
    const out = tool?.input as BriefCore | undefined;
    if (!out || !out.stance || !Array.isArray(out.watchItems)) return null;
    return out;
  } catch {
    return null;
  }
}
