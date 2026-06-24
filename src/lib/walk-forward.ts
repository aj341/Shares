import "server-only";

// [wfa] WALK-FORWARD validation.
// ---------------------------------------------------------------------------
// Extends the existing FULL-SAMPLE calibration (src/lib/calibration.ts) from a
// single in-sample fit to a ROLLING out-of-sample test. It NEVER changes the
// score, the signal, or the calibration math — it only re-runs the existing
// `computeCalibration` engine over disjoint in-sample (IS) and out-of-sample
// (OOS) slices of the SAME score_snapshots history, then compares the edge an
// IS window "discovered" against how that edge actually performed OOS.
//
// WHY THIS IS HONEST ABOUT DATA
//   The snapshot table is young, so most rolling windows will be sparse. Every
//   bucket carries its OOS sample count, and a window/band with too few matured
//   OOS samples is explicitly labelled "insufficient" rather than reported as a
//   real edge. The whole result degrades gracefully to an empty, clearly-marked
//   payload when there is no DB or not enough history — never throws.
//
// METHODOLOGY (rolling walk-forward):
//   1. Read all snapshots (same source as calibration: ticker/score/signal/
//      price/captured_at).
//   2. Order the DISTINCT snapshot calendar dates. Slice the timeline into a
//      sequence of folds. Each fold has:
//        - an IN-SAMPLE window  [isStart, isEnd)
//        - an OUT-OF-SAMPLE window [isEnd, oosEnd)  (strictly later in time)
//      so the OOS window is always *forward* of the IS window it is testing —
//      this is the walk-forward guarantee (no peeking at OOS when "fitting").
//   3. For each fold, run `computeCalibration` separately on the IS snapshots
//      and on the OOS snapshots. computeCalibration already enforces the strict
//      lookahead rule for forward prices, so each slice's edge is leak-free.
//   4. Per signal-band x horizon, compare IS edge vs OOS edge. The "overfit
//      degradation" is (IS edge - OOS edge): large positive => the in-sample
//      edge did NOT survive out of sample (overfit / fragile). We aggregate
//      these across folds into a simple, honest overfit indicator.
//
// This module is PURE given an injected snapshot loader + history provider, so
// it is unit-testable and side-effect-free except for the optional DB read in
// the convenience wrapper.

import {
  computeCalibration,
  loadCalibrationSnapshots,
  CALIBRATION_HORIZONS_DAYS,
  MIN_SAMPLES_FOR_CONVICTION,
  type Calibration,
  type CalibrationSnapshot,
  type ComputeCalibrationOpts,
  type HorizonDays,
} from "@/lib/calibration";

// ---------------------------------------------------------------------------
// Tunables (all local + clearly labelled).
// ---------------------------------------------------------------------------

/** Calendar-day span of each in-sample window. */
const DEFAULT_IS_WINDOW_DAYS = 60;
/** Calendar-day span of each out-of-sample window (forward of the IS window). */
const DEFAULT_OOS_WINDOW_DAYS = 30;
/** How far the window pair advances between folds. */
const DEFAULT_STEP_DAYS = 30;
/** Hard ceiling on folds so a long history can't explode the candle fetches. */
const MAX_FOLDS = 12;

/**
 * Minimum matured OOS samples in a (band|horizon) bucket before we treat its
 * OOS edge as real. Below this it is reported but flagged `insufficient`.
 * Reuses the calibration module's own conviction floor so the two stay aligned.
 */
const MIN_OOS_SAMPLES = MIN_SAMPLES_FOR_CONVICTION;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WalkForwardOpts = ComputeCalibrationOpts & {
  isWindowDays?: number;
  oosWindowDays?: number;
  stepDays?: number;
  maxFolds?: number;
};

/** One band's IS-vs-OOS comparison within a single fold + horizon. */
export type WalkForwardBucket = {
  band: string;
  horizonDays: HorizonDays;
  /** In-sample stats. */
  isSampleSize: number;
  isWinRate: number;
  isAvgReturn: number;
  isEdge: number;
  /** Out-of-sample stats. */
  oosSampleSize: number;
  oosWinRate: number;
  oosAvgReturn: number;
  oosEdge: number;
  /** IS edge - OOS edge. Positive => edge decayed out of sample. */
  edgeDegradation: number;
  /** True when OOS samples are too sparse to trust this row. */
  insufficient: boolean;
};

export type WalkForwardFold = {
  index: number;
  /** Window bounds (ISO dates, inclusive start / exclusive end). */
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  isSnapshots: number;
  oosSnapshots: number;
  isSamples: number;
  oosSamples: number;
  buckets: WalkForwardBucket[];
};

/** Aggregate of one band across ALL folds (the headline OOS track record). */
export type WalkForwardBandSummary = {
  band: string;
  horizonDays: HorizonDays;
  /** Folds that had enough OOS samples to count. */
  foldsCounted: number;
  /** Total matured OOS samples across counted folds. */
  oosSamples: number;
  /** Sample-weighted mean OOS win-rate across counted folds. */
  oosWinRate: number;
  /** Sample-weighted mean OOS average forward return across counted folds. */
  oosAvgReturn: number;
  /** Sample-weighted mean OOS edge. */
  oosEdge: number;
  /** Sample-weighted mean IS edge (for the degradation comparison). */
  isEdge: number;
  /** isEdge - oosEdge, sample-weighted. Positive => overfit / decayed. */
  edgeDegradation: number;
  /** Honest label when no counted fold cleared the OOS sample floor. */
  insufficient: boolean;
};

export type OverfitVerdict = "robust" | "mild" | "overfit" | "insufficient";

export type WalkForward = {
  folds: WalkForwardFold[];
  bandSummaries: WalkForwardBandSummary[];
  horizons: HorizonDays[];
  /** Config actually used (echoed for transparency). */
  config: {
    isWindowDays: number;
    oosWindowDays: number;
    stepDays: number;
    minOosSamples: number;
  };
  /** Snapshot-table scale, so the UI can be honest about sparsity. */
  totalSnapshots: number;
  distinctDates: number;
  /** Total matured OOS samples that cleared the sample floor (all bands). */
  countedOosSamples: number;
  /**
   * One-line overfit indicator across the whole grid:
   *   meanEdgeDegradation = avg(IS edge - OOS edge) over counted band-summaries.
   *   verdict bins it into robust / mild / overfit, or 'insufficient' when no
   *   counted band cleared the OOS floor.
   */
  meanEdgeDegradation: number;
  overfitVerdict: OverfitVerdict;
  /** True when there simply wasn't enough data to walk forward at all. */
  insufficientData: boolean;
  computedAt: string;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toISO(d: string | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ms =
    new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime();
  return Math.round(ms / 86_400_000);
}

/** Edge in roughly [-1,1], mirroring calibration's win-rate-centred edge but
 *  computed from the public bucket stats we already have (winRateVsBenchmark
 *  + avgExcessReturn). Kept here so walk-forward never re-implements the score
 *  math; it only re-reads calibration's output. */
const EDGE_SCALE = 0.05;
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function edgeFromStat(winRateVsBench: number, avgExcess: number): number {
  return winRateVsBench - 0.5 + clamp(avgExcess / EDGE_SCALE, -1, 1) * 0.5;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** The score bands we report on (high -> low), matching the calibration panel. */
const BAND_ORDER = ["STRONG_BUY", "BUY", "HOLD", "TRIM", "SELL"];

// ---------------------------------------------------------------------------
// Core: computeWalkForward (PURE given the snapshots + injected history)
// ---------------------------------------------------------------------------

export async function computeWalkForward(
  snapshots: CalibrationSnapshot[],
  opts: WalkForwardOpts = {}
): Promise<WalkForward> {
  const horizons = (opts.horizons ?? CALIBRATION_HORIZONS_DAYS) as HorizonDays[];
  const isWindowDays = opts.isWindowDays ?? DEFAULT_IS_WINDOW_DAYS;
  const oosWindowDays = opts.oosWindowDays ?? DEFAULT_OOS_WINDOW_DAYS;
  const stepDays = opts.stepDays ?? DEFAULT_STEP_DAYS;
  const maxFolds = opts.maxFolds ?? MAX_FOLDS;

  const config = {
    isWindowDays,
    oosWindowDays,
    stepDays,
    minOosSamples: MIN_OOS_SAMPLES,
  };

  const norm = (snapshots ?? [])
    .map((s) => ({ ...s, date: toISO(s.date), price: Number(s.price) }))
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const dates = [...new Set(norm.map((s) => s.date))].sort();
  const totalSnapshots = norm.length;
  const distinctDates = dates.length;

  // Honest empty state: we need at least one IS window + one forward OOS window
  // of history. With a young table this is the common case.
  const minSpanDays = isWindowDays + oosWindowDays;
  const spanDays =
    dates.length >= 2 ? daysBetween(dates[0], dates[dates.length - 1]) : 0;

  if (distinctDates < 2 || spanDays < minSpanDays) {
    return {
      folds: [],
      bandSummaries: [],
      horizons,
      config,
      totalSnapshots,
      distinctDates,
      countedOosSamples: 0,
      meanEdgeDegradation: 0,
      overfitVerdict: "insufficient",
      insufficientData: true,
      computedAt: new Date().toISOString(),
    };
  }

  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];

  // Build the rolling fold windows. Each IS window is forward-tested by the OOS
  // window immediately after it; the pair then steps forward by stepDays.
  const folds: WalkForwardFold[] = [];
  let isStart = firstDate;
  let foldIdx = 0;
  while (foldIdx < maxFolds) {
    const isEnd = addDays(isStart, isWindowDays); // exclusive
    const oosStart = isEnd;
    const oosEnd = addDays(oosStart, oosWindowDays); // exclusive
    // Stop once the OOS window runs past the available history.
    if (oosStart > lastDate) break;

    const isSnaps = norm.filter((s) => s.date >= isStart && s.date < isEnd);
    const oosSnaps = norm.filter((s) => s.date >= oosStart && s.date < oosEnd);

    // Only build a fold when BOTH windows actually contain snapshots — an empty
    // IS or OOS window yields no comparison and is skipped (still advances).
    if (isSnaps.length > 0 && oosSnaps.length > 0) {
      const [isCal, oosCal] = await Promise.all([
        computeCalibration(isSnaps, { ...opts, horizons }),
        computeCalibration(oosSnaps, { ...opts, horizons }),
      ]);
      folds.push(
        buildFold(foldIdx, isStart, isEnd, oosStart, oosEnd, isCal, oosCal, horizons)
      );
      foldIdx += 1;
    }

    isStart = addDays(isStart, stepDays);
    if (isStart > lastDate) break;
  }

  const bandSummaries = summariseBands(folds, horizons);

  // Headline overfit indicator: mean IS-OOS edge degradation over band-summaries
  // that cleared the OOS sample floor.
  const counted = bandSummaries.filter((b) => !b.insufficient);
  const countedOosSamples = counted.reduce((s, b) => s + b.oosSamples, 0);
  const meanEdgeDegradation =
    counted.length > 0
      ? round4(
          counted.reduce((s, b) => s + b.edgeDegradation, 0) / counted.length
        )
      : 0;

  const overfitVerdict: OverfitVerdict =
    counted.length === 0
      ? "insufficient"
      : meanEdgeDegradation <= 0.05
        ? "robust"
        : meanEdgeDegradation <= 0.15
          ? "mild"
          : "overfit";

  return {
    folds,
    bandSummaries,
    horizons,
    config,
    totalSnapshots,
    distinctDates,
    countedOosSamples,
    meanEdgeDegradation,
    overfitVerdict,
    insufficientData: counted.length === 0,
    computedAt: new Date().toISOString(),
  };
}

function buildFold(
  index: number,
  isStart: string,
  isEnd: string,
  oosStart: string,
  oosEnd: string,
  isCal: Calibration,
  oosCal: Calibration,
  horizons: HorizonDays[]
): WalkForwardFold {
  const buckets: WalkForwardBucket[] = [];
  for (const band of BAND_ORDER) {
    for (const h of horizons) {
      const isStat = isCal.byBand[band]?.[h];
      const oosStat = oosCal.byBand[band]?.[h];
      if (!isStat && !oosStat) continue;

      const isEdge = isStat
        ? round4(edgeFromStat(isStat.winRateVsBenchmark, isStat.avgExcessReturn))
        : 0;
      const oosEdge = oosStat
        ? round4(
            edgeFromStat(oosStat.winRateVsBenchmark, oosStat.avgExcessReturn)
          )
        : 0;
      const oosSampleSize = oosStat?.sampleSize ?? 0;

      buckets.push({
        band,
        horizonDays: h,
        isSampleSize: isStat?.sampleSize ?? 0,
        isWinRate: isStat?.winRate ?? 0,
        isAvgReturn: isStat?.avgReturn ?? 0,
        isEdge,
        oosSampleSize,
        oosWinRate: oosStat?.winRate ?? 0,
        oosAvgReturn: oosStat?.avgReturn ?? 0,
        oosEdge,
        edgeDegradation: round4(isEdge - oosEdge),
        insufficient: oosSampleSize < MIN_OOS_SAMPLES,
      });
    }
  }

  return {
    index,
    isStart,
    isEnd,
    oosStart,
    oosEnd,
    isSnapshots: isCal.totalSnapshots,
    oosSnapshots: oosCal.totalSnapshots,
    isSamples: isCal.totalSamples,
    oosSamples: oosCal.totalSamples,
    buckets,
  };
}

/**
 * Roll every fold's per-band OOS result up into one summary per (band,horizon),
 * sample-weighting across folds so a 30-sample fold counts more than a 2-sample
 * one. A summary is `insufficient` when NO fold cleared the OOS sample floor.
 */
function summariseBands(
  folds: WalkForwardFold[],
  horizons: HorizonDays[]
): WalkForwardBandSummary[] {
  const out: WalkForwardBandSummary[] = [];
  for (const band of BAND_ORDER) {
    for (const h of horizons) {
      const rows = folds
        .flatMap((f) => f.buckets)
        .filter((b) => b.band === band && b.horizonDays === h);
      if (rows.length === 0) continue;

      // Count only folds with enough OOS samples for the weighted OOS stats.
      const counted = rows.filter((r) => !r.insufficient);
      const oosSamples = counted.reduce((s, r) => s + r.oosSampleSize, 0);

      if (counted.length === 0 || oosSamples === 0) {
        out.push({
          band,
          horizonDays: h,
          foldsCounted: 0,
          oosSamples: rows.reduce((s, r) => s + r.oosSampleSize, 0),
          oosWinRate: 0,
          oosAvgReturn: 0,
          oosEdge: 0,
          isEdge: 0,
          edgeDegradation: 0,
          insufficient: true,
        });
        continue;
      }

      const wmean = (pick: (r: WalkForwardBucket) => number) =>
        counted.reduce((s, r) => s + pick(r) * r.oosSampleSize, 0) / oosSamples;

      const oosEdge = round4(wmean((r) => r.oosEdge));
      const isEdge = round4(wmean((r) => r.isEdge));

      out.push({
        band,
        horizonDays: h,
        foldsCounted: counted.length,
        oosSamples,
        oosWinRate: round4(wmean((r) => r.oosWinRate)),
        oosAvgReturn: round4(wmean((r) => r.oosAvgReturn)),
        oosEdge,
        isEdge,
        edgeDegradation: round4(isEdge - oosEdge),
        insufficient: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB-backed convenience (impure): read snapshots -> computeWalkForward.
// Returns null when no DB / no snapshots, mirroring getCalibration().
// ---------------------------------------------------------------------------

export async function getWalkForward(
  opts: WalkForwardOpts = {}
): Promise<WalkForward | null> {
  const snapshots = await loadCalibrationSnapshots();
  if (snapshots.length === 0) return null;
  return computeWalkForward(snapshots, opts);
}
