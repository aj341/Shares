import "server-only";
import {
  getEconomicEventsRaw,
  isMboumConfigured,
  type MboumEconEventRaw,
} from "@/lib/mboum";
import { getUpcomingMacroEvents } from "@/lib/macro-events";

/**
 * [scanner] Economic-calendar awareness for the daily trader.
 *
 * Two jobs, both ADDITIVE and null-safe:
 *   1. Surface today's / upcoming HIGH-IMPACT US macro events (CPI, FOMC, NFP,
 *      PCE, retail sales, jobless claims, GDP, ...) from Mboum's
 *      /markets/calendar/economic_events feed.
 *   2. Compute a simple intraday "blackout window" flag — true when we are
 *      within +/- N minutes of a high-impact release, so the scanner can warn
 *      against fresh opening-range entries into a known volatility event.
 *
 * The Mboum feed's exact field names vary by plan, so parsing is defensive:
 * every field is probed across several likely keys and any unparseable row is
 * dropped. When Mboum is unconfigured or returns nothing, we fall back to the
 * app's STATIC, source-verified macro calendar (macro-events.ts) so the strip
 * still shows the next FOMC / CPI. Nothing here touches score/Signal math.
 */

export type EconImpact = "high" | "medium" | "low";

export type EconEvent = {
  /** Event title, e.g. "CPI m/m", "FOMC Rate Decision", "Nonfarm Payrolls". */
  title: string;
  /** ISO country code or name when available ("US", "United States"). */
  country: string | null;
  /** Normalised impact bucket. */
  impact: EconImpact;
  /** Event time as epoch ms (UTC) when derivable, else null. */
  timeMs: number | null;
  /** YYYY-MM-DD (UTC) for grouping; always present (derived from timeMs/raw). */
  date: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  /** Minutes from now until the event (negative = already passed); null if no time. */
  minutesAway: number | null;
};

export type BlackoutWindow = {
  /** True when within +/- windowMinutes of a high-impact event right now. */
  active: boolean;
  /** The event that triggered the blackout, when active. */
  event: EconEvent | null;
  /** The +/- window (minutes) used for the flag. */
  windowMinutes: number;
};

export type EconCalendar = {
  /** Events for "today" (UTC), soonest first. */
  today: EconEvent[];
  /** High-impact events within the upcoming-window (incl. today), soonest first. */
  upcomingHighImpact: EconEvent[];
  /** Intraday blackout flag for opening-range entries. */
  blackout: BlackoutWindow;
  asOf: string;
  /** "mboum" when the live feed populated it, "static" for the macro fallback. */
  source: "mboum" | "static" | "none";
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** +/- minutes around a high-impact release that counts as "blackout". */
export const ECON_BLACKOUT_MINUTES = envNum("ECON_BLACKOUT_MINUTES", 30);
/** How many days ahead to surface upcoming high-impact events. */
export const ECON_UPCOMING_DAYS = envNum("ECON_UPCOMING_DAYS", 7);

// ---------------------------------------------------------------------------
// Defensive field extraction
// ---------------------------------------------------------------------------

function pickString(row: MboumEconEventRaw, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Parse a time from several candidate fields (epoch s/ms, ISO, or date+time). */
function pickTimeMs(row: MboumEconEventRaw): number | null {
  for (const k of ["timestamp", "time_ms", "epoch", "datetime_ms"]) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v;
    }
  }
  for (const k of ["datetime", "date_utc", "dateTime", "time", "date"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v;
    }
  }
  return null;
}

const HIGH_IMPACT_RE =
  /\b(cpi|fomc|federal funds|rate decision|interest rate|non[- ]?farm|nonfarm|nfp|payroll|pce|core pce|gdp|unemployment rate|jobless claims|retail sales|ppi|fed chair|powell)\b/i;

function normaliseImpact(row: MboumEconEventRaw, title: string): EconImpact {
  const raw = pickString(row, [
    "impact",
    "importance",
    "impactLevel",
    "volatility",
  ]);
  if (raw) {
    const s = raw.toLowerCase();
    if (/high|3|red/.test(s)) return "high";
    if (/med|2|orange|amber/.test(s)) return "medium";
    if (/low|1|yellow|gray|grey/.test(s)) return "low";
  }
  return HIGH_IMPACT_RE.test(title) ? "high" : "low";
}

function isUsEvent(country: string | null): boolean {
  if (!country) return true; // keep when unknown rather than silently dropping
  const c = country.toLowerCase();
  return /^(us|usa|u\.s\.|united states)$/.test(c) || c.includes("united states");
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Parse + assemble
// ---------------------------------------------------------------------------

function parseRow(row: MboumEconEventRaw, nowMs: number): EconEvent | null {
  const title = pickString(row, [
    "event",
    "title",
    "name",
    "indicator",
    "report",
  ]);
  if (!title) return null;

  const country = pickString(row, ["country", "countryCode", "region", "nation"]);
  const timeMs = pickTimeMs(row);
  const date = timeMs != null ? isoDate(timeMs) : isoDate(nowMs);
  const impact = normaliseImpact(row, title);

  return {
    title,
    country,
    impact,
    timeMs,
    date,
    actual: pickString(row, ["actual", "actualValue", "act"]),
    forecast: pickString(row, ["forecast", "estimate", "consensus", "est"]),
    previous: pickString(row, ["previous", "prior", "prev"]),
    minutesAway:
      timeMs != null ? Math.round((timeMs - nowMs) / 60000) : null,
  };
}

/** Build the EconEvent list from the live Mboum feed (US, deduped). */
async function liveEvents(nowMs: number): Promise<EconEvent[]> {
  const raw = await getEconomicEventsRaw().catch(() => []);
  const seen = new Set<string>();
  const out: EconEvent[] = [];
  for (const r of raw) {
    const ev = parseRow(r, nowMs);
    if (!ev) continue;
    if (!isUsEvent(ev.country)) continue;
    const key = `${ev.date}|${ev.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

/** Fallback EconEvents from the static, source-verified macro calendar. */
function staticEvents(nowMs: number): EconEvent[] {
  return getUpcomingMacroEvents(ECON_UPCOMING_DAYS).map((m) => {
    const timeMs = Date.parse(`${m.date}T00:00:00Z`);
    return {
      title: m.ticker === "FED" ? `FOMC — ${m.detail}` : `CPI — ${m.detail}`,
      country: "US",
      impact: "high" as const,
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
      date: m.date,
      actual: null,
      forecast: null,
      previous: null,
      minutesAway: Number.isFinite(timeMs)
        ? Math.round((timeMs - nowMs) / 60000)
        : null,
    };
  });
}

function computeBlackout(events: EconEvent[]): BlackoutWindow {
  const win = ECON_BLACKOUT_MINUTES;
  let hit: EconEvent | null = null;
  for (const e of events) {
    if (e.impact !== "high" || e.minutesAway == null) continue;
    if (Math.abs(e.minutesAway) <= win) {
      if (!hit || Math.abs(e.minutesAway) < Math.abs(hit.minutesAway ?? 1e9)) {
        hit = e;
      }
    }
  }
  return { active: hit != null, event: hit, windowMinutes: win };
}

// ---------------------------------------------------------------------------
// Public builder (cached)
// ---------------------------------------------------------------------------

const TTL_MS = 15 * 60 * 1000; // 15 min — macro calendar barely moves intraday.
let CACHE: { ts: number; data: EconCalendar } | null = null;

export async function buildEconCalendar(): Promise<EconCalendar> {
  if (CACHE && Date.now() - CACHE.ts < TTL_MS) return CACHE.data;

  const nowMs = Date.now();
  const asOf = new Date(nowMs).toISOString();
  const todayStr = isoDate(nowMs);

  let events: EconEvent[] = [];
  let source: EconCalendar["source"] = "none";

  if (isMboumConfigured()) {
    events = await liveEvents(nowMs);
    if (events.length > 0) source = "mboum";
  }
  if (events.length === 0) {
    events = staticEvents(nowMs);
    source = events.length > 0 ? "static" : "none";
  }

  const horizonMs = nowMs + ECON_UPCOMING_DAYS * 24 * 60 * 60 * 1000;

  const today = events
    .filter((e) => e.date === todayStr)
    .sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));

  const upcomingHighImpact = events
    .filter(
      (e) =>
        e.impact === "high" &&
        (e.timeMs == null ||
          (e.timeMs >= nowMs - 12 * 3600000 && e.timeMs <= horizonMs))
    )
    .sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity))
    .slice(0, 12);

  const data: EconCalendar = {
    today,
    upcomingHighImpact,
    blackout: computeBlackout(today),
    asOf,
    source,
  };
  CACHE = { ts: Date.now(), data };
  return data;
}
