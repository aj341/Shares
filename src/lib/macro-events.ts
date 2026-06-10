import "server-only";

/**
 * Macro catalysts that move the whole book: FOMC rate decisions and US CPI
 * releases. STATIC, verified-from-source calendar (federalreserve.gov / BLS)
 * — dates are official schedule entries, never guessed. Decision date listed
 * is the second day of each FOMC meeting (statement + press conference).
 *
 * Extend this list as the BLS publishes later-2026 CPI dates.
 */

export type MacroEvent = {
  /** Display ticker: "FED" or "CPI". */
  ticker: string;
  date: string; // YYYY-MM-DD (US Eastern release day)
  detail: string;
};

const MACRO_CALENDAR: MacroEvent[] = [
  // FOMC 2026 (statement day of each remaining meeting)
  { ticker: "FED", date: "2026-06-17", detail: "FOMC rate decision + projections" },
  { ticker: "FED", date: "2026-07-29", detail: "FOMC rate decision" },
  { ticker: "FED", date: "2026-09-16", detail: "FOMC rate decision + projections" },
  { ticker: "FED", date: "2026-10-28", detail: "FOMC rate decision" },
  { ticker: "FED", date: "2026-12-09", detail: "FOMC rate decision + projections" },
  // US CPI releases (BLS confirmed)
  { ticker: "CPI", date: "2026-07-14", detail: "US CPI (June data)" },
  { ticker: "CPI", date: "2026-08-12", detail: "US CPI (July data)" },
];

/** Upcoming macro events within `days`, soonest first, with daysAway. */
export function getUpcomingMacroEvents(
  days = 45
): Array<MacroEvent & { daysAway: number }> {
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return MACRO_CALENDAR.map((e) => ({
    ...e,
    daysAway: Math.round((Date.parse(`${e.date}T00:00:00Z`) - todayMs) / 86_400_000),
  }))
    .filter((e) => e.daysAway >= 0 && e.daysAway <= days)
    .sort((a, b) => a.daysAway - b.daysAway);
}
