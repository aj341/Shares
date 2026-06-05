import "server-only";
import { isLlmConfigured } from "@/lib/llm";
import type {
  Announcement,
  ExecTone,
  Metric,
  Signal,
  StatusTone,
  StockVerdict,
} from "@/lib/types";

/**
 * Optional Anthropic-powered deepening of a StockVerdict.
 *
 * The deterministic `buildLiveVerdict` (verdict.ts) produces the base verdict
 * synchronously on every load. This module layers an LLM-reasoned verdict on
 * top, but only when ANTHROPIC_API_KEY is configured. Results are cached
 * in-memory (per ticker+score) for ~12h so the cost is amortised and the hot
 * path stays synchronous.
 *
 * Mirrors src/lib/llm.ts: same endpoint, headers, body shape, tool_use forcing,
 * and tool_use parsing. The key is read server-side and never exposed.
 */

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";

const TTL_MS = 12 * 60 * 60 * 1000; // ~12 hours

type CacheEntry = { verdict: StockVerdict; ts: number };

const cache = new Map<string, CacheEntry>();

function cacheKey(ticker: string, score: number): string {
  return `${ticker}:${score}`;
}

function readFresh(key: string): StockVerdict | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.verdict;
}

// ---------------------------------------------------------------------------
// Tool schema — matches StockVerdict (types.ts) with proper enums.
// ---------------------------------------------------------------------------

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    summaryBullets: { type: "array", items: { type: "string" }, maxItems: 6 },
    verdict: { type: "string", enum: ["positive", "neutral", "negative"] },
    impactScore: { type: "integer", minimum: -3, maximum: 3 },
    thesisUpdate: { type: "string" },
    marketReactionView: { type: "string" },
    actionHint: {
      type: "string",
      enum: ["buy", "hold", "trim", "sell", "no_change"],
    },
    execCommentary: {
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
    factAlignment: {
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
    researchStatus: {
      type: "object",
      properties: {
        ourResearchComplete: { type: "string", enum: ["yes", "partial", "no"] },
        recommendedFollowUp: { type: "array", items: { type: "string" } },
      },
      required: ["ourResearchComplete", "recommendedFollowUp"],
    },
  },
  required: [
    "summaryBullets",
    "verdict",
    "impactScore",
    "thesisUpdate",
    "marketReactionView",
    "actionHint",
    "execCommentary",
    "factAlignment",
    "researchStatus",
  ],
} as const;

const SYSTEM = `You are a senior equity research analyst inside a portfolio dashboard.
Produce a concise, reasoned verdict on a single stock. You are given the app's structured
data: the ticker, a 0-100 score, a signal, a compact list of metric statuses, and recent
announcement titles with their impact scores.

Rules:
- Be concise and reasoned — do not pad. Every bullet should carry information.
- Explicitly separate what the METRICS show, what the NEWS implies, and what the
  FUNDAMENTALS support. Do not conflate them.
- Do NOT predict exact price moves or price targets — give directional/thesis relevance only.
- Ground every claim in the provided data; do not invent specific figures or facts.
- This is analysis, not financial advice.
- Return the verdict via the return_verdict tool.`;

// ---------------------------------------------------------------------------
// Validation / coercion to StockVerdict, defaulting from the base verdict.
// ---------------------------------------------------------------------------

const VERDICT_VALUES: readonly StatusTone[] = ["positive", "neutral", "negative"];
const ACTION_VALUES: readonly StockVerdict["actionHint"][] = [
  "buy",
  "hold",
  "trim",
  "sell",
  "no_change",
];
const TONE_VALUES: readonly ExecTone[] = [
  "aligned",
  "cautious",
  "promotional",
  "contradictory",
  "no_signal",
];
const FINANCIALS_VALUES: readonly FactAlignmentSupport[] = [
  "yes",
  "partly",
  "no",
  "unclear",
];
const RESEARCH_VALUES: readonly ResearchComplete[] = ["yes", "partial", "no"];

type FactAlignmentSupport = StockVerdict["factAlignment"]["financialsSupportStory"];
type ResearchComplete = StockVerdict["researchStatus"]["ourResearchComplete"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.filter((x): x is string => typeof x === "string" && x.length > 0);
  return cleaned.length > 0 ? cleaned : fallback;
}

const clamp3 = (n: number) => Math.max(-3, Math.min(3, Math.round(n)));

function coerceVerdict(raw: unknown, base: StockVerdict): StockVerdict {
  if (!isRecord(raw)) return base;

  const exec = isRecord(raw.execCommentary) ? raw.execCommentary : {};
  const fact = isRecord(raw.factAlignment) ? raw.factAlignment : {};
  const research = isRecord(raw.researchStatus) ? raw.researchStatus : {};

  const impactRaw = raw.impactScore;
  const impactScore =
    typeof impactRaw === "number" && Number.isFinite(impactRaw)
      ? clamp3(impactRaw)
      : base.impactScore;

  return {
    summaryBullets: pickStringArray(raw.summaryBullets, base.summaryBullets),
    verdict: pickEnum(raw.verdict, VERDICT_VALUES, base.verdict),
    impactScore,
    thesisUpdate: pickString(raw.thesisUpdate, base.thesisUpdate),
    marketReactionView: pickString(raw.marketReactionView, base.marketReactionView),
    actionHint: pickEnum(raw.actionHint, ACTION_VALUES, base.actionHint),
    execCommentary: {
      hasExecComments:
        typeof exec.hasExecComments === "boolean"
          ? exec.hasExecComments
          : base.execCommentary.hasExecComments,
      tone: pickEnum(exec.tone, TONE_VALUES, base.execCommentary.tone),
      keyPoints: pickStringArray(exec.keyPoints, base.execCommentary.keyPoints),
    },
    factAlignment: {
      financialsSupportStory: pickEnum(
        fact.financialsSupportStory,
        FINANCIALS_VALUES,
        base.factAlignment.financialsSupportStory,
      ),
      notes: pickString(fact.notes, base.factAlignment.notes),
    },
    researchStatus: {
      ourResearchComplete: pickEnum(
        research.ourResearchComplete,
        RESEARCH_VALUES,
        base.researchStatus.ourResearchComplete,
      ),
      recommendedFollowUp: pickStringArray(
        research.recommendedFollowUp,
        base.researchStatus.recommendedFollowUp,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronous read of a cached, LLM-enhanced verdict if one is fresh.
 * Returns null when nothing is cached (or the entry has expired) — the caller
 * should fall back to the deterministic base verdict in that case.
 */
export function getCachedEnhancedVerdict(
  ticker: string,
  score: number,
): StockVerdict | null {
  return readFresh(cacheKey(ticker, score));
}

/**
 * Deepen the base verdict with an LLM-reasoned one. Returns null when the LLM
 * is not configured or any failure occurs (the caller keeps the base verdict).
 * On success, the result is cached for ~12h keyed by `${ticker}:${score}`.
 */
export async function enhanceVerdict(args: {
  ticker: string;
  metrics: Metric[];
  score: number;
  signal: Signal;
  announcements: Announcement[];
  base: StockVerdict;
}): Promise<StockVerdict | null> {
  if (!isLlmConfigured()) return null;

  const { ticker, metrics, score, signal, announcements, base } = args;

  const key = cacheKey(ticker, score);
  const cached = readFresh(key);
  if (cached) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const metricLines = metrics.length
    ? metrics.map((m) => `- ${m.name} (${m.category}): ${m.status}`).join("\n")
    : "- (no metrics available)";

  const newsLines = announcements.length
    ? announcements
        .slice(0, 10)
        .map((a) => `- [${a.impactScore >= 0 ? "+" : ""}${a.impactScore}] ${a.title}`)
        .join("\n")
    : "- (no recent announcements)";

  const prompt = `TICKER: ${ticker}
SCORE: ${score}/100
SIGNAL: ${signal}

=== METRIC STATUSES ===
${metricLines}

=== RECENT ANNOUNCEMENTS (impactScore -3..+3) ===
${newsLines}

Produce the deepened verdict via the return_verdict tool.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: SYSTEM,
        tools: [
          {
            name: "return_verdict",
            description: "Return the structured, deepened stock verdict.",
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "return_verdict" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      if (process.env.NODE_ENV !== "production")
        console.warn("[verdict-llm] anthropic error", res.status);
      return null;
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; input?: unknown }>;
    };
    const tool = data.content?.find((c) => c.type === "tool_use");
    if (!tool?.input) return null;

    const verdict = coerceVerdict(tool.input, base);
    cache.set(key, { verdict, ts: Date.now() });
    return verdict;
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.warn("[verdict-llm] request failed", (err as Error).message);
    return null;
  }
}
