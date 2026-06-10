import { buildStockTechnicals } from "@/lib/technicals";
import { getUpgradeDowngrade, isMboumConfigured } from "@/lib/mboum";
import { computeLiveMetrics } from "@/lib/live-metrics";
import { extractRsi, scoreHolding } from "@/lib/scoring";
import { sectorFor } from "@/lib/sectors";
import { getTopRanked, type WatchlistRanking } from "@/lib/watchlist-screen";
import { universeEntryFor } from "@/lib/universe";
import type {
  Signal,
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

function bucketFor(rsi: number | null): { bucket: WatchlistBucket; label: string } {
  if (rsi == null) return { bucket: "neutral", label: "Neutral" };
  if (rsi < 45) return { bucket: "best_entry", label: "Near Oversold" };
  if (rsi > 70) return { bucket: "overbought", label: "Overbought" };
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
  return `RSI ${rsi} — mid-range; no momentum extreme, healthy reset territory.`;
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

/**
 * Score a watchlist name on the SAME 20-metric engine as holdings — the
 * bucket is entry TIMING (RSI); this is QUALITY. Null when live data fails
 * (no-mock rule). computeLiveMetrics has its own 10-min cache.
 */
async function scoreOnEngine(
  ticker: string
): Promise<{ score: number; signal: Signal } | null> {
  try {
    const metrics = await computeLiveMetrics(ticker, []);
    if (!metrics) return null;
    const { score, signal } = scoreHolding(metrics, {
      rsi: extractRsi(metrics),
      unrealisedPnlPct: 0,
      portfolioWeight: 0,
      minAnnouncementImpact: 0,
    });
    return { score, signal };
  } catch {
    return null;
  }
}

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

// 15-min cache so /api/watchlist and /api/alerts (entry-trigger check) reuse
// one computation rather than re-fetching 8 tickers of Mboum data each call.
let WL_CACHE: { data: WatchlistResponse; ts: number } | null = null;
const WL_TTL_MS = 15 * 60 * 1000;

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
    };
  }

  const candidates = await resolveCandidates();

  const items = await Promise.all(
    candidates.map(async (c): Promise<WatchlistItem> => {
      const [tech, actions, engine] = await Promise.all([
        buildStockTechnicals(c.ticker),
        getUpgradeDowngrade(c.ticker),
        scoreOnEngine(c.ticker),
      ]);
      const price = tech.sparkline.at(-1) ?? null;
      const { bucket, label } = bucketFor(tech.rsi);
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

  // Rank: best-entry first, then by upside desc.
  const order: Record<WatchlistBucket, number> = { best_entry: 0, neutral: 1, overbought: 2 };
  items.sort((a, b) => {
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    return (b.upsidePct ?? -999) - (a.upsidePct ?? -999);
  });

  const upsides = items.map((i) => i.upsidePct).filter((u): u is number => u != null);
  const avgUpsidePct = upsides.length
    ? Math.round((upsides.reduce((s, u) => s + u, 0) / upsides.length) * 10) / 10
    : null;

  const result: WatchlistResponse = {
    items,
    suggestionsCount: items.length,
    avgUpsidePct,
    bestEntry: items.filter((i) => i.bucket === "best_entry").map((i) => i.ticker),
    asOf,
    source: "mboum",
  };
  WL_CACHE = { data: result, ts: Date.now() };
  return result;
}
