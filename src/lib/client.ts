import type {
  ApiError,
  ArticleImpactAnalysis,
  AssistantResponse,
  ChatMessage,
  DailyBrief,
  DashboardResponse,
  Holding,
  PerformanceResponse,
  PortfolioAlert,
  PortfolioTransaction,
  StocksResponse,
  TradeType,
  WatchlistResponse,
} from "@/lib/types";
// [top3] response type lives with the engine, not in shared types.
import type { TopMovesResponse } from "@/lib/top-moves";
// [chart] intraday 1D series type lives with its engine, not in shared types.
import type { IntradaySeries } from "@/lib/intraday-chart";

/** Client-side typed fetchers for the dashboard API routes. */

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as ApiError;
      detail = body.detail ?? body.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${url} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

export function fetchDashboard(): Promise<DashboardResponse> {
  return getJson<DashboardResponse>("/api/dashboard");
}

export function fetchPerformance(range?: string): Promise<PerformanceResponse> {
  const qs = range ? `?range=${encodeURIComponent(range)}` : "";
  return getJson<PerformanceResponse>(`/api/performance${qs}`);
}

export function fetchStocks(): Promise<StocksResponse> {
  return getJson<StocksResponse>("/api/stocks");
}

export function fetchWatchlist(): Promise<WatchlistResponse> {
  return getJson<WatchlistResponse>("/api/watchlist");
}

export function fetchBrief(): Promise<DailyBrief> {
  return getJson<DailyBrief>("/api/brief");
}

// [top3] AI "Top 3 Moves Today".
export function fetchTopMoves(): Promise<TopMovesResponse> {
  return getJson<TopMovesResponse>("/api/top-moves");
}

// [chart] Per-stock intraday 1D series for the live chart.
export function fetchIntraday(symbol: string): Promise<IntradaySeries> {
  return getJson<IntradaySeries>(
    `/api/intraday?symbol=${encodeURIComponent(symbol)}`
  );
}

export function fetchResearch(ticker: string): Promise<{ holding: Holding }> {
  return getJson<{ holding: Holding }>(
    `/api/research/${encodeURIComponent(ticker)}`
  );
}

export async function askAssistant(
  messages: ChatMessage[]
): Promise<AssistantResponse> {
  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`assistant failed (${res.status})`);
  return (await res.json()) as AssistantResponse;
}

export function fetchAlerts(): Promise<{ alerts: PortfolioAlert[] }> {
  return getJson<{ alerts: PortfolioAlert[] }>("/api/alerts");
}

export function fetchTransactions(): Promise<{ transactions: PortfolioTransaction[] }> {
  return getJson<{ transactions: PortfolioTransaction[] }>(
    "/api/portfolio/transactions"
  );
}

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const b = (await res.json()) as ApiError;
      detail = b.detail ?? b.error ?? detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export type TradePayload = {
  ticker: string;
  companyName?: string;
  tradeType: TradeType;
  shares: number;
  pricePerShare: number;
  tradeDate: string;
  fees?: number;
  notes?: string;
};

export function postTransaction(payload: TradePayload) {
  return postJson("/api/portfolio/transactions", payload);
}

export function patchHolding(
  ticker: string,
  payload: { shares: number; avgPrice: number; companyName?: string; notes?: string }
) {
  return postJson(`/api/portfolio/holdings/${encodeURIComponent(ticker)}`, payload, "PATCH");
}

export function archiveHolding(ticker: string, force = false) {
  return postJson(
    `/api/portfolio/holdings/${encodeURIComponent(ticker)}${force ? "?force=true" : ""}`,
    {},
    "DELETE"
  );
}

export function postCashAdjustment(payload: {
  amount: number;
  tradeDate: string;
  notes?: string;
}) {
  return postJson("/api/portfolio/cash-adjustments", payload);
}

export function analyzeArticle(url: string, ticker?: string): Promise<ArticleImpactAnalysis> {
  return postJson<ArticleImpactAnalysis>("/api/article-impact/analyze", { url, ticker });
}

export type SyncResult = {
  ok: boolean;
  skipped?: string;
  synced?: string[];
  cashPersisted?: boolean;
  whenGenerated?: string | null;
  reason?: string;
};

/** Trigger an on-demand IBKR realign (server-throttled). Powers the Sync button. */
export async function syncIbkr(): Promise<SyncResult> {
  const res = await fetch("/api/portfolio/sync-ibkr", { method: "POST" });
  return (await res.json()) as SyncResult;
}
