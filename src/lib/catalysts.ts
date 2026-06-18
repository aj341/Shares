import "server-only";
import { getPool, isDatabaseConfigured, query } from "@/lib/db";
import * as finnhub from "@/lib/finnhub";
import { isLlmConfigured } from "@/lib/llm";
import { sendTelegramMessage } from "@/lib/telegram";

/**
 * News -> AI catalyst triage (HARD CATALYSTS ONLY).
 *
 * Distinct from `news-triage.ts` (which produces a -3..+3 impact score that
 * feeds the SCORING engine) and from `announcements.ts` (display feed). This
 * module is fully ADDITIVE: it pulls recent company news per holding/watchlist
 * name, asks Claude to classify each item as a hard catalyst, and surfaces ONLY
 * real catalysts (catalystType != "none" AND materiality high/medium). It never
 * mutates scores, signals or the existing announcements pipeline.
 *
 * Everything is null-safe: with no news provider / no Claude key / no DB the
 * functions return empty results and never throw.
 *
 * Classifications are cached (Postgres when configured, in-memory fallback)
 * keyed by a stable article id, so each article is judged by Claude once.
 */

// ---------------------------------------------------------------------------
// Public types (see also NewsCatalyst re-exported in types.ts via // [news])
// ---------------------------------------------------------------------------

export type CatalystType =
  | "earnings"
  | "guidance"
  | "m_and_a"
  | "regulatory_legal"
  | "major_contract"
  | "none";

export type CatalystDirection = "bullish" | "bearish" | "neutral";

export type CatalystMateriality = "high" | "medium" | "low";

/** A Claude classification for a single news item. */
export type CatalystClassification = {
  catalystType: CatalystType;
  direction: CatalystDirection;
  materiality: CatalystMateriality;
  /** One-line rationale from Claude. */
  why: string;
};

/** A surfaced hard catalyst (classification + source article + ownership). */
export type NewsCatalyst = CatalystClassification & {
  /** Stable article id used as the cache key. */
  id: string;
  ticker: string;
  /** Whether the ticker is a currently-held position. */
  held: boolean;
  headline: string;
  summary: string;
  source: string;
  url?: string;
  /** ISO date (YYYY-MM-DD) of the article. */
  date: string;
};

export type CatalystsResult = {
  catalysts: NewsCatalyst[];
  asOf: string;
  /** True when the Claude classifier ran (vs. degraded/no-key). */
  classified: boolean;
};

const MODEL =
  process.env.ANTHROPIC_CATALYST_MODEL?.trim() ||
  process.env.ANTHROPIC_TRIAGE_MODEL?.trim() ||
  "claude-haiku-4-5-20251001";

const CATALYST_TYPES: readonly CatalystType[] = [
  "earnings",
  "guidance",
  "m_and_a",
  "regulatory_legal",
  "major_contract",
  "none",
];
const DIRECTIONS: readonly CatalystDirection[] = ["bullish", "bearish", "neutral"];
const MATERIALITIES: readonly CatalystMateriality[] = ["high", "medium", "low"];

// ---------------------------------------------------------------------------
// Raw news item normalisation
// ---------------------------------------------------------------------------

export type RawNewsItem = {
  ticker: string;
  headline: string;
  summary: string;
  source: string;
  url?: string;
  /** epoch seconds */
  datetime: number;
};

/** Stable id for an article (djb2 over ticker|url|headline). */
export function articleId(ticker: string, url: string | undefined, headline: string): string {
  const s = `${ticker}|${url ?? ""}|${headline}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `c${(h >>> 0).toString(36)}`;
}

/** Finnhub tags news under the primary listing — map share-class variants. */
const NEWS_SYMBOL_ALIAS: Record<string, string> = { GOOG: "GOOGL" };

/**
 * Pull recent company news for a ticker from Finnhub (last `days`). Returns []
 * on any failure / missing key. (Mboum has no per-symbol news endpoint in this
 * codebase, so Finnhub is the news source; the module is provider-agnostic via
 * RawNewsItem and could ingest additional providers without further changes.)
 */
export async function fetchTickerNews(ticker: string, days = 14): Promise<RawNewsItem[]> {
  if (!finnhub.isFinnhubConfigured()) return [];
  const sym = NEWS_SYMBOL_ALIAS[ticker] ?? ticker;
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const news = await finnhub.getCompanyNews(sym, from, to).catch(() => null);
  if (!news || news.length === 0) return [];

  const relevant = news.filter((n) => {
    const rel = (n.related || "").toUpperCase().split(/[,\s]+/);
    return rel.includes(sym) || new RegExp(`\\b${sym}\\b`).test(n.headline ?? "");
  });
  const pool = relevant.length > 0 ? relevant : news;

  const seen = new Set<string>();
  return pool
    .filter((n) => n.headline && !seen.has(n.headline) && (seen.add(n.headline), true))
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 10)
    .map((n) => ({
      ticker,
      headline: n.headline,
      summary: (n.summary ?? "").trim() || n.headline,
      source: n.source || "News",
      url: n.url,
      datetime: n.datetime,
    }));
}

// ---------------------------------------------------------------------------
// Cache (Postgres, in-memory fallback) keyed by article id
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS news_catalysts (
  article_id    TEXT PRIMARY KEY,
  catalyst_type TEXT NOT NULL,
  direction     TEXT NOT NULL,
  materiality   TEXT NOT NULL,
  why           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

const memoryCache = new Map<string, CatalystClassification>();

async function readCached(ids: string[]): Promise<Map<string, CatalystClassification>> {
  const out = new Map<string, CatalystClassification>();
  if (ids.length === 0) return out;
  if (!isDatabaseConfigured()) {
    for (const id of ids) {
      const hit = memoryCache.get(id);
      if (hit) out.set(id, hit);
    }
    return out;
  }
  try {
    await ensureSchema();
    const rows = await query<{
      article_id: string;
      catalyst_type: string;
      direction: string;
      materiality: string;
      why: string;
    }>(
      `SELECT article_id, catalyst_type, direction, materiality, why
         FROM news_catalysts WHERE article_id = ANY($1)`,
      [ids]
    );
    for (const r of rows) {
      out.set(r.article_id, {
        catalystType: coerceEnum(r.catalyst_type, CATALYST_TYPES, "none"),
        direction: coerceEnum(r.direction, DIRECTIONS, "neutral"),
        materiality: coerceEnum(r.materiality, MATERIALITIES, "low"),
        why: r.why ?? "",
      });
    }
  } catch {
    /* cache miss is fine */
  }
  return out;
}

async function writeCached(entries: Map<string, CatalystClassification>): Promise<void> {
  if (entries.size === 0) return;
  if (!isDatabaseConfigured()) {
    for (const [id, v] of entries) memoryCache.set(id, v);
    return;
  }
  try {
    await ensureSchema();
    for (const [id, v] of entries) {
      await query(
        `INSERT INTO news_catalysts (article_id, catalyst_type, direction, materiality, why)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (article_id) DO NOTHING`,
        [id, v.catalystType, v.direction, v.materiality, v.why]
      );
    }
  } catch {
    /* best-effort */
  }
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// ---------------------------------------------------------------------------
// Claude classifier
// ---------------------------------------------------------------------------

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          catalystType: {
            type: "string",
            enum: ["earnings", "guidance", "m_and_a", "regulatory_legal", "major_contract", "none"],
          },
          direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          materiality: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string" },
        },
        required: ["index", "catalystType", "direction", "materiality", "why"],
      },
    },
  },
  required: ["items"],
} as const;

const SYSTEM = `You triage stock news into HARD CATALYSTS for a portfolio dashboard.
For each item, decide if it is a genuine, company-specific HARD catalyst for the NAMED ticker.

catalystType:
- "earnings"          quarterly/annual results actually reported (beat/miss, EPS, revenue print)
- "guidance"          forward guidance raised/cut/withdrawn, outlook change
- "m_and_a"           merger, acquisition, takeover bid, divestiture, spin-off, strategic review
- "regulatory_legal"  regulator action, antitrust, lawsuit ruling/settlement, fine, probe, approval/denial of a product
- "major_contract"    a large named contract / order / partnership material to revenue
- "none"              everything else: routine coverage, price-target tweaks, opinion pieces,
                      "stocks to watch" lists, market round-ups, tangential mentions, rumours

direction: bullish | bearish | neutral (for the named ticker).
materiality: high (clearly moves the thesis), medium (notable), low (minor/uncertain).

Rules:
- Be STRICT. Most headlines are "none". Only classify a real, concrete, company-specific event.
- A generic analyst rating change is NOT a hard catalyst -> "none".
- Judge for the NAMED ticker only.
- Keep "why" to one short line grounded in the headline. This is analysis, not advice.
Return all items via the return_catalysts tool.`;

async function classifyBatch(
  ticker: string,
  items: { index: number; text: string }[]
): Promise<Map<number, CatalystClassification> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const list = items.map((i) => `${i.index}. ${i.text.slice(0, 320)}`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        system: SYSTEM,
        tools: [
          {
            name: "return_catalysts",
            description: "Return one classification per news item index.",
            input_schema: TOOL_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "return_catalysts" },
        messages: [{ role: "user", content: `TICKER: ${ticker}\nNEWS:\n${list}` }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{
        type: string;
        input?: {
          items?: Array<{
            index: number;
            catalystType: string;
            direction: string;
            materiality: string;
            why: string;
          }>;
        };
      }>;
    };
    const tool = data.content?.find((c) => c.type === "tool_use");
    const out = new Map<number, CatalystClassification>();
    for (const it of tool?.input?.items ?? []) {
      if (!Number.isInteger(it.index)) continue;
      out.set(it.index, {
        catalystType: coerceEnum(it.catalystType, CATALYST_TYPES, "none"),
        direction: coerceEnum(it.direction, DIRECTIONS, "neutral"),
        materiality: coerceEnum(it.materiality, MATERIALITIES, "low"),
        why: typeof it.why === "string" ? it.why.slice(0, 240) : "",
      });
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

/** A hard catalyst = real catalyst type AND material enough to surface. */
export function isHardCatalyst(c: CatalystClassification): boolean {
  return c.catalystType !== "none" && (c.materiality === "high" || c.materiality === "medium");
}

/**
 * Classify a ticker's news items (cached per article id) and return the
 * subset that are HARD CATALYSTS, newest first. Returns
 * { catalysts, classified } where `classified` is false only when Claude was
 * unreachable/unconfigured AND nothing was cached.
 */
export async function triageTickerNews(
  ticker: string,
  items: RawNewsItem[],
  held: boolean
): Promise<{ catalysts: NewsCatalyst[]; classified: boolean }> {
  if (items.length === 0) return { catalysts: [], classified: false };

  const keyed = items.map((it, i) => ({
    ...it,
    id: articleId(it.ticker, it.url, it.headline),
    index: i,
  }));

  const cached = await readCached(keyed.map((k) => k.id));
  const uncached = keyed.filter((k) => !cached.has(k.id));

  let classified = cached.size > 0;
  if (uncached.length > 0 && isLlmConfigured()) {
    const scored = await classifyBatch(
      ticker,
      uncached.map((u) => ({
        index: u.index,
        text: `${u.headline}${u.summary ? ` — ${u.summary}` : ""}`,
      }))
    );
    if (scored) {
      classified = true;
      const fresh = new Map<string, CatalystClassification>();
      for (const u of uncached) {
        const v = scored.get(u.index);
        if (v) {
          cached.set(u.id, v);
          fresh.set(u.id, v);
        }
      }
      await writeCached(fresh);
    }
  }

  const catalysts: NewsCatalyst[] = [];
  for (const k of keyed) {
    const cls = cached.get(k.id);
    if (!cls || !isHardCatalyst(cls)) continue;
    catalysts.push({
      ...cls,
      id: k.id,
      ticker: k.ticker,
      held,
      headline: k.headline,
      summary: k.summary,
      source: k.source,
      url: k.url,
      date: new Date(k.datetime * 1000).toISOString().slice(0, 10),
    });
  }
  catalysts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { catalysts, classified };
}

// ---------------------------------------------------------------------------
// Orchestration across names
// ---------------------------------------------------------------------------

export type CatalystName = { ticker: string; held: boolean };

const MATERIALITY_RANK: Record<CatalystMateriality, number> = { high: 0, medium: 1, low: 2 };

/**
 * Pull news + classify across a set of names (holdings + watchlist), returning
 * only hard catalysts. Held names are processed first and ranked highest.
 * Fully null-safe: empty result on any provider/Claude/DB failure.
 */
export async function buildCatalysts(
  names: CatalystName[],
  opts: { days?: number; maxNames?: number } = {}
): Promise<CatalystsResult> {
  const asOf = new Date().toISOString();
  const { days = 14, maxNames = 40 } = opts;

  // Dedupe by ticker; held wins. Held names first (bounded for cost/latency).
  const byTicker = new Map<string, boolean>();
  for (const n of names) {
    const t = n.ticker?.trim().toUpperCase();
    if (!t) continue;
    byTicker.set(t, (byTicker.get(t) ?? false) || n.held);
  }
  const ordered = [...byTicker.entries()]
    .map(([ticker, held]) => ({ ticker, held }))
    .sort((a, b) => Number(b.held) - Number(a.held))
    .slice(0, maxNames);

  if (ordered.length === 0) return { catalysts: [], asOf, classified: false };

  let anyClassified = false;
  const all: NewsCatalyst[] = [];

  // Bounded concurrency so we don't hammer Finnhub / Claude at once.
  const CONCURRENCY = 4;
  for (let i = 0; i < ordered.length; i += CONCURRENCY) {
    const slice = ordered.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (n) => {
        const news = await fetchTickerNews(n.ticker, days).catch(() => [] as RawNewsItem[]);
        return triageTickerNews(n.ticker, news, n.held).catch(() => ({
          catalysts: [] as NewsCatalyst[],
          classified: false,
        }));
      })
    );
    for (const r of results) {
      if (r.classified) anyClassified = true;
      all.push(...r.catalysts);
    }
  }

  // Dedupe by article id and rank: held first, then materiality, then date.
  const seen = new Set<string>();
  const deduped = all.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  deduped.sort((a, b) => {
    if (a.held !== b.held) return Number(b.held) - Number(a.held);
    const m = MATERIALITY_RANK[a.materiality] - MATERIALITY_RANK[b.materiality];
    if (m !== 0) return m;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });

  return { catalysts: deduped, asOf, classified: anyClassified };
}

// ---------------------------------------------------------------------------
// Telegram alerting (provided; NOT auto-invoked during build)
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<CatalystType, string> = {
  earnings: "Earnings",
  guidance: "Guidance",
  m_and_a: "M&A",
  regulatory_legal: "Regulatory/Legal",
  major_contract: "Major Contract",
  none: "—",
};

const DIR_EMOJI: Record<CatalystDirection, string> = {
  bullish: "🟢",
  bearish: "🔴",
  neutral: "⚪",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Push a Telegram alert for HIGH-materiality catalysts on HELD names. Provided
 * for a cron/manual trigger — intentionally NOT called anywhere automatically
 * during the build. Null-safe: no-op when Telegram is unconfigured or there are
 * no qualifying catalysts. Dedupe of repeat sends is delegated to telegram.ts's
 * own machinery via sendTelegramMessage (single combined message here).
 */
export async function alertHighMaterialityCatalysts(
  catalysts: NewsCatalyst[]
): Promise<{ sent: boolean; reason?: string; count: number }> {
  const qualifying = catalysts.filter((c) => c.held && c.materiality === "high");
  if (qualifying.length === 0) return { sent: false, reason: "no high-materiality held catalysts", count: 0 };

  const lines = qualifying
    .slice(0, 12)
    .map(
      (c) =>
        `${DIR_EMOJI[c.direction]} <b>${escapeHtml(c.ticker)}</b> · ${TYPE_LABEL[c.catalystType]} — ${escapeHtml(
          c.headline
        )}`
    );
  const html = `⚡ <b>Hard catalysts</b> (held, high materiality)\n\n${lines.join("\n")}`;

  const res = await sendTelegramMessage(html);
  return { sent: res.sent, reason: res.reason, count: qualifying.length };
}
