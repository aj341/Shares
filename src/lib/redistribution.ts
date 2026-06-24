import { PORTFOLIO_RULES, CONCENTRATION_LIMITS } from "@/lib/constants";
import { minAnnouncementImpact } from "@/lib/announcements";
// [sizing] concentration-aware sizing: limits which buys are allowed and
// surfaces trim-for-concentration recommendations. Backwards compatible —
// behaviour only changes when a concentration limit is actually breached.
import { assessConcentration } from "@/lib/concentration";
import { sectorFor } from "@/lib/sectors";
import type { ConcentrationLimits } from "@/lib/concentration";
import type {
  AllocationSnapshot,
  Holding,
  PortfolioResponse,
  RedistributionResponse,
  RedistributionSummary,
  TradeRecommendation,
} from "@/lib/types";

/**
 * Redistribution engine.
 *
 * Decides SELL / TRIM / BUY / HOLD per holding, then allocates available cash
 * (ARM-sale cash first, then trim/sell proceeds) into the best BUY candidates,
 * respecting the 30% position cap, the 5% cash buffer and whole-share rounding.
 */

const { maxPositionWeight, targetCashBufferPct, minTradeSize, weakTrimTargetWeight } =
  PORTFOLIO_RULES;

// [sizing] TRIM_CONCENTRATION is a distinct decision from the existing weak-score
// TRIM — it fires when a name (or its sector) is already over a concentration
// limit, with its own rationale string. Treated like a TRIM for execution.
type Decision = "FULL_SELL" | "TRIM" | "TRIM_CONCENTRATION" | "BUY" | "HOLD";

type Working = {
  holding: Holding;
  decision: Decision;
  sharesAfter: number; // shares remaining after sells/trims (pre-buy)
  proceeds: number;
  realisedPnl: number;
};

/**
 * [sizing] Concentration context passed into `decide`. When a holding's own
 * equity weight is over the single-name cap, or its sector is over the sector
 * cap, we surface a TRIM_CONCENTRATION (distinct from the weak-score TRIM).
 * Null context => no concentration influence (full backwards compatibility).
 */
type ConcCtx = {
  limits: ConcentrationLimits;
  /** This holding's weight as a fraction of the TOTAL book (incl cash). */ // [decfix]
  equityFrac: number;
  /** Combined weight of this holding's sector as a fraction of the TOTAL book. */ // [decfix]
  sectorFrac: number;
  sector: string;
  // [decfix] True only for the ONE name elected to carry a breached sector's
  // trim. For every other member of an over-cap sector this is false, so they
  // do NOT each independently solve the whole sector under cap (that caused the
  // ~3x over-trim / sector liquidation). A single-name breach is unaffected.
  sectorBreachAppliesHere: boolean;
} | null;

// [decfix] effectiveCap is the single-name cap (fraction of total book) the
// BUY gate binds to. Defaults to maxPositionWeight (legacy) so the
// respectConcentration:false path is unchanged; callers pass 0.30 when
// concentration is on, reconciling the gate with the concentration cap.
function decide(h: Holding, conc: ConcCtx = null, effectiveCap: number = maxPositionWeight): Decision {
  // SAFETY: never recommend trades off degraded (mock-fallback) data.
  if (h.dataQuality === "degraded") return "HOLD";

  const negAnnouncement = minAnnouncementImpact(h.announcements) <= -2;

  // 1. Full sell — broken thesis.
  if (h.score < 40 && (h.verdict.verdict === "negative" || negAnnouncement)) {
    return "FULL_SELL";
  }

  // [sizing] 1b. Trim for concentration — a name (or its sector) is already
  // over a hard concentration limit. Distinct from the weak-score TRIM below;
  // only fires when a concentration limit is actually breached, so the legacy
  // flow is untouched when limits are respected. We do NOT force-trim a name we
  // would otherwise FULL_SELL (handled above) or a strong BUY whose only issue
  // is size — for those we BLOCK the buy in phase 3 instead of force-selling.
  if (
    conc &&
    (conc.equityFrac > conc.limits.maxSingleNameWeight + 1e-9 ||
      // [decfix] sector breach only trims the ONE elected name, not every member.
      (conc.sectorBreachAppliesHere &&
        conc.sectorFrac > conc.limits.maxSectorWeight + 1e-9))
  ) {
    return "TRIM_CONCENTRATION";
  }

  // 2. Trim — weak score, or overbought + large gain + overweight.
  const rsiMetric = h.metrics.find((m) => m.name === "RSI(14)");
  const rsi =
    rsiMetric && typeof rsiMetric.value === "number" ? rsiMetric.value : null;
  const overboughtProfitOverweight =
    rsi !== null &&
    rsi > 75 &&
    h.unrealisedPnlPct > 20 &&
    h.portfolioWeight > maxPositionWeight * 100 * 0.8; // within 80% of cap

  if ((h.score >= 40 && h.score < 55) || overboughtProfitOverweight) {
    return "TRIM";
  }

  // 3. Buy — strong score, constructive verdict, below cap.
  if (
    h.score >= 70 &&
    h.verdict.verdict !== "negative" &&
    h.portfolioWeight < effectiveCap * 100 // [decfix] reconciled single-name cap
  ) {
    return "BUY";
  }

  return "HOLD";
}

/** Shares to trim: ~30% of the position, whole shares, respecting min trade size. */
function trimShares(h: Holding): number {
  const raw = Math.floor(h.shares * 0.3);
  if (raw <= 0) return 0;
  if (raw * h.currentPrice < minTradeSize) return 0;
  return raw;
}

/**
 * [trim-to-target] Shares to trim a WEAK name (score 40–54) straight down to
 * its target weight in ONE move, instead of slicing 30% each cycle. Returns 0
 * (→ hold) when the name is already at/under target or the trim is below the
 * minimum trade size.
 */
function weakTrimShares(h: Holding, totalPortfolioValue: number): number {
  if (h.currentPrice <= 0 || totalPortfolioValue <= 0) return 0;
  const targetShares = Math.floor(
    (weakTrimTargetWeight * totalPortfolioValue) / h.currentPrice
  );
  const raw = h.shares - targetShares;
  if (raw <= 0) return 0;
  if (raw * h.currentPrice < minTradeSize) return 0;
  return raw;
}

/**
 * [trim-to-cap] Shares to trim an over-concentrated name DOWN to just under its
 * binding concentration limit (single-name and/or sector) in ONE move — rather
 * than a flat 30%-of-position slice that overshoots well below the cap. For each
 * breached limit it solves the dollars to sell so (value − x)/(equity − x) =
 * (limit − buffer), then keeps the most-restrictive result. Falls back to the
 * 30% step only when context is missing.
 */
function concentrationTrimShares(
  h: Holding,
  totalValue: number,
  ctx: ConcCtx,
  limits: ConcentrationLimits
): number {
  if (!ctx || totalValue <= 0 || h.currentPrice <= 0) return trimShares(h);
  const BUFFER = 0.005; // land ~0.5% under the cap so it doesn't instantly re-breach
  let allowed = h.shares;
  // Single-name: trimming moves value equity->cash, so the TOTAL is unchanged —
  // keep shares so (shares*price)/total <= cap.
  if (ctx.equityFrac > limits.maxSingleNameWeight + 1e-9) {
    const L = Math.max(0.01, limits.maxSingleNameWeight - BUFFER);
    allowed = Math.min(
      allowed,
      Math.max(0, Math.floor((L * totalValue) / h.currentPrice))
    );
  }
  // Sector: reduce THIS name enough that its sector <= cap of total. [decfix]
  // Only the elected carrier sizes for the sector; other members never do, so
  // the sector is brought just under cap ONCE rather than once per member.
  if (ctx.sectorBreachAppliesHere && ctx.sectorFrac > limits.maxSectorWeight + 1e-9) {
    const L = Math.max(0.01, limits.maxSectorWeight - BUFFER);
    const sellDollars = ctx.sectorFrac * totalValue - L * totalValue;
    const sellShares = Math.ceil(Math.max(0, sellDollars) / h.currentPrice);
    allowed = Math.min(allowed, Math.max(0, h.shares - sellShares));
  }
  const raw = h.shares - allowed;
  if (raw <= 0) return 0;
  if (raw * h.currentPrice < minTradeSize) return 0;
  return raw;
}

/** A screened watchlist name proposed as a brand-new position. */
export type NewPositionCandidate = {
  ticker: string;
  companyName: string;
  priceUsd: number;
  rationale: string;
  /** Score on the SAME 20-metric engine as holdings (null = unscored). */
  score: number | null;
  /**
   * Minimum score this candidate must clear (default 70; raised to 75 when
   * its sector already dominates the book — doubling down needs conviction).
   */
  minBar?: number;
  /** False when yesterday's snapshot failed confirmation (anti-churn). */
  confirmed?: boolean;
};

const MAX_NEW_POSITIONS = 2;
const NEW_POSITION_MAX_WEIGHT = 0.08; // starter size: ≤8% of the book each

export function buildRedistribution(
  portfolio: PortfolioResponse,
  opts: {
    targetCashBufferPct?: number;
    regimeLabel?: string;
    /** Watchlist screen candidates (caller omits these in risk-off regimes). */
    newPositionCandidates?: NewPositionCandidate[];
    // [sizing] Concentration limits (fractions of equity). Defaults to
    // CONCENTRATION_LIMITS. Set `respectConcentration: false` to fully restore
    // the legacy behaviour (no concentration influence at all).
    concentrationLimits?: ConcentrationLimits;
    /** Master switch — when false the engine ignores concentration entirely. */
    respectConcentration?: boolean;
  } = {}
): RedistributionResponse {
  const { holdings, cash, totalPortfolioValue } = portfolio;

  // [sizing] Concentration setup. Computed once from the BEFORE book; used to
  // (a) emit trim-for-concentration decisions and (b) gate buys in phase 3.
  // When `respectConcentration` is false we pass null contexts everywhere, so
  // every downstream branch behaves exactly as before.
  const concentrationOn = opts.respectConcentration !== false;
  const concLimits: ConcentrationLimits =
    opts.concentrationLimits ?? CONCENTRATION_LIMITS;
  // [decfix] One coherent single-name cap. When concentration is ON the tighter
  // concentration cap (0.30) binds the BUY gate AND the phase-3 position cap, so
  // the rationale numbers match the actual ceiling. When concentration is OFF
  // (legacy path) we fall back to the 0.35 maxPositionWeight, unchanged.
  const effectiveSingleNameCap = concentrationOn
    ? concLimits.maxSingleNameWeight
    : maxPositionWeight;
  // [total-basis] Concentration is measured against the TOTAL portfolio value
  // (incl cash) so the cap matches the weights shown on the dashboard. Each
  // holding's portfolioWeight is already a % of the total book.
  const concentration = assessConcentration(holdings, concLimits, totalPortfolioValue);
  const sectorFracBefore = new Map<string, number>();
  if (totalPortfolioValue > 0) {
    for (const h of holdings) {
      const sec = sectorFor(h.ticker);
      sectorFracBefore.set(
        sec,
        (sectorFracBefore.get(sec) ?? 0) + h.portfolioWeight / 100
      );
    }
  }
  // [decfix] For each sector that BREACHES its cap, elect exactly ONE name to
  // carry the sector trim: the largest-weight name, tie-broken to the weakest
  // score. Only that ticker gets the sector breach attributed to it, so the
  // sector is trimmed to just under cap ONCE (no ~3x overshoot from every
  // member solving the whole sector independently). Single-name breaches are
  // unaffected — they still trim per-name to the single-name cap below.
  const sectorTrimCarrier = new Map<string, string>(); // sector -> ticker
  if (concentrationOn && totalPortfolioValue > 0) {
    const breachedSectors = new Set<string>();
    for (const [sec, frac] of sectorFracBefore) {
      if (frac > concLimits.maxSectorWeight + 1e-9) breachedSectors.add(sec);
    }
    for (const sec of breachedSectors) {
      const members = holdings.filter((h) => sectorFor(h.ticker) === sec);
      members.sort((a, b) => {
        if (b.portfolioWeight !== a.portfolioWeight)
          return b.portfolioWeight - a.portfolioWeight; // largest weight first
        return a.score - b.score; // tie-break: weakest score first
      });
      if (members.length > 0) sectorTrimCarrier.set(sec, members[0].ticker);
    }
  }
  const concCtxFor = (h: Holding): ConcCtx => {
    if (!concentrationOn || totalPortfolioValue <= 0) return null;
    const sec = sectorFor(h.ticker);
    return {
      limits: concLimits,
      equityFrac: h.portfolioWeight / 100,
      sectorFrac: sectorFracBefore.get(sec) ?? 0,
      sector: sec,
      // [decfix] true only for the elected carrier of a breached sector.
      sectorBreachAppliesHere: sectorTrimCarrier.get(sec) === h.ticker,
    };
  };
  // Regime-aware dynamic buffer (defaults to the static rule).
  const bufferPct = opts.targetCashBufferPct ?? targetCashBufferPct;
  const asOf = new Date().toISOString();

  // --- Before snapshot (holdings + cash, weights sum to ~100%). ---
  const before = buildSnapshots(holdings, cash, totalPortfolioValue);
  const maxWeightBefore = maxWeight(before);

  // --- Phase 1: decide sells / trims, collect proceeds. ---
  const working: Working[] = holdings.map((h) => {
    const decision = decide(h, concCtxFor(h), effectiveSingleNameCap); // [decfix]
    let sharesAfter = h.shares;
    let proceeds = 0;
    let realisedPnl = 0;

    if (decision === "FULL_SELL") {
      sharesAfter = 0;
      proceeds = h.shares * h.currentPrice;
      realisedPnl = proceeds - h.costBasis;
    } else if (decision === "TRIM" || decision === "TRIM_CONCENTRATION") {
      // [sizing] TRIM_CONCENTRATION shares the same execution path as TRIM.
      // [trim-to-target] A WEAK name (score <55) trims straight to its target
      // weight in one move; overbought-overweight names and concentration
      // breaches keep the gradual ~30% step.
      const ts =
        decision === "TRIM_CONCENTRATION"
          ? concentrationTrimShares(h, totalPortfolioValue, concCtxFor(h), concLimits)
          : decision === "TRIM" && h.score < 55
            ? weakTrimShares(h, totalPortfolioValue)
            : trimShares(h);
      sharesAfter = h.shares - ts;
      proceeds = ts * h.currentPrice;
      // [decfix] Cost-basis-derived realised P&L, consistent with FULL_SELL
      // (proceeds − costBasis). Pro-rate the position cost basis by shares sold
      // so TRIM and FULL_SELL use the SAME convention.
      realisedPnl =
        proceeds - (h.shares > 0 ? (h.costBasis * ts) / h.shares : 0);
      if (ts === 0) {
        // Trim too small to act on — treat as hold for this cycle.
        return { holding: h, decision: "HOLD", sharesAfter: h.shares, proceeds: 0, realisedPnl: 0 };
      }
    }

    return { holding: h, decision, sharesAfter, proceeds, realisedPnl };
  });

  const recommendations: TradeRecommendation[] = [];
  let totalProceeds = 0;

  for (const w of working) {
    const isTrim =
      (w.decision === "TRIM" || w.decision === "TRIM_CONCENTRATION") &&
      w.proceeds > 0;
    if (w.decision === "FULL_SELL" || isTrim) {
      const soldShares = w.holding.shares - w.sharesAfter;
      totalProceeds += w.proceeds;
      // [sizing] Concentration-specific rationale explains WHY (which limit).
      let concRationale = "";
      if (w.decision === "TRIM_CONCENTRATION") {
        const ctx = concCtxFor(w.holding);
        const overSingle =
          ctx != null && ctx.equityFrac > concLimits.maxSingleNameWeight + 1e-9;
        const overSector =
          ctx != null &&
          ctx.sectorBreachAppliesHere && // [decfix] only the elected carrier cites the sector reason
          ctx.sectorFrac > concLimits.maxSectorWeight + 1e-9;
        const reasons: string[] = [];
        if (overSingle && ctx)
          reasons.push(
            `at ${(ctx.equityFrac * 100).toFixed(1)}% of portfolio vs the ${(concLimits.maxSingleNameWeight * 100).toFixed(0)}% single-name cap`
          );
        if (overSector && ctx)
          reasons.push(
            `its sector (${ctx.sector}) at ${(ctx.sectorFrac * 100).toFixed(1)}% vs the ${(concLimits.maxSectorWeight * 100).toFixed(0)}% sector cap`
          );
        concRationale = `Trim ${soldShares} shares for concentration — ${w.holding.ticker} is ${reasons.join(" and ")}. Reduces portfolio concentration risk.`;
      }
      recommendations.push({
        action: w.decision === "FULL_SELL" ? "SELL" : "TRIM",
        ticker: w.holding.ticker,
        shares: soldShares,
        estimatedPrice: round2(w.holding.currentPrice),
        estimatedProceedsOrCost: round2(w.proceeds),
        estimatedRealisedPnl: round2(w.realisedPnl),
        rationale:
          w.decision === "FULL_SELL"
            ? `Score ${w.holding.score} (SELL) with ${w.holding.verdict.verdict} verdict — exit full position.`
            : w.decision === "TRIM_CONCENTRATION"
              ? concRationale
              : w.holding.score < 55
                ? `Trim ${soldShares} shares down to a ~${(weakTrimTargetWeight * 100).toFixed(0)}% target weight in one move — weak score ${w.holding.score}.`
                : `Trim ${soldShares} shares — overbought with a large gain near the position cap.`,
      });
    }
  }

  // --- Phase 2: available cash. Regime-aware cash buffer first, then proceeds. ---
  const targetCash = totalPortfolioValue * bufferPct;
  let availableToInvest = Math.max(0, cash - targetCash) + totalProceeds;

  // --- Phase 3: rank BUY candidates and allocate. ---
  const cap = effectiveSingleNameCap * totalPortfolioValue; // [decfix] reconciled cap (0.30 when concentration on)

  const buyCandidates = working
    .filter((w) => w.decision === "BUY")
    .map((w) => w.holding)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score; // score desc
      if (a.portfolioWeight !== b.portfolioWeight)
        return a.portfolioWeight - b.portfolioWeight; // lower weight first
      return (
        minAnnouncementImpact(b.announcements) -
        minAnnouncementImpact(a.announcements)
      ); // higher announcement impact first
    });

  // Track post-trade market value per ticker for cap + after snapshot.
  const mvAfter = new Map<string, number>();
  for (const w of working) {
    mvAfter.set(w.holding.ticker, w.sharesAfter * w.holding.currentPrice);
  }

  // --- Phase 3: unified buy queue. Watchlist candidates are scored on the
  // SAME 20-metric engine as holdings and COMPETE for capital on score —
  // a screened name that outranks every existing BUY gets funded first.
  // Candidates must clear the same BUY bar (score >= 70); on score ties the
  // incumbent holding wins. Callers omit candidates in risk-off regimes.
  type BuyEntry =
    | { kind: "existing"; holding: Holding; score: number }
    | { kind: "new"; cand: NewPositionCandidate; score: number };

  const queue: BuyEntry[] = [
    ...buyCandidates.map((h) => ({
      kind: "existing" as const,
      holding: h,
      score: h.score,
    })),
    ...(opts.newPositionCandidates ?? [])
      .filter(
        (c) =>
          c.score != null &&
          c.score >= (c.minBar ?? 70) &&
          c.confirmed !== false &&
          c.priceUsd > 0 &&
          !mvAfter.has(c.ticker)
      )
      .map((c) => ({ kind: "new" as const, cand: c, score: c.score as number })),
  ].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.kind !== b.kind) return a.kind === "existing" ? -1 : 1; // incumbent wins ties
    return 0;
  });

  // Conviction-weighted split: when several BUY-grade options qualify,
  // capital divides by score distance above the bar (weight = score − 65),
  // so a 78 earns meaningfully more than a 71 — neither winner-takes-all
  // (a 74 starving a 73 over one point) nor a flat equal split that ignores
  // conviction. Whole-share remainders flow down the queue, then to cash.
  const initialAvailable = availableToInvest;
  const fundable = [
    ...queue.filter((q) => q.kind === "existing"),
    ...queue.filter((q) => q.kind === "new").slice(0, MAX_NEW_POSITIONS),
  ];
  const totalWeight = fundable.reduce((s, q) => s + Math.max(1, q.score - 65), 0);
  const budgetFor = new Map<string, number>();
  if (fundable.length > 1 && totalWeight > 0) {
    for (const q of fundable) {
      const t = q.kind === "existing" ? q.holding.ticker : q.cand.ticker;
      budgetFor.set(
        t,
        Math.max(
          (initialAvailable * Math.max(1, q.score - 65)) / totalWeight,
          minTradeSize
        )
      );
    }
  }
  const capFor = (ticker: string) =>
    budgetFor.get(ticker) ?? Number.POSITIVE_INFINITY;

  // [sizing] Concentration-aware buy gating. We track the running equity total
  // (sum of post-trade equity MVs) and the running sector MV so each prospective
  // buy can be capped so it never PUSHES the book past a concentration limit.
  // When concentration is off, headroom is unbounded and behaviour is unchanged.
  const sectorMvAfter = new Map<string, number>();
  for (const w of working) {
    const sec = sectorFor(w.holding.ticker);
    const mv = mvAfter.get(w.holding.ticker) ?? 0;
    sectorMvAfter.set(sec, (sectorMvAfter.get(sec) ?? 0) + mv);
  }
  // [total-basis] Buying converts cash->equity, so the TOTAL portfolio value is
  // unchanged; a name's weight is measured against that constant total.
  // Max additional $ into a name so (m+x)/total <= L  =>  x <= L*total - m.
  const concDollarHeadroom = (_currentMv: number, sumMv: number, limit: number): number => {
    if (!concentrationOn) return Number.POSITIVE_INFINITY;
    if (limit >= 1) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit * totalPortfolioValue - sumMv);
  };
  // Top-3 guard: adding $cost keeps top-3 (of total) <= limit.
  const top3WouldHold = (ticker: string, cost: number): boolean => {
    if (!concentrationOn) return true;
    if (totalPortfolioValue <= 0) return true;
    const proj = new Map(mvAfter);
    proj.set(ticker, (proj.get(ticker) ?? 0) + cost);
    const vals = Array.from(proj.values()).sort((a, b) => b - a);
    const top3 = vals.slice(0, 3).reduce((acc, v) => acc + v, 0);
    return top3 / totalPortfolioValue <= concLimits.maxTop3 + 1e-9;
  };

  let totalInvested = 0;
  const newPositions: { ticker: string; companyName: string; mv: number }[] = [];
  for (const entry of queue) {
    if (availableToInvest < minTradeSize) break;

    if (entry.kind === "existing") {
      const h = entry.holding;
      const sec = sectorFor(h.ticker);
      const currentMv = mvAfter.get(h.ticker) ?? 0;
      const headroomToCap = Math.max(0, cap - currentMv);
      // [sizing] Additional concentration ceilings: single-name + sector. These
      // only BIND when concentration is on AND the relevant limit would be hit;
      // otherwise they are +Infinity and the legacy 35% `cap` governs.
      const singleHeadroom$ = concDollarHeadroom(
        currentMv,
        currentMv,
        concLimits.maxSingleNameWeight
      );
      const sectorHeadroom$ = concDollarHeadroom(
        currentMv,
        sectorMvAfter.get(sec) ?? 0,
        concLimits.maxSectorWeight
      );
      const spendable = Math.min(
        availableToInvest,
        capFor(h.ticker),
        singleHeadroom$,
        sectorHeadroom$
      );
      const maxByCash = Math.floor(spendable / h.currentPrice);
      const maxByCap = Math.floor(headroomToCap / h.currentPrice);
      let buy = Math.max(0, Math.min(maxByCash, maxByCap));
      // Top-3 guard: shrink the buy until it no longer pushes top-3 over limit.
      while (buy > 0 && !top3WouldHold(h.ticker, buy * h.currentPrice)) buy -= 1;

      if (buy <= 0) continue;
      const cost = buy * h.currentPrice;
      if (cost < minTradeSize) continue; // ignore dust buys

      availableToInvest -= cost;
      totalInvested += cost;
      mvAfter.set(h.ticker, currentMv + cost);
      sectorMvAfter.set(sec, (sectorMvAfter.get(sec) ?? 0) + cost);

      // [sizing] If concentration clamped the buy below the legacy cap headroom,
      // say so in the rationale (transparency about WHY the buy was limited).
      const concClamped =
        concentrationOn &&
        Math.min(singleHeadroom$, sectorHeadroom$) < headroomToCap - 1e-6;
      recommendations.push({
        action: "BUY",
        ticker: h.ticker,
        shares: buy,
        estimatedPrice: round2(h.currentPrice),
        estimatedProceedsOrCost: round2(cost),
        rationale: concClamped
          ? `Score ${h.score} (${h.signal}); buy sized DOWN to respect concentration limits (single-name ${(concLimits.maxSingleNameWeight * 100).toFixed(0)}%, top-3 ${(concLimits.maxTop3 * 100).toFixed(0)}%, sector ${(concLimits.maxSectorWeight * 100).toFixed(0)}%).`
          : `Score ${h.score} (${h.signal}); below the ${(effectiveSingleNameCap * 100).toFixed(0)}% single-name cap — deploy capital up to cap.`, // [decfix]
      });
    } else {
      if (newPositions.length >= MAX_NEW_POSITIONS) continue;
      const cand = entry.cand;
      const sec = sectorFor(cand.ticker);
      // [sizing] A brand-new position starts at 0, so single-name headroom is
      // governed by NEW_POSITION_MAX_WEIGHT below; we still respect the SECTOR
      // ceiling so a new name can't push an already-hot sector over its cap.
      const sectorHeadroom$ = concDollarHeadroom(
        0,
        sectorMvAfter.get(sec) ?? 0,
        concLimits.maxSectorWeight
      );
      const budget = Math.min(
        availableToInvest,
        capFor(cand.ticker),
        totalPortfolioValue * NEW_POSITION_MAX_WEIGHT,
        sectorHeadroom$
      );
      let shares = Math.floor(budget / cand.priceUsd);
      while (shares > 0 && !top3WouldHold(cand.ticker, shares * cand.priceUsd))
        shares -= 1;
      if (shares <= 0) continue;
      const cost = shares * cand.priceUsd;
      if (cost < minTradeSize) continue;

      availableToInvest -= cost;
      totalInvested += cost;
      mvAfter.set(cand.ticker, cost);
      sectorMvAfter.set(sec, (sectorMvAfter.get(sec) ?? 0) + cost);
      newPositions.push({ ticker: cand.ticker, companyName: cand.companyName, mv: cost });

      recommendations.push({
        action: "BUY",
        ticker: cand.ticker,
        shares,
        estimatedPrice: round2(cand.priceUsd),
        estimatedProceedsOrCost: round2(cost),
        rationale: `New position — scores ${entry.score}/100 on the same 20-metric engine, beating remaining top-up options. ${cand.rationale}`,
      });
    }
  }

  // --- After snapshot. ---
  const newCashBalance = cash + totalProceeds - totalInvested;
  const after: AllocationSnapshot[] = [];
  const newTotal =
    Array.from(mvAfter.values()).reduce((s, v) => s + v, 0) + newCashBalance;

  for (const h of holdings) {
    const mv = mvAfter.get(h.ticker) ?? 0;
    if (mv <= 0) continue; // fully sold — drop from allocation
    after.push({
      ticker: h.ticker,
      companyName: h.companyName,
      marketValue: round2(mv),
      weight: round2(newTotal > 0 ? (mv / newTotal) * 100 : 0),
    });
  }
  for (const np of newPositions) {
    after.push({
      ticker: np.ticker,
      companyName: np.companyName,
      marketValue: round2(np.mv),
      weight: round2(newTotal > 0 ? (np.mv / newTotal) * 100 : 0),
    });
  }
  after.push({
    ticker: "CASH",
    companyName: "Cash",
    marketValue: round2(newCashBalance),
    weight: round2(newTotal > 0 ? (newCashBalance / newTotal) * 100 : 0),
  });

  const tickersFullySold = working
    .filter((w) => w.decision === "FULL_SELL")
    .map((w) => w.holding.ticker);

  const summary: RedistributionSummary = {
    totalProceeds: round2(totalProceeds),
    totalInvested: round2(totalInvested),
    newCashBalance: round2(newCashBalance),
    maxWeightBefore: round2(maxWeightBefore),
    maxWeightAfter: round2(maxWeight(after)),
    tickersFullySold,
    targetCashBufferPct: bufferPct,
    regimeLabel: opts.regimeLabel,
    candidatesConsidered: (opts.newPositionCandidates ?? []).map((c) => ({
      ticker: c.ticker,
      score: c.score,
    })),
    // [sizing] Concentration snapshot of the BEFORE book + the active limits,
    // so the UI can explain any trim-for-concentration / sized-down buys.
    concentration: concentrationOn ? concentration : undefined,
  };

  // Order: sells, then trims, then buys.
  recommendations.sort((a, b) => rank(a.action) - rank(b.action));

  return { recommendations, before, after, summary, asOf, source: portfolio.source };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSnapshots(
  holdings: Holding[],
  cash: number,
  total: number
): AllocationSnapshot[] {
  const snaps = holdings.map((h) => ({
    ticker: h.ticker,
    companyName: h.companyName,
    marketValue: round2(h.marketValue),
    weight: round2(total > 0 ? (h.marketValue / total) * 100 : 0),
  }));
  snaps.push({
    ticker: "CASH",
    companyName: "Cash",
    marketValue: round2(cash),
    weight: round2(total > 0 ? (cash / total) * 100 : 0),
  });
  return snaps;
}

function maxWeight(snaps: AllocationSnapshot[]): number {
  return snaps
    .filter((s) => s.ticker !== "CASH")
    .reduce((max, s) => Math.max(max, s.weight), 0);
}

function rank(action: TradeRecommendation["action"]): number {
  return action === "SELL" ? 0 : action === "TRIM" ? 1 : 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
