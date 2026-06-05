import "server-only";
import { isDatabaseConfigured, getPool, query } from "@/lib/db";
import type { ArticleImpactAnalysis } from "@/lib/types";

/**
 * Postgres-backed persistence for the Article Impact Analyzer.
 *
 * The full analysis object is stored in a `payload` JSONB column; a handful of
 * scalar columns (url / ticker / headline / verdict / impact_score) are pulled
 * out for cheap querying and display. Reads return the JSONB payload verbatim,
 * so the round-trip is lossless.
 *
 * Mirrors the cached-promise schema pattern from db.ts and is a no-op whenever
 * DATABASE_URL is not configured (keeps local/mock runs working).
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS article_analyses (
  id           SERIAL PRIMARY KEY,
  url          TEXT,
  ticker       TEXT,
  headline     TEXT,
  verdict      TEXT,
  impact_score INT,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_analyses_created ON article_analyses (created_at DESC);
`;

let schemaReady: Promise<void> | null = null;

/** Idempotently create the analyzer table. Cached so it runs once per process. */
export function ensureAnalyzerSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await getPool().query(SCHEMA_SQL);
    })().catch((err) => {
      schemaReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return schemaReady;
}

/** Persist one analysis. No-op when the database is not configured. */
export async function saveAnalysis(a: ArticleImpactAnalysis): Promise<void> {
  if (!isDatabaseConfigured()) return;
  await ensureAnalyzerSchema();
  await query(
    `INSERT INTO article_analyses (url, ticker, headline, verdict, impact_score, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      a.url,
      a.selectedTicker,
      a.headline,
      a.impactAssessment.verdict,
      a.impactAssessment.impactScore,
      JSON.stringify(a),
    ]
  );
}

type AnalysisRow = { payload: ArticleImpactAnalysis };

/** Newest-first list of stored analyses. Empty when no database is configured. */
export async function listAnalyses(limit = 25): Promise<ArticleImpactAnalysis[]> {
  if (!isDatabaseConfigured()) return [];
  await ensureAnalyzerSchema();
  const rows = await query<AnalysisRow>(
    `SELECT payload FROM article_analyses ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.payload);
}
