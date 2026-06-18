import "server-only";

/**
 * [exthours] US market-session clock.
 *
 * Pure, dependency-free determination of the current US equity trading session
 * from a wall-clock time, evaluated in US/Eastern (the exchange timezone, which
 * also handles DST automatically). This is the gate that decides whether the
 * dashboard should surface an extended-hours print instead of the prior
 * regular-session close.
 *
 *   pre      04:00-09:30 ET
 *   regular  09:30-16:00 ET
 *   post     16:00-20:00 ET
 *   closed   everything else (overnight + weekends)
 *
 * Session boundaries are the standard NYSE/Nasdaq hours. We intentionally do
 * NOT special-case exchange holidays: on a holiday the upstream feed simply
 * returns no fresh extended-hours print, and the caller falls back to the prior
 * close - so a missing holiday calendar can never fabricate a price.
 */

export type MarketSession = "pre" | "regular" | "post" | "closed";

const PRE_OPEN = 4 * 60; // 04:00
const REGULAR_OPEN = 9 * 60 + 30; // 09:30
const REGULAR_CLOSE = 16 * 60; // 16:00
const POST_CLOSE = 20 * 60; // 20:00

/**
 * US/Eastern wall-clock weekday + minute-of-day for an instant. Uses Intl with
 * timeZone "America/New_York" so DST is handled by the runtime; no external tz
 * library required.
 */
function easternParts(at: Date): { weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = wdMap[get("weekday")] ?? 0;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit "24" at midnight under hour12:false
  const minutes = hour * 60 + Number(get("minute"));
  return { weekday, minutes };
}

/** Current US market session for the given instant (defaults to now). */
export function getMarketSession(at: Date = new Date()): MarketSession {
  const { weekday, minutes } = easternParts(at);
  if (weekday === 0 || weekday === 6) return "closed"; // Sun / Sat
  if (minutes >= PRE_OPEN && minutes < REGULAR_OPEN) return "pre";
  if (minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE) return "regular";
  if (minutes >= REGULAR_CLOSE && minutes < POST_CLOSE) return "post";
  return "closed";
}

/** True when the regular session is open (keeps the Finnhub path unchanged). */
export function isRegularSessionOpen(at: Date = new Date()): boolean {
  return getMarketSession(at) === "regular";
}

/** Short human label for a session (UI badge). */
export function sessionLabel(session: MarketSession): string {
  switch (session) {
    case "pre":
      return "Pre-Market";
    case "post":
      return "After Hours";
    case "regular":
      return "Market Open";
    case "closed":
      return "Closed";
  }
}
