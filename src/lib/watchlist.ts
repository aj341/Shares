import { buildStockTechnicals } from "@/lib/technicals";
import { getUpgradeDowngrade, isMboumConfigured } from "@/lib/mboum";
import { computeLiveMetrics } from "@/lib/live-metrics";
// [factors] additive cross-sectional dimension
import { getStockHistory } from "@/lib/mboum";
import { loadBenchmarkBundle } from "@/lib/relative-strength";
import {
  computeFactorBundle,
  rankCrossSection,
  type RankableInput,
} from "@/lib/factors";
import { scoreOnEngine } from "@/lib/engine-score"; // [scanscore] shared engine score (one impl for scan + watchlist)
import { sectorFor } from "@/lib/sectors";
// [calibration][integration] additive conviction overlay on watchlist items.
import { getCalibrationCached, convictionForSignal } from "@/lib/calibration";
// [earnings] additive earnings catalyst overlay (calendar / revisions / PEAD).
import { getEarningsSignals } from "@/lib/earnings-signals";
// [insider] Additive insider cluster-buy overlay (never alters bucket/score).
import { getInsiderOverlays, type InsiderOverlay } from "@/lib/insider";
// [wlfilter] getAllRanked = full ranked set for the coverage / filter path.
import { getTopRanked, getAllRanked, type WatchlistRanking } from "@/lib/watchlist-screen";
import { universeEntryFor } from "@/lib/universe";
import type {
  WatchlistBucket,
  WatchlistItem,
  WatchlistResponse,
} from "@/lib/types";

/**
 * Watchlist of names that complement the book, enriched with LIVE metrics
 * (price, RSI, target, P/E, 52w, analyst consensus) and REAL recent analyst
 * actions from Mboum.
 *
 * Candidate selection is DYNAMIC: when the relative-strength screen has run
 * (see watchlist-screen.ts / the watchlist-scan cron), the top-ranked
 * non-held names from the Nasdaq-100 universe are used, with data-driven
 * framing built from their rank stats. When no scan has run yet, we fall
 * back to the hand-curated CANDIDATES below. Qualitative notes are analysis,
 * NOT financial advice.
 */

type Candidate = {
  ticker: string;
  companyName: string;
  subSectors: string[];
  whyItFits: string;
  bullCase: string;
  keyRisk: string;
};

const CANDIDATES: Candidate[] = [
  {
    ticker: "NVDA",
    companyName: "NVIDIA Corporation",
    subSectors: ["AI Infrastructure", "Semiconductors"],
    whyItFits:
      "The book holds AI applications and infra services but lacks the dominant AI training/inference silicon supplier. NVDA fills the highest-conviction AI-hardware slot.",
    bullCase:
      "Data-center demand for accelerated compute remains the structural growth driver of the cycle, and the CUDA software ecosystem is a deep, durable moat that is difficult to displace.",
    keyRisk:
      "Customer concentration among a few hyperscalers and export-control restrictions on advanced chips to China are the principal downside risks.",
  },
  {
    ticker: "AVGO",
    companyName: "Broadcom Inc.",
    subSectors: ["AI Networking", "Custom Silicon", "Semiconductors"],
    whyItFits:
      "Custom-silicon and AI-networking exposure diversifies the portfolio's compute bet beyond GPUs into the connective tissue of AI data centres.",
    bullCase:
      "Custom AI accelerators for hyperscalers plus a high-margin infrastructure-software franchise give a diversified, cash-generative profile.",
    keyRisk:
      "Cyclicality in non-AI semis and integration/leverage from large acquisitions can weigh on results.",
  },
  {
    ticker: "AMD",
    companyName: "Advanced Micro Devices, Inc.",
    subSectors: ["AI Semiconductors", "High-Performance Computing"],
    whyItFits:
      "A credible second source of AI accelerators and server CPUs — adds competitive-dynamics optionality to the semiconductor sleeve.",
    bullCase:
      "Data-center GPU and EPYC server-CPU share gains provide a multi-year growth runway as the AI compute market expands.",
    keyRisk:
      "Executing against an entrenched GPU leader and lumpy enterprise demand make the ramp uncertain.",
  },
  {
    ticker: "CRWD",
    companyName: "CrowdStrike Holdings, Inc.",
    subSectors: ["AI-Native Cybersecurity", "Cloud Security Platform"],
    whyItFits:
      "Adds an AI-native security platform — a recurring-revenue, mission-critical software complement to the AI-infrastructure theme.",
    bullCase:
      "Platform consolidation and module cross-sell drive high net-revenue retention and durable subscription growth.",
    keyRisk:
      "Premium valuation leaves little room for execution slips, and security is a competitive, fast-moving market.",
  },
  {
    ticker: "AMZN",
    companyName: "Amazon.com, Inc.",
    subSectors: ["Cloud Infrastructure", "AI Services", "E-commerce"],
    whyItFits:
      "AWS is a top-tier cloud/AI platform; pairs infrastructure scale with diversified retail and advertising cash flows.",
    bullCase:
      "AWS re-acceleration on AI workloads plus expanding retail margins and a fast-growing ad business support earnings power.",
    keyRisk:
      "Consumer-spend sensitivity and heavy capex on AI infrastructure can pressure near-term free cash flow.",
  },
  {
    ticker: "META",
    companyName: "Meta Platforms, Inc.",
    subSectors: ["AI-Powered Social", "Digital Advertising", "Open AI Models"],
    whyItFits:
      "Adds an AI-monetisation play through advertising plus an open-model strategy that complements the closed-model exposure in the book.",
    bullCase:
      "AI-driven ad targeting and engagement gains keep the core franchise compounding while open models broaden the ecosystem.",
    keyRisk:
      "Reality Labs losses and regulatory/privacy headwinds remain overhangs on the multiple.",
  },
  {
    ticker: "AXON",
    companyName: "Axon Enterprise, Inc.",
    subSectors: ["Defense-AI", "Public Safety Technology", "Software SaaS"],
    whyItFits:
      "A defense/public-safety SaaS compounder that complements the AI/Defense exposure with sticky, recurring software revenue.",
    bullCase:
      "Hardware-to-cloud flywheel (devices → recurring software) drives high retention and expanding margins.",
    keyRisk:
      "Government procurement cycles and a rich valuation are the main sensitivities.",
  },
  {
    ticker: "PANW",
    companyName: "Palo Alto Networks, Inc.",
    subSectors: ["Cybersecurity", "AI Security Platform"],
    whyItFits:
      "Platformised cybersecurity with growing AI-security demand — another recurring-revenue complement to the AI theme.",
    bullCase:
      "Platformisation strategy consolidates spend and lifts next-gen ARR with strong free-cash-flow conversion.",
    keyRisk:
      "Deal-timing volatility from platformisation incentives and a premium multiple add variability.",
  },
];

/**
 * Entry-timing bucket. RSI extremes still anchor the ends (overbought → wait,
 * oversold → pullback entry), but the mid-range is no longer blindly "Neutral":
 * a name in a confirmed uptrend (price above its 50/20-day MA) that is ALSO
 * BUY-rated by the engine is a momentum entry ("buy on strength"), not a wait.
 * This is what stops a +200%-momentum, BUY-rated leader reading "Neutral".
 */
function bucketFor(
  rsi: number | null,
  opts: { trendUp: boolean; buyRated: boolean } = { trendUp: false, buyRated: false }
): { bucket: WatchlistBucket; label: string } {
  if (rsi == null) return { bucket: "neutral", label: "Neutral" };
  if (rsi > 72) return { bucket: "overbought", label: "Overbought" };
  if (rsi < 45) return { bucket: "best_entry", label: "Near Oversold" };
  if (opts.trendUp && opts.buyRated)
    return { bucket: "momentum", label: "Buy on Strength" };
  return { bucket: "neutral", label: "Neutral" };
}

function ratingLabel(bullishPct: number | null): string | null {
  if (bullishPct == null) return null;
  if (bullishPct >= 90) return "Strong Buy";
  if (bullishPct >= 75) return "Buy";
  if (bullishPct >= 50) return "Moderate Buy";
  if (bullishPct >= 30) return "Hold";
  return "Reduce";
}

function technicalSignal(bucket: WatchlistBucket, rsi: number | null): string {
  if (rsi == null) return "Technical data unavailable.";
  if (bucket === "best_entry")
    return `RSI ${rsi} — near oversold; constructive entry zone after a pullback.`;
  if (bucket === "overbought")
    return `RSI ${rsi} — overbought; consider waiting for a reset before adding.`;
  if (bucket === "momentum")
    return `RSI ${rsi} — mid-range in a confirmed uptrend and BUY-rated; momentum entry (buy on strength), not a wait.`;
  return `RSI ${rsi} — mid-range with no confirmed trend; neutral, await a clearer signal.`;
}

/** Signed percent string, e.g. "+34.2%" / "-5.1%". */
function signedPct(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

/** Build a screened candidate's editorial fields from its rank stats. */
function candidateFromRanking(r: WatchlistRanking): Candidate {
  const entry = universeEntryFor(r.ticker);
  const mom = signedPct(r.momentumPct);
  const rs = signedPct(r.rsPct);
  const revisionClause =
    r.revision === "upgrading"
      ? "with analysts upgrading"
      : r.revision === "downgrading"
        ? "despite analysts downgrading"
        : "with analyst revisions stable";
  return {
    ticker: r.ticker,
    companyName: entry?.companyName ?? r.ticker,
    subSectors: entry?.subSectors ?? ["Momentum Screen"],
    whyItFits: `Ranked #${r.rank} of ${r.universeSize} in the Nasdaq-100 relative-strength screen by 12-1 momentum (${mom}) and relative strength vs QQQ (${rs}) ${revisionClause}.`,
    bullCase: `12-1 momentum of ${mom} and ${rs} outperformance vs QQQ over six months suggest persistent leadership; ${
      r.revision === "upgrading"
        ? "upgrading analyst revisions add fundamental confirmation."
        : r.revision === "stable"
          ? "stable analyst revisions imply the move is not yet crowded by estimate hype."
          : "a rebound in analyst revisions would add fundamental confirmation."
    }`,
    keyRisk: `Momentum leadership can reverse sharply — the rank (composite ${r.composite >= 0 ? "+" : ""}${Math.round(r.composite * 100) / 100}) depends on trend persistence${
      r.revision === "downgrading"
        ? ", and analysts are currently downgrading"
        : ""
    }; screens carry no valuation or quality filter.`,
  };
}

// [scanscore] scoreOnEngine moved to engine-score.ts (shared by the scan).

/** Entry-zone threshold: RSI below this counts as a constructive pullback. */
const ENTRY_RSI_MAX = 50;
const MOMENTUM_SLOTS = 5;
/** Entry-zone picks must still rank in the top ~3/4 of the universe. */
const ENTRY_MAX_RANK = 30;

/**
 * Candidate list: a BLEND from the latest scan — momentum leaders (watch for
 * a pullback) plus strong-ranked names already IN an entry zone (low RSI at
 * scan time), so the list always mixes "strongest" with "buyable now".
 * Falls back to the static curated list when no scan has run.
 */
async function resolveCandidates(): Promise<Candidate[]> {
  const total = CANDIDATES.length; // 8 slots
  try {
    // Full ranked universe — entry-zone picks can sit mid-table (a strong
    // name that pulled back ranks lower on momentum by construction).
    const pool = await getTopRanked(50);
    if (pool.length > 0) {
      const picked: WatchlistRanking[] = [];
      const taken = new Set<string>();
      // 1. Top momentum leaders.
      for (const r of pool.slice(0, MOMENTUM_SLOTS)) {
        picked.push(r);
        taken.add(r.ticker);
      }
      // 2. Strong-enough names already pulled back, MOST pulled-back first
      //    (deepest entry opportunity) — the rank cap keeps bottom-decile
      //    losers out, the RSI sort makes "best entry" mean what it says.
      const entryZone = pool
        .filter(
          (r) =>
            !taken.has(r.ticker) &&
            r.rank <= ENTRY_MAX_RANK &&
            r.rsi14 != null &&
            r.rsi14 < ENTRY_RSI_MAX
        )
        .sort((a, b) => (a.rsi14 as number) - (b.rsi14 as number));
      for (const r of entryZone) {
        if (picked.length >= total) break;
        picked.push(r);
        taken.add(r.ticker);
      }
      // 3. Fill any remaining slots by rank.
      for (const r of pool) {
        if (picked.length >= total) break;
        if (!taken.has(r.ticker)) {
          picked.push(r);
          taken.add(r.ticker);
        }
      }
      return picked.map(candidateFromRanking);
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[watchlist] screen unavailable, using static candidates:", (err as Error).message);
    }
  }
  return CANDIDATES;
}

// [wlfilter] -------------------------------------------------------------
// FULL-COVERAGE ranked list. The curated `items` are an 8-name bucketed
// "suggestions" view; buildFullRanked (below) builds a complete WatchlistItem
// for EVERY scanned, non-held universe name from PERSISTED engine scores — the
// root-cause fix for the old "only ~8 names" cap. The heavy live enrichment
// (technicals / earnings / insider / factors) stays on the curated `items`.
// [scanscore] The old live re-scoring helpers (mapWithConcurrency / enrichRanked)
// were removed with the [wlperf] cap — the full set is now DB-only.

/**
 * [scanscore] CHEAP full ranked set — DB-only. Builds a complete WatchlistItem
 * for EVERY scanned, non-held universe name from the PERSISTED engine score the
 * scan computed (no live re-scoring, no per-name Mboum fetch). This is what made
 * reads slow before: the old buildFullRanked live-re-scored the universe via
 * computeLiveMetrics, so the request timed out and the [wlperf] cap fell back to
 * ~8 names. Now the scan owns the cost; reads just read the DB.
 *
 * Curated `items` (richer live enrichment) are reused where tickers overlap, so
 * the suggestions keep their full technicals/overlays. Names with a null
 * engine_score (pre-migration rows, or not-yet-scored) degrade gracefully — they
 * still appear with whatever stats the ranking carries (engineScore stays null).
 */
async function buildFullRanked(curated: WatchlistItem[]): Promise<WatchlistItem[]> {
  let pool: WatchlistRanking[] = [];
  try {
    pool = await getAllRanked();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[wlfilter] full ranked unavailable:", (err as Error).message);
    }
  }
  if (pool.length === 0) {
    // No scan yet — the curated list IS the full available set.
    return curated;
  }
  const byTicker = new Map(curated.map((i) => [i.ticker, i] as const));
  // Synchronous, DB-backed: no awaits inside, no live re-scoring.
  return pool.map((r) => byTicker.get(r.ticker) ?? itemFromRankingDb(r));
}

/**
 * [scanscore] Build a WatchlistItem purely from a persisted DB ranking — NO
 * Mboum / computeLiveMetrics call. Uses the persisted engine_score/signal plus
 * the ranking's own rsi14 for the entry bucket. Back-compat: when engine_score
 * is null we omit the score (null) rather than crash, and still surface the name
 * via its composite rank. Persisted company_name/sector are preferred, with the
 * static universe entry as the fallback.
 */
function itemFromRankingDb(r: WatchlistRanking): WatchlistItem {
  const c = candidateFromRanking(r);
  const buyRated = r.engineSignal === "BUY" || r.engineSignal === "STRONG_BUY";
  // RSI-driven bucket; trendUp is unknown without live MAs, so only the
  // RSI extremes + (buy-rated) momentum band apply — consistent with bucketFor.
  const { bucket, label } = bucketFor(r.rsi14, { trendUp: false, buyRated });
  return {
    engineScore: r.engineScore,
    engineSignal: r.engineSignal,
    ticker: r.ticker,
    companyName: r.companyName ?? c.companyName,
    sector: r.sector ?? sectorFor(r.ticker),
    subSectors: c.subSectors,
    price: r.price, // [scanscore] persisted last close -> name competes as a buy candidate
    upsidePct: null,
    rsi: r.rsi14,
    targetMean: null,
    peRatio: null,
    bullishPct: null,
    analystRating: null,
    week52High: null,
    week52Low: null,
    bucket,
    signalLabel: label,
    whyItFits: c.whyItFits,
    bullCase: c.bullCase,
    keyRisk: c.keyRisk,
    technicalSignal: technicalSignal(bucket, r.rsi14),
    recentAnalystActions: [],
  };
}
// [wlfilter] end ----------------------------------------------------------

// 15-min cache so /api/watchlist and /api/alerts (entry-trigger check) reuse
// one computation rather than re-fetching 8 tickers of Mboum data each call.
let WL_CACHE: { data: WatchlistResponse; ts: number } | null = null;
const WL_TTL_MS = 15 * 60 * 1000;

// [refresh] Bust the watchlist cache so the very next buildWatchlist() re-reads
// the freshly persisted scan scores instead of serving a stale (<=15-min) copy.
// Called by the manual re-scan POST after runWatchlistScan() completes.
export function clearWatchlistCache(): void {
  WL_CACHE = null;
}

export async function buildWatchlist(): Promise<WatchlistResponse> {
  if (WL_CACHE && Date.now() - WL_CACHE.ts < WL_TTL_MS) return WL_CACHE.data;
  const asOf = new Date().toISOString();
  if (!isMboumConfigured()) {
    return {
      items: [],
      suggestionsCount: 0,
      avgUpsidePct: null,
      bestEntry: [],
      asOf,
      source: "none",
      all: [], // [wlfilter]
    };
  }

  const candidates = await resolveCandidates();

  // [earnings] Batch earnings catalyst signals for the candidate set
  // (calendar / estimate revisions / PEAD). null-safe + cached; display-only.
  const wlEarnings = await getEarningsSignals(
    candidates.map((c) => c.ticker)
  ).catch(() => new Map<string, import("@/lib/types").EarningsSignal>());
  // [earnings] end

  // [calibration][integration] historical conviction overlay (null-safe).
  const wlCalibration = await getCalibrationCached().catch(() => null);
  // [insider] Slow additive overlay over the watchlist names (open-market
  // buys, heavily filtered). Batched once; cached 6h; null-safe.
  const wlInsider = await getInsiderOverlays(
    candidates.map((c) => c.ticker)
  ).catch(() => ({}) as Record<string, InsiderOverlay>);
  // [factors] Benchmark/sector-ETF history fetched ONCE for the whole list.
  const benchmarkBundle = await loadBenchmarkBundle(
    candidates.map((c) => c.ticker)
  ).catch(() => ({} as Record<string, number[]>));
  // [factors] per-index raw factor bundles, ranked after the list is built.
  const wlFactorBundles: Array<Pick<RankableInput, "relativeStrengthRaw" | "factors">> = [];

  const items = await Promise.all(
    candidates.map(async (c, idx): Promise<WatchlistItem> => {
      const [tech, actions, engine, candleCloses, liveMetrics] = await Promise.all([
        buildStockTechnicals(c.ticker),
        getUpgradeDowngrade(c.ticker),
        scoreOnEngine(c.ticker),
        // [factors] adjusted closes for RS / momentum / low-vol (null-safe).
        getStockHistory(c.ticker, { interval: "1d", monthsBack: 13 })
          .then((cs) => cs.map((x) => x.adjClose))
          .catch(() => [] as number[]),
        // computeLiveMetrics is cached (10 min) and already called by
        // scoreOnEngine; reuse it for the value/quality factor inputs.
        computeLiveMetrics(c.ticker, []).catch(() => null),
      ]);
      // [factors] per-name factor bundle (ranked after the full list is built).
      const factorBundle = computeFactorBundle({
        ticker: c.ticker,
        closes: candleCloses,
        bundle: benchmarkBundle,
        metrics: liveMetrics ?? [],
      });
      wlFactorBundles[idx] = {
        relativeStrengthRaw: factorBundle.relativeStrengthRaw,
        factors: factorBundle.factors,
      };
      const price = tech.sparkline.at(-1) ?? null;
      // Trend = price above its 50- (or 20-) day MA; quality = engine BUY-grade.
      const trendUp = tech.priceVsMa50 === "above" || tech.priceVsMa20 === "above";
      const buyRated =
        engine?.signal === "BUY" || engine?.signal === "STRONG_BUY";
      const { bucket, label } = bucketFor(tech.rsi, { trendUp, buyRated });
      return {
        engineScore: engine?.score ?? null,
        engineSignal: engine?.signal ?? null,
        ticker: c.ticker,
        companyName: c.companyName,
        sector: sectorFor(c.ticker),
        subSectors: c.subSectors,
        price,
        upsidePct: tech.targetUpsidePct,
        rsi: tech.rsi,
        targetMean: tech.targetMean,
        peRatio: tech.peRatio,
        bullishPct: tech.bullishPct,
        analystRating: ratingLabel(tech.bullishPct),
        week52High: tech.week52High,
        week52Low: tech.week52Low,
        bucket,
        signalLabel: label,
        whyItFits: c.whyItFits,
        bullCase: c.bullCase,
        keyRisk: c.keyRisk,
        technicalSignal: technicalSignal(bucket, tech.rsi),
        recentAnalystActions: actions,
      };
    })
  );

  // [factors] Cross-sectional rank across the watchlist set, then attach the
  // additive relativeStrength + factors fields (and append RS metric rows
  // where the item already carries metrics — watchlist items do not surface a
  // MetricGrid, so we attach the fields only; the holdings path renders rows).
  const wlRanked = rankCrossSection(
    items.map((_, i) => ({
      ticker: items[i].ticker,
      relativeStrengthRaw: wlFactorBundles[i].relativeStrengthRaw,
      factors: wlFactorBundles[i].factors,
    }))
  );
  items.forEach((it, i) => {
    it.relativeStrength = wlRanked[i].relativeStrength;
    it.factors = wlRanked[i].factors;
    // [calibration][integration] Additive conviction from the SAME engine
    // score/signal the watchlist already computes. Withheld when the item has
    // no engine signal. Never affects bucket / ranking / score.
    if (it.engineSignal != null && it.engineScore != null) {
      it.conviction = convictionForSignal(
        wlCalibration,
        it.engineSignal,
        it.engineScore,
        20
      );
    }
    // [earnings] Additive earnings catalyst overlay (display-only; null-safe).
    const eSig = wlEarnings.get(it.ticker);
    if (eSig) it.earnings = eSig;
    // [earnings] end
    // [insider] Additive overlay (open-market insider buys). Never affects
    // bucket / ranking / engine score.
    it.insider = wlInsider[it.ticker.toUpperCase()];
  });
  // Rank: best-entry first, then by upside desc.
  const order: Record<WatchlistBucket, number> = { best_entry: 0, momentum: 1, neutral: 2, overbought: 3 };
  items.sort((a, b) => {
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    return (b.upsidePct ?? -999) - (a.upsidePct ?? -999);
  });

  const upsides = items.map((i) => i.upsidePct).filter((u): u is number => u != null);
  const avgUpsidePct = upsides.length
    ? Math.round((upsides.reduce((s, u) => s + u, 0) / upsides.length) * 10) / 10
    : null;

  // [wlfilter] Build the FULL ranked set (every scanned, non-held name) for the
  // sector filter + redistribution coverage. Reuses the curated items above
  // where tickers overlap. Null-safe: failures degrade to the curated list.
  // [scanscore] The build is now DB-only (persisted engine scores) and cheap, so
  // the old [wlperf] 18s race/timeout that capped coverage at 8 is removed.
  const all = await buildFullRanked(items).catch(() => items);

  const result: WatchlistResponse = {
    items,
    suggestionsCount: items.length,
    avgUpsidePct,
    bestEntry: items.filter((i) => i.bucket === "best_entry").map((i) => i.ticker),
    asOf,
    source: "mboum",
    all, // [wlfilter] complete ranked list
  };
  WL_CACHE = { data: result, ts: Date.now() };
  return result;
}
