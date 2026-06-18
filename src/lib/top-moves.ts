import "server-only";
import { isLlmConfigured } from "@/lib/llm";
import { sectorFor } from "@/lib/sectors";
import type {
  ConvictionOverlay,
  FactorScores,
  Holding,
  RedistributionResponse,
  RelativeStrength,
  Signal,
  TradeRecommendation,
  WatchlistItem,
} from "@/lib/types";

/**
 * AI "Top 3 Moves Today" — structured-signal-fed policy engine.
 *
 * DESIGN PRINCIPLE: the AI is a POLICY ENGINE, not an alpha source. Candidate
 * moves and their priority are derived 100% deterministically from signals the
 * app ALREADY ships (score, signal, verdict stance, relative strength, factor
 * composite, conviction, concentration status, redistribution action). Claude
 * is used ONLY to write the human-readable rationale + a "why now" line for the
 * already-chosen top 3, and may LIGHTLY re-order within the shortlist. It must
 * NOT invent signals. If Claude is unavailable, deterministic template reasons
 * are used and the feature still works end-to-end.
 *
 * Everything here is ADDITIVE and null-safe: it reads existing fields, never
 * mutates them, and never touches the score/Signal math.
 */

// ---------------------------------------------------------------------------
// [top3] EXTENSIBILITY — optional sibling-signal slots.
// ---------------------------------------------------------------------------
//
// Sibling agents are building earnings / regime / news / insider signals. They
// are NOT imported here (their code may not exist yet). Instead the integrator
// passes whatever is available through `Top3SignalInputs`; absent slots are
// ignored. See `buildTopMoves` and the integrator notes at the bottom of this
// file for exact wiring instructions.

/** Per-ticker earnings-proximity signal (built by the earnings agent). */
export type Top3EarningsSignal = {
  /** Calendar days until the next scheduled earnings event (>=0). */
  daysToEarnings: number;
  /** Optional pre-earnings risk read; raises urgency to act before the print. */
  risk?: "high" | "medium" | "low";
};

/** Market-regime signal (built by the regime agent). Book-wide, not per-name. */
export type Top3RegimeSignal = {
  /** Coarse posture; "risk_off" damps ADD moves and lifts TRIM/SELL urgency. */
  regime: "risk_on" | "neutral" | "risk_off";
  /** Optional human label, surfaced verbatim in the rationale context. */
  label?: string;
};

/** Per-ticker news-flow signal (built by the news agent). */
export type Top3NewsSignal = {
  /** Net news impact, -3 (very negative) .. +3 (very positive). */
  impact: number;
  /** Optional one-line headline driving the impact, for AI context only. */
  headline?: string;
};

/** Per-ticker insider-activity signal (built by the insider agent). */
export type Top3InsiderSignal = {
  /** Net insider bias; "buy" lifts ADD urgency, "sell" lifts TRIM urgency. */
  bias: "buy" | "sell" | "neutral";
  /** Optional net USD value of recent insider transactions (signed). */
  netValueUsd?: number;
};

/**
 * Optional sibling-signal bundle. Every slot is OPTIONAL and keyed by ticker
 * (except `regime`, which is book-wide). The ranker consumes any slot that is
 * present and silently ignores any that is absent — so this interface is
 * forward-compatible with features that ship later.
 */
export type Top3SignalInputs = {
  /** ticker -> earnings proximity/risk. */
  earnings?: Record<string, Top3EarningsSignal>;
  /** Book-wide market regime. */
  regime?: Top3RegimeSignal;
  /** ticker -> news flow. */
  news?: Record<string, Top3NewsSignal>;
  /** ticker -> insider activity. */
  insider?: Record<string, Top3InsiderSignal>;
};

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export type TopMoveAction = "TRIM" | "SELL" | "ADD" | "WATCH";

/** The structured feature set behind a single candidate (fed to Claude as JSON). */
export type TopMoveFeatures = {
  ticker: string;
  companyName: string;
  /** "holding" or "watchlist" — where the candidate originated. */
  origin: "holding" | "watchlist";
  sector: string;
  score: number | null;
  signal: Signal | null;
  /** Verdict stance from the holding's StockVerdict (positive/neutral/negative). */
  verdictStance: "positive" | "neutral" | "negative" | null;
  /** Relative-strength rank/percentile (cross-sectional). */
  rsRank: number | null;
  rsPercentile: number | null;
  /** Factor composite 0-100 (quality blend). */
  factorComposite: number | null;
  /** Conviction overlay level + 0..1 weight. */
  convictionLevel: ConvictionOverlay["level"] | null;
  convictionWeight: number | null;
  /** Concentration status for THIS name from the redistribution engine. */
  concentration: "OK" | "WARN" | "BREACH" | null;
  /** The redistribution engine's own recommended action for this name, if any. */
  redistributionAction: TradeRecommendation["action"] | null;
  portfolioWeight: number | null;
  /** Optional sibling signals (present only when wired by the integrator). */
  earnings?: Top3EarningsSignal;
  regime?: Top3RegimeSignal["regime"];
  news?: Top3NewsSignal;
  insider?: Top3InsiderSignal;
};

export type TopMove = {
  rank: number;
  action: TopMoveAction;
  ticker: string;
  companyName: string;
  /** Deterministic priority score (higher = more urgent). For transparency. */
  priority: number;
  /** Crisp rationale — AI-written when available, deterministic template otherwise. */
  rationale: string;
  /** One-line "why now". */
  whyNow: string;
  /** The structured features the decision was built from (auditable). */
  features: TopMoveFeatures;
};

export type TopMovesResponse = {
  moves: TopMove[];
  /** "llm" when Claude wrote the rationale, "heuristic" for the template fallback. */
  source: "llm" | "heuristic";
  generatedAt: string;
  hasData: boolean;
  disclaimer: string;
};

const DISCLAIMER =
  "Deterministic candidate selection from the app's own signals; AI explains the chosen moves. General information from the app's data, not financial advice.";

// ---------------------------------------------------------------------------
// 1. Deterministic candidate generation
// ---------------------------------------------------------------------------

type Candidate = {
  action: TopMoveAction;
  features: TopMoveFeatures;
  priority: number;
  /** Deterministic template reason, always available (LLM fallback). */
  templateRationale: string;
  templateWhyNow: string;
};

function verdictStance(h: Holding): TopMoveFeatures["verdictStance"] {
  return h.verdict?.verdict ?? null;
}

/** Map redistribution recommendations to a per-ticker lookup. */
function recByTicker(
  redistribution: RedistributionResponse | null
): Map<string, TradeRecommendation> {
  const map = new Map<string, TradeRecommendation>();
  for (const r of redistribution?.recommendations ?? []) {
    if (!map.has(r.ticker)) map.set(r.ticker, r);
  }
  return map;
}

/**
 * Per-name concentration status from the redistribution summary's assessment.
 * BREACH/WARN are derived from the single-name limit; we attribute them only to
 * the subject name(s) the assessment names. Null when no assessment is present.
 */
function concentrationStatusFor(
  ticker: string,
  redistribution: RedistributionResponse | null
): TopMoveFeatures["concentration"] {
  const conc = redistribution?.summary?.concentration;
  if (!conc) return null;
  for (const a of conc.assessments ?? []) {
    if (a.subject === ticker && a.status !== "OK") return a.status;
  }
  if (conc.metrics?.largestSingleNameTicker === ticker) {
    if (
      conc.metrics.largestSingleNameWeight >
      conc.limits.maxSingleNameWeight + 1e-9
    )
      return "BREACH";
    if (conc.metrics.largestSingleNameWeight > conc.limits.warnSingleName + 1e-9)
      return "WARN";
  }
  return "OK";
}

/** Relative-strength percentile, null-safe. */
function rsPercentile(rs: RelativeStrength | undefined): number | null {
  return rs?.percentile ?? null;
}

/** Factor composite, null-safe. */
function factorComposite(f: FactorScores | undefined): number | null {
  return f?.composite ?? null;
}

/**
 * Deterministic priority score in [0, ~100+]. Weighted blend of:
 *  - conviction weight (trust in the signal)
 *  - signal strength (distance of score from the HOLD midpoint)
 *  - concentration urgency (BREACH >> WARN)
 *  - relative-strength percentile (rewards strong adds / penalises weak holds)
 *  - optional sibling signals (earnings proximity, regime, news, insider)
 * Higher = act sooner. Direction (ADD vs TRIM/SELL) is decided separately.
 */
function priorityFor(action: TopMoveAction, f: TopMoveFeatures): number {
  const score = f.score ?? 50;
  const conv = f.convictionWeight ?? 0.5; // neutral when unknown
  const rs = f.rsPercentile ?? 50;

  const signalStrength = Math.min(1, Math.abs(score - 50) / 50);

  const concUrgency =
    f.concentration === "BREACH" ? 1 : f.concentration === "WARN" ? 0.5 : 0;

  const rsFrac = rs / 100;
  const rsContribution =
    action === "ADD" ? rsFrac : action === "WATCH" ? 0 : 1 - rsFrac;

  let p =
    35 * conv * signalStrength +
    30 * concUrgency +
    20 * rsContribution +
    10 *
      (action === "SELL"
        ? 1
        : action === "TRIM"
          ? 0.6
          : action === "ADD"
            ? 0.5
            : 0.2);

  // --- Optional sibling-signal modifiers (ignored when absent). ---
  if (f.earnings) {
    const near =
      f.earnings.daysToEarnings <= 7
        ? 1
        : f.earnings.daysToEarnings <= 14
          ? 0.5
          : 0;
    const riskMult =
      f.earnings.risk === "high" ? 1.5 : f.earnings.risk === "medium" ? 1.1 : 1;
    p += 12 * near * riskMult;
  }
  if (f.regime) {
    if (f.regime === "risk_off") p += action === "ADD" ? -8 : 8;
    else if (f.regime === "risk_on") p += action === "ADD" ? 4 : -2;
  }
  if (f.news) {
    if (action === "ADD") p += Math.max(0, f.news.impact) * 3;
    else if (action === "TRIM" || action === "SELL")
      p += Math.max(0, -f.news.impact) * 3;
  }
  if (f.insider) {
    if (action === "ADD" && f.insider.bias === "buy") p += 6;
    if ((action === "TRIM" || action === "SELL") && f.insider.bias === "sell")
      p += 6;
  }

  return Math.round(p * 10) / 10;
}

function buildFeatures(
  origin: "holding" | "watchlist",
  ticker: string,
  companyName: string,
  opts: {
    score: number | null;
    signal: Signal | null;
    verdictStance: TopMoveFeatures["verdictStance"];
    rs?: RelativeStrength;
    factors?: FactorScores;
    conviction?: ConvictionOverlay;
    concentration: TopMoveFeatures["concentration"];
    redistributionAction: TradeRecommendation["action"] | null;
    portfolioWeight: number | null;
  },
  signals: Top3SignalInputs
): TopMoveFeatures {
  return {
    ticker,
    companyName,
    origin,
    sector: sectorFor(ticker),
    score: opts.score,
    signal: opts.signal,
    verdictStance: opts.verdictStance,
    rsRank: opts.rs?.rank ?? null,
    rsPercentile: rsPercentile(opts.rs),
    factorComposite: factorComposite(opts.factors),
    convictionLevel: opts.conviction?.level ?? null,
    convictionWeight: opts.conviction?.weight ?? null,
    concentration: opts.concentration,
    redistributionAction: opts.redistributionAction,
    portfolioWeight: opts.portfolioWeight,
    earnings: signals.earnings?.[ticker],
    regime: signals.regime?.regime,
    news: signals.news?.[ticker],
    insider: signals.insider?.[ticker],
  };
}

/**
 * Generate candidate ACTIONS from each holding + watchlist name. A name can
 * yield at most one candidate (the most salient action). Degraded holdings are
 * skipped (no trustworthy signal). Driven primarily by the redistribution
 * engine's own action, with score/verdict/concentration as the tie-breaker so
 * the moves stay consistent with the rebalancer.
 */
function generateCandidates(
  holdings: Holding[],
  redistribution: RedistributionResponse | null,
  watchlist: WatchlistItem[],
  signals: Top3SignalInputs
): Candidate[] {
  const recs = recByTicker(redistribution);
  const candidates: Candidate[] = [];

  // --- Holdings ---
  for (const h of holdings) {
    if (h.dataQuality === "degraded") continue;

    const rec = recs.get(h.ticker) ?? null;
    const concentration = concentrationStatusFor(h.ticker, redistribution);
    const stance = verdictStance(h);

    const f = buildFeatures(
      "holding",
      h.ticker,
      h.companyName,
      {
        score: h.score,
        signal: h.signal,
        verdictStance: stance,
        rs: h.relativeStrength,
        factors: h.factors,
        conviction: h.conviction,
        concentration,
        redistributionAction: rec?.action ?? null,
        portfolioWeight: h.portfolioWeight,
      },
      signals
    );

    let action: TopMoveAction | null = null;
    let reason = "";
    let why = "";

    if (rec?.action === "SELL") {
      action = "SELL";
      reason = `Exit ${h.ticker} — score ${h.score} with a ${stance ?? "weak"} verdict; the rebalancer flags a full sell.`;
      why = "Thesis has broken; capital is better deployed elsewhere.";
    } else if (concentration === "BREACH") {
      action = "TRIM";
      reason = `Trim ${h.ticker} — concentration breach at ${fmtPct(h.portfolioWeight)} of the book; over the single-name cap.`;
      why = "Reduce single-name risk before adding anywhere else.";
    } else if (rec?.action === "TRIM") {
      action = "TRIM";
      reason = `Trim ${h.ticker} — score ${h.score}${concentration === "WARN" ? " and approaching the concentration cap" : ""}; the rebalancer recommends lightening up.`;
      why = "Weak score or a stretched weight argues for taking some off.";
    } else if (rec?.action === "BUY") {
      action = "ADD";
      reason = `Add to ${h.ticker} — score ${h.score} (${h.signal})${rsLine(f)}; below the position cap with room to deploy.`;
      why = "Strong, trusted signal with headroom under the cap.";
    } else if (
      (h.signal === "STRONG_BUY" || h.signal === "BUY") &&
      stance !== "negative" &&
      (f.rsPercentile == null || f.rsPercentile >= 50)
    ) {
      action = "ADD";
      reason = `Add to ${h.ticker} — ${h.signal} signal, score ${h.score}${rsLine(f)}.`;
      why = "Constructive signal worth pressing while it holds.";
    } else if (h.signal === "SELL" || stance === "negative" || h.score < 45) {
      action = "TRIM";
      reason = `Lighten ${h.ticker} — score ${h.score} with a ${stance ?? "weak"} read.`;
      why = "Deteriorating signal; reduce exposure.";
    } else {
      const weak = h.score < 55;
      const small = (h.portfolioWeight ?? 0) < 5;
      if (weak && small) {
        action = "WATCH";
        reason = `Watch ${h.ticker} — weak score ${h.score} but a small ${fmtPct(h.portfolioWeight)} position; no action yet.`;
        why = "Too small to matter today; revisit if the score keeps sliding.";
      }
    }

    if (!action) continue;
    candidates.push({
      action,
      features: f,
      priority: priorityFor(action, f),
      templateRationale: reason,
      templateWhyNow: why,
    });
  }

  // --- Watchlist (ADD / WATCH only; we never trim what we don't own) ---
  for (const w of watchlist) {
    const score = w.engineScore;
    const signal = w.engineSignal;
    const f = buildFeatures(
      "watchlist",
      w.ticker,
      w.companyName,
      {
        score,
        signal,
        verdictStance: null,
        rs: w.relativeStrength,
        factors: w.factors,
        conviction: w.conviction,
        concentration: null,
        redistributionAction: null,
        portfolioWeight: 0,
      },
      signals
    );

    let action: TopMoveAction | null = null;
    let reason = "";
    let why = "";
    if (
      score != null &&
      score >= 70 &&
      (signal === "BUY" || signal === "STRONG_BUY")
    ) {
      action = "ADD";
      reason = `Open ${w.ticker} — screens ${score}/100 (${signal})${rsLine(f)} on the same engine as holdings.`;
      why = "Best-scoring new name clears the BUY bar.";
    } else if (score != null && score >= 60) {
      action = "WATCH";
      reason = `Watch ${w.ticker} — screens ${score}/100; close to the BUY bar but not yet there.`;
      why = "On the cusp; wait for confirmation before opening.";
    }
    if (!action) continue;
    candidates.push({
      action,
      features: f,
      priority: priorityFor(action, f),
      templateRationale: reason,
      templateWhyNow: why,
    });
  }

  return candidates;
}

function rsLine(f: TopMoveFeatures): string {
  if (f.rsPercentile == null) return "";
  const strong = f.rsPercentile >= 66;
  const weak = f.rsPercentile <= 33;
  if (strong)
    return `, strong relative strength (${Math.round(f.rsPercentile)}th pct)`;
  if (weak)
    return `, weak relative strength (${Math.round(f.rsPercentile)}th pct)`;
  return "";
}

function fmtPct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// 2. Rank, take top 3
// ---------------------------------------------------------------------------

function rankTop3(candidates: Candidate[]): Candidate[] {
  return [...candidates]
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const order: Record<TopMoveAction, number> = {
        SELL: 0,
        TRIM: 1,
        ADD: 2,
        WATCH: 3,
      };
      if (order[a.action] !== order[b.action])
        return order[a.action] - order[b.action];
      const sa = Math.abs((a.features.score ?? 50) - 50);
      const sb = Math.abs((b.features.score ?? 50) - 50);
      return sb - sa;
    })
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// 3. Claude — rationale ONLY (policy engine, not alpha). Cached + limited.
// ---------------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
const TTL_MS = 30 * 60 * 1000; // 30 min — moves are intraday but cheap to reuse.

type LlmMove = { ticker: string; rationale: string; whyNow: string };
type CacheEntry = { moves: LlmMove[]; ts: number };
const llmCache = new Map<string, CacheEntry>();

/** Cache key = the ordered shortlist + each name's action + rounded priority. */
function llmCacheKey(top3: Candidate[]): string {
  return top3
    .map((c) => `${c.features.ticker}:${c.action}:${Math.round(c.priority)}`)
    .join("|");
}

const SYSTEM = `You are the policy engine inside a personal stock dashboard, writing the "Top 3 Moves Today".
You are given a deterministically-chosen shortlist of THREE candidate moves, each with the FULL
structured feature set the app already computed (score, signal, verdict stance, relative-strength
percentile, factor composite, conviction, concentration status, the rebalancer's own action, and
any optional earnings/regime/news/insider signals).

Your job is NARROW:
- Write a crisp, specific rationale (1-2 sentences) and a one-line "why now" for EACH move.
- You MAY lightly re-order the three if a feature clearly makes one more urgent, but keep all three.
- Ground every statement ONLY in the provided features. Do NOT invent signals, prices, news, or
  figures that are not in the data. Do NOT predict exact price moves.
- Refer to each move by its action verb (Trim / Sell / Add / Watch) and ticker.
- This is the app's read of its own data, not financial advice.
Return the result via the return_moves tool, preserving each move's ticker.`;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    moves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          rationale: { type: "string" },
          whyNow: { type: "string" },
        },
        required: ["ticker", "rationale", "whyNow"],
      },
      minItems: 1,
      maxItems: 3,
    },
  },
  required: ["moves"],
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function writeRationale(top3: Candidate[]): Promise<LlmMove[] | null> {
  if (!isLlmConfigured()) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const key = llmCacheKey(top3);
  const hit = llmCache.get(key);
  if (hit && Date.now() - hit.ts <= TTL_MS) return hit.moves;

  const payload = top3.map((c, i) => ({
    order: i + 1,
    action: c.action,
    priority: c.priority,
    features: c.features,
  }));

  const prompt = `Here are the three chosen candidate moves as JSON (already ranked by the deterministic engine).
Write a crisp rationale + one-line "why now" for each, grounded ONLY in these features.

${JSON.stringify(payload, null, 2)}

Return via the return_moves tool, one entry per ticker.`;

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
        max_tokens: 900,
        system: SYSTEM,
        tools: [
          {
            name: "return_moves",
            description: "Return the rationale + why-now for each chosen move.",
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "return_moves" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      if (process.env.NODE_ENV !== "production")
        console.warn("[top-moves] anthropic error", res.status);
      return null;
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; input?: unknown }>;
    };
    const tool = data.content?.find((c) => c.type === "tool_use");
    if (!tool?.input || !isRecord(tool.input)) return null;
    const rawMoves = (tool.input as { moves?: unknown }).moves;
    if (!Array.isArray(rawMoves)) return null;

    const moves: LlmMove[] = [];
    for (const m of rawMoves) {
      if (!isRecord(m)) continue;
      const ticker = typeof m.ticker === "string" ? m.ticker : null;
      const rationale = typeof m.rationale === "string" ? m.rationale.trim() : "";
      const whyNow = typeof m.whyNow === "string" ? m.whyNow.trim() : "";
      if (!ticker || !rationale) continue;
      moves.push({ ticker, rationale, whyNow });
    }
    if (moves.length === 0) return null;
    llmCache.set(key, { moves, ts: Date.now() });
    return moves;
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.warn("[top-moves] request failed", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Public builder
// ---------------------------------------------------------------------------

export type BuildTopMovesArgs = {
  holdings: Holding[];
  redistribution: RedistributionResponse | null;
  watchlist?: WatchlistItem[];
  /** Optional sibling signals (earnings / regime / news / insider). */
  signals?: Top3SignalInputs;
};

/**
 * Build the "Top 3 Moves Today". Deterministic selection + ranking; Claude is
 * used ONLY to write rationale (with a light re-order). Always returns a valid
 * response — falls back to template reasons when the LLM is unavailable.
 */
export async function buildTopMoves(
  args: BuildTopMovesArgs
): Promise<TopMovesResponse> {
  const generatedAt = new Date().toISOString();
  const signals = args.signals ?? {};

  const candidates = generateCandidates(
    args.holdings ?? [],
    args.redistribution ?? null,
    args.watchlist ?? [],
    signals
  );

  if (candidates.length === 0) {
    return {
      moves: [],
      source: "heuristic",
      generatedAt,
      hasData: false,
      disclaimer: DISCLAIMER,
    };
  }

  const top3 = rankTop3(candidates);

  const llm = await writeRationale(top3);
  const byTicker = new Map(top3.map((c) => [c.features.ticker, c]));
  let source: TopMovesResponse["source"] = "heuristic";
  let ordered: Candidate[] = top3;

  if (llm) {
    source = "llm";
    const seen = new Set<string>();
    const reordered: Candidate[] = [];
    for (const m of llm) {
      const c = byTicker.get(m.ticker);
      if (c && !seen.has(m.ticker)) {
        reordered.push(c);
        seen.add(m.ticker);
      }
    }
    for (const c of top3) if (!seen.has(c.features.ticker)) reordered.push(c);
    ordered = reordered;
  }

  const llmByTicker = new Map((llm ?? []).map((m) => [m.ticker, m]));

  const moves: TopMove[] = ordered.map((c, i) => {
    const ai = llmByTicker.get(c.features.ticker);
    return {
      rank: i + 1,
      action: c.action,
      ticker: c.features.ticker,
      companyName: c.features.companyName,
      priority: c.priority,
      rationale: ai?.rationale || c.templateRationale,
      whyNow: ai?.whyNow || c.templateWhyNow,
      features: c.features,
    };
  });

  return {
    moves,
    source,
    generatedAt,
    hasData: true,
    disclaimer: DISCLAIMER,
  };
}
