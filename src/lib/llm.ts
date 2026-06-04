import "server-only";
import type { ArticleImpactAnalysis } from "@/lib/types";

/**
 * Optional Anthropic-powered synthesis for the Article Impact Analyzer.
 * Active only when ANTHROPIC_API_KEY is set; otherwise the caller uses a
 * deterministic heuristic. The key is read server-side and never exposed.
 *
 * Structured output is forced via tool_use so the result matches the contract.
 */

export function isLlmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";

/** The subset of ArticleImpactAnalysis the model fills in. */
export type LlmAnalysis = Pick<
  ArticleImpactAnalysis,
  | "summaryBullets"
  | "executiveSentiment"
  | "storyVsFinancials"
  | "outsideResearch"
  | "impactAssessment"
  | "followUp"
>;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    summaryBullets: { type: "array", items: { type: "string" }, maxItems: 6 },
    executiveSentiment: {
      type: "object",
      properties: {
        hasExecComments: { type: "boolean" },
        tone: {
          type: "string",
          enum: ["aligned", "cautious", "promotional", "contradictory", "no_signal"],
        },
        keyPoints: { type: "array", items: { type: "string" } },
      },
      required: ["hasExecComments", "tone", "keyPoints"],
    },
    storyVsFinancials: {
      type: "object",
      properties: {
        financialsSupportStory: {
          type: "string",
          enum: ["yes", "partly", "no", "unclear"],
        },
        notes: { type: "string" },
      },
      required: ["financialsSupportStory", "notes"],
    },
    outsideResearch: {
      type: "object",
      properties: {
        thesisChange: {
          type: "string",
          enum: ["confirming", "incremental", "material", "overhyped", "underappreciated"],
        },
        supportingPoints: { type: "array", items: { type: "string" } },
        conflictingPoints: { type: "array", items: { type: "string" } },
      },
      required: ["thesisChange", "supportingPoints", "conflictingPoints"],
    },
    impactAssessment: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] },
        impactScore: { type: "integer", minimum: -3, maximum: 3 },
        timeHorizon: {
          type: "string",
          enum: ["intraday", "short_term", "medium_term", "long_term"],
        },
        expectedMarketSensitivity: { type: "string", enum: ["low", "medium", "high"] },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        actionHint: { type: "string", enum: ["buy", "hold", "trim", "sell", "watch"] },
        rationale: { type: "string" },
      },
      required: [
        "verdict",
        "impactScore",
        "timeHorizon",
        "expectedMarketSensitivity",
        "confidence",
        "actionHint",
        "rationale",
      ],
    },
    followUp: { type: "array", items: { type: "string" } },
  },
  required: [
    "summaryBullets",
    "executiveSentiment",
    "storyVsFinancials",
    "outsideResearch",
    "impactAssessment",
    "followUp",
  ],
} as const;

const SYSTEM = `You are an equity research analyst assistant inside a portfolio dashboard.
Analyse a news article's likely impact on a specific stock. You are given the article text
and structured data the app already holds for the ticker (score, signal, metrics, analyst
target/consensus, RSI/moving averages, recent announcements).

Rules:
- Do NOT merely summarise. Explicitly separate: what the article SAYS, what management TONE implies,
  what the FINANCIALS support, what OUTSIDE RESEARCH confirms or disputes, and the likely IMPACT.
- If evidence is weak or the article is thin, say so and lower confidence.
- Do not predict exact price moves — give directional impact and thesis relevance only.
- Ground claims in the provided data; do not invent specific figures.`;

export async function analyzeArticleWithLLM(args: {
  ticker: string;
  headline: string;
  source?: string;
  articleBody: string;
  context: string;
}): Promise<LlmAnalysis | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;

  const prompt = `TICKER: ${args.ticker}
HEADLINE: ${args.headline}
SOURCE: ${args.source ?? "unknown"}

=== APP DATA FOR ${args.ticker} ===
${args.context}

=== ARTICLE TEXT ===
${args.articleBody.slice(0, 9000)}

Return the structured analysis via the return_analysis tool.`;

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
        max_tokens: 1500,
        system: SYSTEM,
        tools: [
          {
            name: "return_analysis",
            description: "Return the structured article-impact analysis.",
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "return_analysis" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      if (process.env.NODE_ENV !== "production")
        console.warn("[llm] anthropic error", res.status);
      return null;
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; input?: unknown }>;
    };
    const tool = data.content?.find((c) => c.type === "tool_use");
    return (tool?.input as LlmAnalysis) ?? null;
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.warn("[llm] request failed", (err as Error).message);
    return null;
  }
}
