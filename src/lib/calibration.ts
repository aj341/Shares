import "server-only";
import { isDatabaseConfigured, query } from "@/lib/db";
import { getPool } from "@/lib/db";

// [calibration] Local, idempotent guard for the shared score_snapshots table.
// Mirrors backtest.ensureSnapshotSchema but kept here to avoid an import cycle
// (portfolio -> calibration -> backtest -> portfolio). CREATE ... IF NOT EXISTS
// is safe to run alongside backtest's identical statement; we never alter it.
let calibSchemaReady: Promise<void> | null = null;
function ensureSnapshotSchema(): Promise<void> {
  if (!calibSchemaReady) {
    calibSchemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS score_snapshots (
  id          SERIAL PRIMARY KEY,
  ticker      TEXT NOT NULL,
  score       INT NOT NULL,
  signal      TEXT NOT NULL,
  price       NUMERIC NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`
      )
      .then(() => undefined)
      .catch((err) => {
        calibSchemaReady = null;
        throw err;
      });
  }
  return calibSchemaReady;
}
import { getStockHistory, type MboumCandle } from "@/lib/mboum";
import { signalFromScore } from "@/lib/constants";
import type { Signal } from "@/lib/types";

/**
 * [calibration] Signal/score-band conviction calibration.
 * ----------------------------------------------------------------------------
 * PURPOSE
 *   Measure how the app's OWN historical scores/signals predicted forward
 *   returns, and expose a *conviction overlay* derived purely from that track
 *   record. This is ADDITIVE: it never touches the base 0-100 score or the
 *   Signal. It only answers "how much has this band/signal earned our trust?".
 *
 * DATA SOURCE
 *   Reads accumulated `score_snapshots` rows (ticker, score, signal, price,
 *   captured_at) - the same table the existing fixed-horizon backtest uses. We
 *   do NOT write or alter that table here.
 *
 * FORWARD-RETURN METHODOLOGY (and how lookahead bias is avoided)
 *   For each snapshot S (ticker T, date D, price P) and each horizon H (in
 *   CALENDAR days ~ 5 / 20 / 60), the forward return is:
 *
 *       fwdReturn = (forwardPrice - P) / P
 *
 *   where `forwardPrice` is sourced, in priority order:
 *     1. The SAME ticker's later snapshot whose captured_at is STRICTLY AFTER D
 *        and closest to D + H days (within a tolerance window). Snapshots are a
 *        free, already-recorded forward price.
 *     2. Fallback: a daily candle from Mboum getStockHistory(T) closest to the
 *        target date D + H, again STRICTLY AFTER D.
 *
 *   LOOKAHEAD GUARANTEES:
 *     - The forward price's date is always STRICTLY GREATER than the snapshot
 *       date D (`> D`, never `>= D`). A sample is only counted when such a real
 *       forward price exists. There is no interpolation or "use the latest
 *       price we have" shortcut - an immature snapshot simply yields no sample
 *       at that horizon.
 *     - The snapshot's own stored price P (recorded AT time D) is the entry; it
 *       is never replaced by a later-known value.
 *     - Benchmark (QQQ) excess return uses QQQ's price at D (on-or-before D) and
 *       at the forward date, from the same getStockHistory series, so both legs
 *       respect the same temporal ordering.
 *
 * CONVICTION METHODOLOGY (formulas)
 *   Per (signal | band) x horizon bucket we compute:
 *     n          = sample count
 *     winRate    = share of samples with fwdReturn > 0           (0..1)
 *     winRateVsBench = share with excess (fwd - bench) > 0       (0..1)
 *     avgReturn  = mean fwdReturn                                 (fraction)
 *     avgExcess  = mean (fwdReturn - benchReturn)                (fraction)
 *     medianReturn = median fwdReturn                            (fraction)
 *
 *   Raw edge combines win-rate and average excess return:
 *     edge = (winRateVsBench - 0.5) + clamp(avgExcess / EDGE_SCALE, -1, 1) * 0.5
 *     (edge in roughly [-1, 1]; positive = the band historically beat coin-flip
 *      AND the benchmark.)
 *
 *   Shrinkage toward neutral for small samples (empirical-Bayes style):
 *     confidence = n / (n + SHRINK_K)        in [0, 1)
 *     shrunkEdge = edge * confidence          (pulls toward 0 when n is small)
 *
 *   weight (0..1) = clamp(0.5 + shrunkEdge / 2, 0, 1)  - a normalized
 *   conviction weight a caller can multiply into sizing. 0.5 = neutral.
 *
 *   level:
 *     - 'Unproven'  when n < MIN_SAMPLES_FOR_CONVICTION (honesty: too little data)
 *     - else 'High' / 'Medium' / 'Low' by shrunkEdge thresholds.
 *
 *   We deliberately use the SHRUNK edge for levels so a 2-sample band can never
 *   read "High".
 */

// ---------------------------------------------------------------------------
// Tunables (kept local; all clearly labelled).
// ---------------------------------------------------------------------------

/** Forward horizons in CALENDAR days (~ 1w / 1m / 3m). */
export const CALIBRATION_HORIZONS_DAYS = [5, 20, 60] as const;
export type HorizonDays = (typeof CALIBRATION_HORIZONS_DAYS)[number];

/** How far past the target date we still accept a forward price (calendar days). */
const HORIZON_TOLERANCE_DAYS = 7;

/** Benchmark used for excess-return calc. */
const BENCHMARK = "QQQ";

/** Shrinkage constant: at n = SHRINK_K, confidence = 0.5. Higher = more cautious. */
const SHRINK_K = 8;

/** Below this many samples a bucket is labelled 'Unproven' (never trusted). */
export const MIN_SAMPLES_FOR_CONVICTION = 5;

/** Average-excess scale: avgExcess of +/-EDGE_SCALE maps to +/-0.5 edge contribution. */
const EDGE_SCALE = 0.05; // 5% excess return is a "strong" edge

/** Shrunk-edge thresholds for High / Medium / Low. */
const LEVEL_HIGH = 0.12;
const LEVEL_MEDIUM = 0.04;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A normalized historical snapshot used by the pure calibration engine. */
export type CalibrationSnapshot = {
  ticker: string;
  /** ISO date (YYYY-MM-DD) the snapshot was captured. */
  date: string;
  score: number;
  signal: Signal | string;
  price: number;
};

export type ConvictionLevel = "High" | "Medium" | "Low" | "Unproven";

/** Aggregate calibration stats for one bucket (signal or band) at one horizon. */
export type CalibrationBucketStat = {
  horizonDays: HorizonDays;
  sampleSize: number;
  /** 0..1 share of samples with forward return > 0. */
  winRate: number;
  /** 0..1 share with forward return > benchmark. */
  winRateVsBenchmark: number;
  /** Mean forward return, as a fraction (0.05 = +5%). */
  avgReturn: number;
  /** Median forward return, as a fraction. */
  medianReturn: number;
  /** Mean (forward - benchmark) return, as a fraction. */
  avgExcessReturn: number;
  /** 0..1 confidence from shrinkage (n / (n + K)). */
  confidence: number;
  /** 0..1 normalized conviction weight (0.5 = neutral). */
  weight: number;
  level: ConvictionLevel;
};

/** Full calibration result: per-signal and per-band buckets, plus meta. */
export type Calibration = {
  /** signal -> horizonDays -> stat */
  bySignal: Record<string, Partial<Record<HorizonDays, CalibrationBucketStat>>>;
  /** band signal -> horizonDays -> stat (band derived from score via SCORE_BANDS) */
  byBand: Record<string, Partial<Record<HorizonDays, CalibrationBucketStat>>>;
  horizons: HorizonDays[];
  /** Total snapshots read. */
  totalSnapshots: number;
  /** Total (snapshot, horizon) samples that found a real forward price. */
  totalSamples: number;
  /** True when a real benchmark series was available (else excess = vs 0). */
  benchmarkAvailable: boolean;
  benchmark: string;
  computedAt: string;
};

/** The conviction overlay attached to a live holding/watchlist item. */
export type Conviction = {
  level: ConvictionLevel;
  /** 0..1 normalized weight (0.5 neutral). */
  weight: number;
  /** 0..1 historical win-rate of this signal/band at the chosen horizon. */
  winRate: number;
  /** Mean forward return (fraction) of this signal/band at the horizon. */
  avgReturn: number;
  sampleSize: number;
  horizon: HorizonDays;
  /** Which lookup matched: the exact signal, or the score band, or neither. */
  basis: "signal" | "band" | "none";
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type ComputeCalibrationOpts = {
  /**
   * Forward-price provider for a ticker. Should return ascending daily candles.
   * Defaults to Mboum getStockHistory. Injectable for tests / determinism.
   */
  getHistory?: (ticker: string) => Promise<MboumCandle[]>;
  /** Override horizons (calendar days). Defaults to CALIBRATION_HORIZONS_DAYS. */
  horizons?: readonly HorizonDays[];
  /** Benchmark ticker. Defaults to QQQ. Pass null to disable benchmark. */
  benchmark?: string | null;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toISODate(d: string | Date): string {
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

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Price at-or-before `date` from ascending candles (for the benchmark entry leg). */
function priceOnOrBefore(candles: MboumCandle[], date: string): number | null {
  let ans: number | null = null;
  for (const c of candles) {
    if (c.date <= date) ans = c.close;
    else break;
  }
  return ans && Number.isFinite(ans) && ans > 0 ? ans : null;
}

/**
 * Closest forward candle to `targetDate` that is STRICTLY AFTER `afterDate`,
 * within tolerance. Returns {date, close} or null (immature -> no sample).
 */
function nearestForwardCandle(
  candles: MboumCandle[],
  afterDate: string,
  targetDate: string
): { date: string; close: number } | null {
  let best: { date: string; close: number } | null = null;
  let bestDist = Infinity;
  const upperBound = addDays(targetDate, HORIZON_TOLERANCE_DAYS);
  for (const c of candles) {
    // STRICTLY after the snapshot date - this is the lookahead guard.
    if (c.date <= afterDate) continue;
    if (c.date > upperBound) break; // ascending -> nothing closer past here
    const dist = Math.abs(daysBetween(targetDate, c.date));
    // Bound on BOTH sides: a candle far BEFORE the target (e.g. the series ends
    // early, so the snapshot is immature at this horizon) must NOT be accepted.
    if (dist <= HORIZON_TOLERANCE_DAYS && dist < bestDist) {
      bestDist = dist;
      best = { date: c.date, close: c.close };
    }
  }
  return best && Number.isFinite(best.close) && best.close > 0 ? best : null;
}

/** Band signal for a numeric score (reuses SCORE_BANDS via signalFromScore). */
export function bandForScore(score: number): Signal {
  return signalFromScore(score);
}

// ---------------------------------------------------------------------------
// Bucket aggregation
// ---------------------------------------------------------------------------

type RawSample = { ret: number; excess: number; vsBenchPositive: boolean };

function aggregateBucket(
  horizonDays: HorizonDays,
  samples: RawSample[]
): CalibrationBucketStat {
  const n = samples.length;
  if (n === 0) {
    return {
      horizonDays,
      sampleSize: 0,
      winRate: 0,
      winRateVsBenchmark: 0,
      avgReturn: 0,
      medianReturn: 0,
      avgExcessReturn: 0,
      confidence: 0,
      weight: 0.5,
      level: "Unproven",
    };
  }
  const rets = samples.map((s) => s.ret);
  const wins = samples.filter((s) => s.ret > 0).length;
  const winsVsBench = samples.filter((s) => s.vsBenchPositive).length;
  const avgReturn = rets.reduce((a, b) => a + b, 0) / n;
  const avgExcess = samples.reduce((a, b) => a + b.excess, 0) / n;
  const winRate = wins / n;
  const winRateVsBenchmark = winsVsBench / n;

  // edge in ~[-1, 1]: half from beating the benchmark coin-flip, half from
  // the magnitude of average excess return (scaled & clamped).
  const edge =
    winRateVsBenchmark - 0.5 + clamp(avgExcess / EDGE_SCALE, -1, 1) * 0.5;

  const confidence = n / (n + SHRINK_K); // shrink toward neutral when n small
  const shrunkEdge = edge * confidence;
  const weight = clamp(0.5 + shrunkEdge / 2, 0, 1);

  let level: ConvictionLevel;
  if (n < MIN_SAMPLES_FOR_CONVICTION) {
    level = "Unproven";
  } else if (shrunkEdge >= LEVEL_HIGH) {
    level = "High";
  } else if (shrunkEdge >= LEVEL_MEDIUM) {
    level = "Medium";
  } else {
    level = "Low";
  }

  return {
    horizonDays,
    sampleSize: n,
    winRate: round4(winRate),
    winRateVsBenchmark: round4(winRateVsBenchmark),
    avgReturn: round4(avgReturn),
    medianReturn: round4(median(rets)),
    avgExcessReturn: round4(avgExcess),
    confidence: round4(confidence),
    weight: round4(weight),
    level,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Core: computeCalibration (pure given a history provider)
// ---------------------------------------------------------------------------

/**
 * Compute calibration stats from historical snapshots. PURE except for the
 * injected `getHistory` (defaults to Mboum). Does NOT read the DB itself -
 * callers pass snapshots in, which keeps it unit-testable and side-effect-free.
 */
export async function computeCalibration(
  snapshots: CalibrationSnapshot[],
  opts: ComputeCalibrationOpts = {}
): Promise<Calibration> {
  const horizons = (opts.horizons ?? CALIBRATION_HORIZONS_DAYS) as HorizonDays[];
  const getHistory =
    opts.getHistory ?? ((t: string) => getStockHistory(t, { monthsBack: 12 }));
  const benchmark = opts.benchmark === undefined ? BENCHMARK : opts.benchmark;

  // Normalize + sort snapshots per ticker by date (ascending) so the
  // snapshot-to-snapshot forward lookup is straightforward.
  const norm = snapshots
    .map((s) => ({ ...s, date: toISODate(s.date), price: Number(s.price) }))
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .sort((a, b) =>
      a.ticker === b.ticker
        ? a.date.localeCompare(b.date)
        : a.ticker.localeCompare(b.ticker)
    );

  const tickers = [...new Set(norm.map((s) => s.ticker))];

  // Candle cache: one fetch per ticker (+ benchmark), concurrently.
  const candleCache = new Map<string, MboumCandle[]>();
  await Promise.all(
    [...tickers, ...(benchmark ? [benchmark] : [])].map(async (t) => {
      const c = await getHistory(t).catch(() => [] as MboumCandle[]);
      candleCache.set(t, c);
    })
  );
  const benchCandles = benchmark ? candleCache.get(benchmark) ?? [] : [];
  const benchmarkAvailable = benchCandles.length > 0;

  // Index snapshots per ticker for the "later snapshot" forward source.
  const byTicker = new Map<string, typeof norm>();
  for (const s of norm) {
    const arr = byTicker.get(s.ticker) ?? [];
    arr.push(s);
    byTicker.set(s.ticker, arr);
  }

  // signal -> horizon -> samples ; band -> horizon -> samples
  const sigBuckets = new Map<string, Map<HorizonDays, RawSample[]>>();
  const bandBuckets = new Map<string, Map<HorizonDays, RawSample[]>>();
  let totalSamples = 0;

  const pushSample = (
    map: Map<string, Map<HorizonDays, RawSample[]>>,
    key: string,
    h: HorizonDays,
    sample: RawSample
  ) => {
    let hm = map.get(key);
    if (!hm) {
      hm = new Map();
      map.set(key, hm);
    }
    const arr = hm.get(h) ?? [];
    arr.push(sample);
    hm.set(h, arr);
  };

  for (const snap of norm) {
    const tickerSnaps = byTicker.get(snap.ticker) ?? [];
    const candles = candleCache.get(snap.ticker) ?? [];
    const band = bandForScore(snap.score);

    for (const h of horizons) {
      const target = addDays(snap.date, h);

      // (1) Prefer a later snapshot of the same ticker (strictly after date).
      let fwdPrice: number | null = null;
      let fwdDate: string | null = null;
      let bestDist = Infinity;
      for (const cand of tickerSnaps) {
        if (cand.date <= snap.date) continue; // STRICT lookahead guard
        const dist = Math.abs(daysBetween(target, cand.date));
        if (dist <= HORIZON_TOLERANCE_DAYS && dist < bestDist) {
          bestDist = dist;
          fwdPrice = cand.price;
          fwdDate = cand.date;
        }
      }

      // (2) Fallback to Mboum candles (also strictly after snap.date).
      if (fwdPrice == null && candles.length > 0) {
        const c = nearestForwardCandle(candles, snap.date, target);
        if (c) {
          fwdPrice = c.close;
          fwdDate = c.date;
        }
      }

      if (fwdPrice == null || fwdDate == null) continue; // immature -> no sample

      const ret = (fwdPrice - snap.price) / snap.price;

      // Benchmark excess: QQQ entry on-or-before snap.date, exit on-or-before
      // fwdDate. Both legs respect temporal ordering (no lookahead).
      let excess = ret;
      let vsBenchPositive = ret > 0;
      if (benchmarkAvailable) {
        const bStart = priceOnOrBefore(benchCandles, snap.date);
        const bEnd = priceOnOrBefore(benchCandles, fwdDate);
        if (bStart != null && bEnd != null) {
          const benchRet = (bEnd - bStart) / bStart;
          excess = ret - benchRet;
          vsBenchPositive = excess > 0;
        }
      }

      const sample: RawSample = { ret, excess, vsBenchPositive };
      pushSample(sigBuckets, String(snap.signal), h, sample);
      pushSample(bandBuckets, band, h, sample);
      totalSamples += 1;
    }
  }

  const bySignal = materialize(sigBuckets, horizons);
  const byBand = materialize(bandBuckets, horizons);

  return {
    bySignal,
    byBand,
    horizons,
    totalSnapshots: norm.length,
    totalSamples,
    benchmarkAvailable,
    benchmark: benchmark ?? "",
    computedAt: new Date().toISOString(),
  };
}

function materialize(
  buckets: Map<string, Map<HorizonDays, RawSample[]>>,
  horizons: HorizonDays[]
): Record<string, Partial<Record<HorizonDays, CalibrationBucketStat>>> {
  const out: Record<
    string,
    Partial<Record<HorizonDays, CalibrationBucketStat>>
  > = {};
  for (const [key, hm] of buckets.entries()) {
    const row: Partial<Record<HorizonDays, CalibrationBucketStat>> = {};
    for (const h of horizons) {
      const samples = hm.get(h);
      if (samples && samples.length > 0) {
        row[h] = aggregateBucket(h, samples);
      }
    }
    out[key] = row;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conviction lookup (pure)
// ---------------------------------------------------------------------------

/** Snap an arbitrary horizon request to the nearest computed horizon. */
function resolveHorizon(horizons: HorizonDays[], requested: number): HorizonDays {
  let best = horizons[0];
  let bestDist = Infinity;
  for (const h of horizons) {
    const d = Math.abs(h - requested);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}

/**
 * Look up the conviction overlay for a live signal/score at a horizon. PURE.
 * Tries the exact signal bucket first, then the score band, then returns a
 * neutral 'Unproven' overlay. NEVER throws; null-safe on a null calibration.
 */
export function convictionForSignal(
  calibration: Calibration | null | undefined,
  signal: Signal | string,
  score: number,
  horizonDays: number = 20
): Conviction {
  const fallback: Conviction = {
    level: "Unproven",
    weight: 0.5,
    winRate: 0,
    avgReturn: 0,
    sampleSize: 0,
    horizon: (CALIBRATION_HORIZONS_DAYS.find((h) => h === horizonDays) ??
      CALIBRATION_HORIZONS_DAYS[1]) as HorizonDays,
    basis: "none",
  };
  if (!calibration) return fallback;

  const horizon = resolveHorizon(calibration.horizons, horizonDays);

  const sig = calibration.bySignal[String(signal)]?.[horizon];
  if (sig && sig.sampleSize >= MIN_SAMPLES_FOR_CONVICTION) {
    return statToConviction(sig, "signal", horizon);
  }

  const band = bandForScore(score);
  const bandStat = calibration.byBand[band]?.[horizon];
  if (bandStat && bandStat.sampleSize >= MIN_SAMPLES_FOR_CONVICTION) {
    return statToConviction(bandStat, "band", horizon);
  }

  // Fall back to whichever bucket exists (even if Unproven) for transparency.
  const anyStat = sig ?? bandStat;
  if (anyStat) {
    return statToConviction(anyStat, sig ? "signal" : "band", horizon);
  }
  return { ...fallback, horizon };
}

function statToConviction(
  stat: CalibrationBucketStat,
  basis: "signal" | "band",
  horizon: HorizonDays
): Conviction {
  return {
    level: stat.level,
    weight: stat.weight,
    winRate: stat.winRate,
    avgReturn: stat.avgReturn,
    sampleSize: stat.sampleSize,
    horizon,
    basis,
  };
}

// ---------------------------------------------------------------------------
// DB-backed convenience (impure): read snapshots -> computeCalibration
// ---------------------------------------------------------------------------

type SnapshotRow = {
  ticker: string;
  score: string | number;
  signal: string;
  price: string | number;
  captured_at: string | Date;
};

/** Read all snapshots from the DB into the pure calibration input shape. */
export async function loadCalibrationSnapshots(): Promise<CalibrationSnapshot[]> {
  if (!isDatabaseConfigured()) return [];
  await ensureSnapshotSchema();
  const rows = await query<SnapshotRow>(
    `SELECT ticker, score, signal, price, captured_at
       FROM score_snapshots
      ORDER BY ticker, captured_at ASC`
  );
  return rows.map((r) => ({
    ticker: r.ticker,
    score: Number(r.score),
    signal: r.signal,
    price: Number(r.price),
    date: toISODate(r.captured_at),
  }));
}

/**
 * DB-backed end-to-end calibration. Returns null when no DB is configured or
 * there are no snapshots yet (caller treats null as "no calibration data").
 */
export async function getCalibration(
  opts: ComputeCalibrationOpts = {}
): Promise<Calibration | null> {
  const snapshots = await loadCalibrationSnapshots();
  if (snapshots.length === 0) return null;
  return computeCalibration(snapshots, opts);
}

/**
 * Module-level cache so multiple holdings in one portfolio build share a single
 * calibration computation (which fetches candles). Short TTL; null-safe.
 */
let cached: { at: number; value: Calibration | null } | null = null;
const CALIBRATION_TTL_MS = 5 * 60 * 1000;

export async function getCalibrationCached(): Promise<Calibration | null> {
  const now = Date.now();
  if (cached && now - cached.at < CALIBRATION_TTL_MS) return cached.value;
  let value: Calibration | null = null;
  try {
    value = await getCalibration();
  } catch {
    value = null;
  }
  cached = { at: now, value };
  return value;
}
