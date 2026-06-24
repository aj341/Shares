import "server-only";
import { buildJournal, type JournalTrade } from "@/lib/journal";

/**
 * [journal] Execution / slippage analytics.
 *
 * Read-only, additive. Re-uses the trade journal (which already estimates
 * per-leg slippage as fill-vs-close in bps) and rolls it up by signal type and
 * entry time-of-day. Each leg (entry fill, exit fill) is one slippage
 * observation.
 *
 * HONESTY -- what IS estimable from the available data:
 *   - The ledger stores the actual fill (pricePerShare) for every BUY/SELL.
 *   - Mboum gives the daily CLOSE for the same date.
 *   => We can estimate slippage = fill vs same-day close. This conflates
 *      intraday timing with true execution slippage (we lack the bid/ask and
 *      the exact decision-time price), so it is an APPROXIMATION, clearly
 *      labelled. We do NOT have a "signal-bar price" (no intraday signal
 *      timestamp is stored), so a true arrival-price slippage is NOT estimable.
 *
 * What is NOT estimable and is reported as such:
 *   - Spread paid / quoted bid-ask at fill time (no quote history stored).
 *   - True liquidity (ADV) -- we do not pull volume here; we therefore omit a
 *     liquidity dimension rather than fabricate one, and say so.
 */

export type SlippageGroup = {
  tag: string;
  /** Number of fills (legs) contributing to this group. */
  fills: number;
  /** Mean slippage in bps (positive = worse than close). */
  meanBps: number | null;
  /** Median slippage in bps. */
  medianBps: number | null;
  /** Best (most negative) and worst (most positive) leg. */
  bestBps: number | null;
  worstBps: number | null;
};

export type ExecutionStats = {
  /** Every fill leg, flattened (entry + exit), for transparency. */
  legs: Array<{
    ticker: string;
    side: "entry" | "exit";
    date: string;
    fillPrice: number;
    slippageBps: number;
    signalAtEntry: string | null;
    timeOfDay: string;
  }>;
  overall: SlippageGroup;
  bySignal: SlippageGroup[];
  byTimeOfDay: SlippageGroup[];
  methodology: {
    reference: string;
    estimable: string;
    notEstimable: string;
  };
  data: { hasExcursion: boolean; totalLegs: number };
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function group(
  legs: ExecutionStats["legs"],
  keyOf: (l: ExecutionStats["legs"][number]) => string
): SlippageGroup[] {
  const map = new Map<string, number[]>();
  for (const l of legs) {
    const k = keyOf(l);
    const arr = map.get(k) ?? [];
    arr.push(l.slippageBps);
    map.set(k, arr);
  }
  const out: SlippageGroup[] = [];
  for (const [tag, bps] of map) out.push(groupFor(tag, bps));
  return out.sort((a, b) => b.fills - a.fills);
}

function groupFor(tag: string, bps: number[]): SlippageGroup {
  const mean = bps.length ? bps.reduce((s, x) => s + x, 0) / bps.length : null;
  return {
    tag,
    fills: bps.length,
    meanBps: mean != null ? Math.round(mean) : null,
    medianBps: bps.length ? Math.round(median(bps)!) : null,
    bestBps: bps.length ? Math.min(...bps) : null,
    worstBps: bps.length ? Math.max(...bps) : null,
  };
}

const TOD_LABELS: Record<string, string> = {
  pre: "Pre-market",
  open: "Open (9:30-10:30)",
  midday: "Midday",
  close: "Close (2-4pm)",
  after: "After hours",
  unknown: "Unknown time",
};

export async function buildExecutionStats(): Promise<ExecutionStats> {
  const journal = await buildJournal();

  const legs: ExecutionStats["legs"] = [];
  for (const t of journal.trades as JournalTrade[]) {
    if (t.entrySlippageBps != null) {
      legs.push({
        ticker: t.ticker,
        side: "entry",
        date: t.entryDate,
        fillPrice: t.entryPrice,
        slippageBps: t.entrySlippageBps,
        signalAtEntry: t.signalAtEntry,
        timeOfDay: TOD_LABELS[t.entryTimeOfDay] ?? t.entryTimeOfDay,
      });
    }
    if (t.exitDate && t.exitPrice != null && t.exitSlippageBps != null) {
      legs.push({
        ticker: t.ticker,
        side: "exit",
        date: t.exitDate,
        fillPrice: t.exitPrice,
        slippageBps: t.exitSlippageBps,
        signalAtEntry: t.signalAtEntry,
        timeOfDay: TOD_LABELS[t.entryTimeOfDay] ?? t.entryTimeOfDay,
      });
    }
  }

  const allBps = legs.map((l) => l.slippageBps);

  return {
    legs: legs.sort((a, b) => (a.date < b.date ? 1 : -1)),
    overall: groupFor("All fills", allBps),
    bySignal: group(legs, (l) => l.signalAtEntry ?? "Untagged"),
    byTimeOfDay: group(legs, (l) => l.timeOfDay),
    methodology: {
      reference:
        "Slippage estimated as fill price vs the SAME-DAY closing price " +
        "(Mboum daily bar). Entry: (fill - close)/close. Exit: (close - fill)/close. " +
        "Positive bps = executed worse than the close.",
      estimable:
        "Fill vs same-day close is estimable from the ledger fills + Mboum closes.",
      notEstimable:
        "True arrival-price slippage, quoted spread, and ADV-based liquidity " +
        "buckets are NOT estimable -- no intraday decision timestamp, bid/ask, " +
        "or volume-at-fill is stored. Values are timing approximations, not " +
        "true microstructure slippage.",
    },
    data: { hasExcursion: journal.data.excursionUsed, totalLegs: legs.length },
  };
}
