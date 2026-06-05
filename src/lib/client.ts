import type {
  ApiError,
  ArticleImpactAnalysis,
  DailyBrief,
  DashboardResponse,
  PerformanceResponse,
  PortfolioAlert,
  PortfolioTransaction,
  StocksResponse,
  TradeType,
  WatchlistResponse,
} from "@/lib/types";

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
