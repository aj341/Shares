import "server-only";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";

/**
 * LLM news triage: scores each headline's likely impact on the ticker
 * (-3..+3) with a cheap Claude call, replacing the regex keyword counter on
 * the decision path (the regex remains the fallback). Results are cached in
 * Postgres by URL/title hash so each headline is judged exactly once.
 *
 * This score feeds scoring override rule 3 (cap at 39) and the redistribution
 * FULL_SELL trigger — accuracy here directly protects against false sells.
 */

const TRIAGE_MODEL =
  process.env.ANTHROPIC_TRIAGE_MODEL?.trim() || "claude-haiku-4-5-20251001";

export type TriageResult = { impactScore: number };

function isLlmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Stable key for a headline (djb2 over url|title). */
export function headlineKey(url: string | undefined, title: string): string {
  const s = `${url ?? ""}|${title}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

// --- cache (Postgres, in-memory fallback) -----------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS news_triage (
  headline_key TEXT PRIMARY KEY,
  impact_score INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

const memoryCache = new Map<string, number>();

async function readCached(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  if (!isDatabaseConfigured()) {
    for (const k of keys) if (memoryCache.has(k)) out.set(k, memoryCache.get(k)!);
    return out;
  }
  try {
    await ensureSchema();
    const rows = await query<{ headline_key: string; impact_score: number }>(
      `SELECT headline_key, impact_score FROM news_triage WHERE headline_key = ANY($1)`,
      [keys]
    );
    for (const r of rows) out.set(r.headline_key, Number(r.impact_score));
  } catch {
    /* cache miss is fine */
  }
  return out;
}

async function writeCached(entries: Map<string, number>): Promise<void> {
  if (entries.size === 0) return;
  if (!isDatabaseConfigured()) {
    for (const [k, v] of entries) memoryCache.set(k, v);
    return;
  }
  try {
    await ensureSchema();
    for (const [k, v] of entries) {
      await query(
        `INSERT INTO news_triage (headline_key, impact_score)
         VALUES ($1, $2) ON CONFLICT (headline_key) DO NOTHING`,
        [k, v]
      );
    }
  } catch {
    /* best-effort */
  }
}

// --- LLM call ----------------------------------------------------------------

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          impactScore: { type: "integer", minimum: -3, maximum: 3 },
        },
        required: ["index", "impactScore"],
      },
    },
  },
  required: ["items"],
} as const;

const SYSTEM = `You score news headlines for their likely impact on a SPECIFIC stock.
Scale: -3 (severely negative: guidance cut, fraud probe, major downgrade) to +3 (major positive:
big beat-and-raise, transformative deal). 0 = immaterial/routine/market-roundup noise.
Rules: judge materiality for the NAMED ticker only — generic market stories, lists ("10 stocks to
watch"), and tangential mentions are 0. Most headlines are -1..+1. Reserve |2|-|3| for genuinely
material company-specific events.`;

async function llmScore(
  ticker: string,
  items: { index: number; text: string }[]
): Promise<Map<number, number> | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const list = items.map((i) => `${i.index}. ${i.text.slice(0, 300)}`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: TRIAGE_MODEL,
        max_tokens: 600,
        system: SYSTEM,
        tools: [
          {
            name: "return_scores",
            description: "Return one impactScore per headline index.",
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "return_scores" },
        messages: [
          { role: "user", content: `TICKER: ${ticker}\nHEADLINES:\n${list}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type: string; input?: { items?: Array<{ index: number; impactScore: number }> } }>;
    };
    const tool = data.content?.find((c) => c.type === "tool_use");
    const out = new Map<number, number>();
    for (const it of tool?.input?.items ?? []) {
      if (Number.isInteger(it.index) && Number.isFinite(it.impactScore)) {
        out.set(it.index, Math.max(-3, Math.min(3, Math.round(it.impactScore))));
      }
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Triage a batch of headlines for one ticker. Returns a map of headlineKey →
 * impactScore covering as many items as possible (cached + newly scored), or
 * null when the LLM is unconfigured/unreachable AND nothing was cached —
 * callers then keep their regex fallback scores.
 */
export async function triageHeadlines(
  ticker: string,
  items: { url?: string; title: string; summary?: string }[]
): Promise<Map<string, TriageResult> | null> {
  if (items.length === 0) return null;

  const keyed = items.map((it, i) => ({
    ...it,
    key: headlineKey(it.url, it.title),
    index: i,
  }));
  const cached = await readCached(keyed.map((k) => k.key));

  const uncached = keyed.filter((k) => !cached.has(k.key));
  if (uncached.length > 0 && isLlmConfigured()) {
    const scored = await llmScore(
      ticker,
      uncached.map((u) => ({
        index: u.index,
        text: `${u.title}${u.summary ? ` — ${u.summary}` : ""}`,
      }))
    );
    if (scored) {
      const fresh = new Map<string, number>();
      for (const u of uncached) {
        const v = scored.get(u.index);
        if (v !== undefined) {
          cached.set(u.key, v);
          fresh.set(u.key, v);
        }
      }
      await writeCached(fresh);
    }
  }

  if (cached.size === 0) return null;
  const out = new Map<string, TriageResult>();
  for (const [k, v] of cached) out.set(k, { impactScore: v });
  return out;
}
