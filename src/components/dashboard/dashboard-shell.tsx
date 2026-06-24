"use client";

import * as React from "react";
import {
  AlertTriangle,
  LineChart,
  RefreshCw,
  Plus,
  Wallet,
  Receipt,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { LiveClock } from "@/components/live-clock";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { HoldingsTable } from "@/components/dashboard/holdings-table";
import { CashBalances } from "@/components/dashboard/cash-balances";
import { DailyBriefCard } from "@/components/dashboard/daily-brief";
// [top3] AI "Top 3 Moves Today" panel.
import { TopMovesCard } from "@/components/dashboard/top-moves";
import { AssistantChat } from "@/components/dashboard/assistant-chat";
import { StockDetailSheet } from "@/components/dashboard/stock-detail-sheet";
import { AllocationChart } from "@/components/dashboard/allocation-chart";
import { SafetyRating } from "@/components/dashboard/safety-rating";
import { PortfolioPulse } from "@/components/dashboard/portfolio-pulse";
import { SignalsList } from "@/components/dashboard/signals-list";
import { PerformanceChart } from "@/components/dashboard/performance-chart";
import { SectorAllocation } from "@/components/dashboard/sector-allocation";
import { StocksTab } from "@/components/dashboard/stocks-tab";
import { WatchlistTab } from "@/components/dashboard/watchlist-tab";
import { ArticleAnalyzer } from "@/components/dashboard/article-analyzer";
import { AlertsBanner } from "@/components/dashboard/alerts-banner";
// [regime] additive market-regime / breadth context banner
import { RegimeBanner } from "@/components/dashboard/regime-banner";
import { SignalPerformance } from "@/components/dashboard/signal-performance";
// [calibration] Additive conviction-calibration panel.
import { ConvictionCalibration } from "@/components/dashboard/conviction-calibration";
import { EventsRadar } from "@/components/dashboard/events-radar";
// [earnings] Additive earnings catalyst calendar panel.
import { EarningsCalendar } from "@/components/dashboard/earnings-calendar";
import { PortfolioRisk } from "@/components/dashboard/portfolio-risk";
// [sizing] concentration / position-sizing panel
import { ConcentrationPanel } from "@/components/dashboard/concentration-panel";
// [insider] additive insider cluster-buy overlay panel (slow signal)
import { InsiderPanel } from "@/components/dashboard/insider-panel";
// [intraday] additive intraday VWAP/ATR/micro-regime panel (daily-trader overlay)
import { IntradayPanel } from "@/components/dashboard/intraday-panel";
// [scanner] "Today's Battle List" gap scanner + econ-calendar strip (additive).
import { BattleList } from "@/components/dashboard/battle-list";
import { EconCalendarStrip } from "@/components/dashboard/econ-calendar-strip";
import { RealizedPnl } from "@/components/dashboard/realized-pnl";
// [journal] Trade journal + execution/slippage analytics panel.
import { JournalPanel } from "@/components/dashboard/journal-panel";
import { ProvidersBadge } from "@/components/dashboard/providers-badge";
import { RebalancingCards } from "@/components/dashboard/rebalancing-cards";
import { AnnouncementsFeed } from "@/components/dashboard/announcements-feed";
// [news] Additive hard-catalyst feed (AI-triaged company news).
import { CatalystFeed } from "@/components/dashboard/catalyst-feed";
import { DisagreementScorecard } from "@/components/dashboard/disagreement-scorecard";
import {
  PortfolioDialogs,
  type DialogState,
  type DialogType,
} from "@/components/dashboard/portfolio-dialogs";
import {
  fetchAlerts,
  fetchDashboard,
  fetchPerformance,
  fetchResearch,
  fetchStocks,
  fetchWatchlist,
  syncIbkr,
} from "@/lib/client";
import { computeInsights } from "@/lib/insights";
import type {
  DashboardResponse,
  Holding,
  PerformanceResponse,
  PortfolioAlert,
  StocksResponse,
  WatchlistResponse,
} from "@/lib/types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DashboardResponse };

type PerfState = { loading: boolean; data: PerformanceResponse | null };
type StocksState = { loading: boolean; data: StocksResponse | null };
type WatchState = { loading: boolean; data: WatchlistResponse | null };

export function DashboardShell() {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [perf, setPerf] = React.useState<PerfState>({ loading: true, data: null });
  const [stocks, setStocks] = React.useState<StocksState>({ loading: true, data: null });
  const [watch, setWatch] = React.useState<WatchState>({ loading: true, data: null });
  const [alerts, setAlerts] = React.useState<PortfolioAlert[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<DialogState>(null);

  const load = React.useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await fetchDashboard();
      setState({ status: "ready", data });
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }, []);

  // Performance history loads independently — it must never block or break
  // the main dashboard if Mboum is slow or unavailable.
  const loadPerf = React.useCallback(async () => {
    setPerf({ loading: true, data: null });
    try {
      const data = await fetchPerformance();
      setPerf({ loading: false, data });
    } catch {
      setPerf({ loading: false, data: null });
    }
  }, []);

  // Per-stock technicals load independently too (Mboum-backed).
  const loadStocks = React.useCallback(async () => {
    setStocks({ loading: true, data: null });
    try {
      const data = await fetchStocks();
      setStocks({ loading: false, data });
    } catch {
      setStocks({ loading: false, data: null });
    }
  }, []);

  const loadWatch = React.useCallback(async () => {
    setWatch({ loading: true, data: null });
    try {
      const data = await fetchWatchlist();
      setWatch({ loading: false, data });
    } catch {
      setWatch({ loading: false, data: null });
    }
  }, []);

  const loadAlerts = React.useCallback(async () => {
    try {
      const { alerts: a } = await fetchAlerts();
      setAlerts(a);
    } catch {
      setAlerts([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
    void loadPerf();
    void loadStocks();
    void loadWatch();
    void loadAlerts();
  }, [load, loadPerf, loadStocks, loadWatch, loadAlerts]);

  const handleSelect = (ticker: string) => {
    setSelected(ticker);
    setSheetOpen(true);
  };

  // Watchlist names open the SAME drawer via the research endpoint (full
  // metrics/news/verdict for a non-held ticker). Held tickers short-circuit.
  const [research, setResearch] = React.useState<Holding | null>(null);
  const handleWatchSelect = React.useCallback(
    async (ticker: string) => {
      if (
        state.status === "ready" &&
        state.data.portfolio.holdings.some((h) => h.ticker === ticker)
      ) {
        handleSelect(ticker);
        return;
      }
      try {
        const { holding } = await fetchResearch(ticker);
        setResearch(holding);
        setSelected(ticker);
        setSheetOpen(true);
      } catch {
        // Live data unavailable — no drawer (mock is never shown).
      }
    },
    [state]
  );

  const openDialog = (type: DialogType, ticker?: string) =>
    setDialog({ type, ticker });

  const refreshAll = React.useCallback(() => {
    void load();
    void loadPerf();
    void loadStocks();
    void loadWatch();
    void loadAlerts();
  }, [load, loadPerf, loadStocks, loadWatch, loadAlerts]);

  // Self-healing IBKR freshness: a manual "Sync IBKR" action plus an automatic
  // realign on first load when the broker book is stale (server throttles to
  // avoid hammering Flex). Removes reliance on the best-effort GitHub cron.
  const [syncing, setSyncing] = React.useState(false);
  const syncNow = React.useCallback(async () => {
    setSyncing(true);
    try {
      await syncIbkr();
    } catch {
      /* ignore — view still shows the last-known book */
    } finally {
      setSyncing(false);
      refreshAll();
    }
  }, [refreshAll]);

  const didAutoSync = React.useRef(false);
  React.useEffect(() => {
    if (didAutoSync.current) return;
    didAutoSync.current = true;
    void syncNow();
  }, [syncNow]);

  const selectedHolding =
    (state.status === "ready"
      ? state.data.portfolio.holdings.find((h) => h.ticker === selected)
      : null) ??
    (research && research.ticker === selected ? research : null);

  return (
    <div className="min-h-screen">
      <Header
        source={state.status === "ready" ? state.data.source : undefined}
        asOf={state.status === "ready" ? state.data.asOf : undefined}
        /* [exthours] Surface the current market session in the header badge. */
        session={
          state.status === "ready"
            ? state.data.portfolio.holdings.find((h) => h.session)?.session
            : undefined
        }
        extended={
          state.status === "ready"
            ? state.data.portfolio.holdings.some((h) => h.extendedHours)
            : false
        }
        onRefresh={refreshAll}
        onSync={() => void syncNow()}
        syncing={syncing}
        loading={state.status === "loading"}
      />

      <main className="container mx-auto max-w-7xl px-4 py-6 lg:px-8">
        {state.status === "loading" ? (
          <LoadingState />
        ) : state.status === "error" ? (
          <ErrorState message={state.message} onRetry={load} />
        ) : (
          <ReadyView
            data={state.data}
            perf={perf}
            stocks={stocks}
            watch={watch}
            alerts={alerts}
            onSelect={handleSelect}
            onWatchSelect={handleWatchSelect}
            onAction={openDialog}
          />
        )}
      </main>

      <StockDetailSheet
        holding={selectedHolding}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />

      <PortfolioDialogs
        state={dialog}
        holdings={state.status === "ready" ? state.data.portfolio.holdings : []}
        onClose={() => setDialog(null)}
        onSuccess={refreshAll}
      />
    </div>
  );
}

function Header({
  source,
  asOf,
  // [exthours] Current US market session + whether a live extended-hours print
  // is being surfaced. Drives the small session badge next to the data badge.
  session,
  extended,
  onRefresh,
  onSync,
  syncing,
  loading,
}: {
  source?: string;
  asOf?: string;
  session?: "pre" | "regular" | "post" | "closed";
  extended?: boolean;
  onRefresh: () => void;
  onSync: () => void;
  syncing: boolean;
  loading: boolean;
}) {
  const freshness = asOf
    ? new Date(asOf).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="container mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 rounded-xl bg-gradient-to-br from-[hsl(var(--brand))] to-[hsl(var(--violet))] p-2 text-white shadow-lg shadow-[hsl(var(--brand))]/20">
            <LineChart className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold leading-none">AJ’s Portfolio</h1>
            <p className="text-[11px] text-muted-foreground">Trading Dashboard</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LiveClock />
          <ProvidersBadge />
          {source ? (
            <Badge
              variant={source === "mock" ? "warning" : "positive"}
              title={freshness ? `Data as of ${freshness}` : undefined}
            >
              {source === "mock" ? "Mock data" : `Live · ${source}`}
              {freshness ? ` · ${freshness}` : ""}
            </Badge>
          ) : null}
          {/* [exthours] Market-session badge. Highlighted when a live pre/post
              -market print is being surfaced instead of the prior close. */}
          {session && session !== "regular" ? (
            <Badge
              variant={extended ? "positive" : "neutral"}
              title={
                extended
                  ? "Showing a live extended-hours price (regular market closed)."
                  : "Regular market closed; showing the prior close."
              }
            >
              {session === "pre"
                ? "Pre-Market"
                : session === "post"
                ? "After Hours"
                : "Closed"}
              {extended ? " · live" : ""}
            </Badge>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={onSync}
            disabled={syncing}
            aria-label="Sync IBKR"
            title="Pull the latest positions & cash from IBKR now"
          >
            <RefreshCw className={syncing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            <span className="ml-1 hidden text-xs sm:inline">{syncing ? "Syncing…" : "Sync IBKR"}</span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh data"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function ReadyView({
  data,
  perf,
  stocks,
  watch,
  alerts,
  onSelect,
  onWatchSelect,
  onAction,
}: {
  data: DashboardResponse;
  perf: PerfState;
  stocks: StocksState;
  watch: WatchState;
  alerts: PortfolioAlert[];
  onSelect: (ticker: string) => void;
  onWatchSelect: (ticker: string) => void;
  onAction: (type: DialogType, ticker?: string) => void;
}) {
  const { portfolio, redistribution, disagreement } = data;
  const insights = computeInsights(portfolio);

  return (
    <div className="space-y-6">
      {/* [regime] market-regime / breadth context (additive, non-blocking) */}
      <RegimeBanner />
      {/* [scanner] high-impact macro events + intraday blackout flag */}
      <EconCalendarStrip />
      <AlertsBanner alerts={alerts} />
      <KpiCards portfolio={portfolio} pnlByPeriod={perf.data?.pnlByPeriod ?? null} />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" onClick={() => onAction("addStock")}>
          <Plus className="h-4 w-4" /> Add stock
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAction("cash")}>
          <Wallet className="h-4 w-4" /> Adjust cash
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAction("history")}>
          <Receipt className="h-4 w-4" /> Ledger
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="max-w-full justify-start overflow-x-auto rounded-full [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger value="overview" className="rounded-full px-4">
            Overview
          </TabsTrigger>
          <TabsTrigger value="stocks" className="rounded-full px-4">
            Stocks
          </TabsTrigger>
          <TabsTrigger value="analysis" className="rounded-full px-4">
            Analysis
          </TabsTrigger>
          <TabsTrigger value="watchlist" className="rounded-full px-4">
            Watchlist
          </TabsTrigger>
          <TabsTrigger value="analyzer" className="rounded-full px-4">
            Analyzer
          </TabsTrigger>
          {/* [journal] */}
          <TabsTrigger value="journal" className="rounded-full px-4">
            Journal
          </TabsTrigger>
          <TabsTrigger value="ask" className="rounded-full px-4">
            Ask
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <DailyBriefCard />
          {/* [top3] AI "Top 3 Moves Today" — additive overview panel. */}
          <TopMovesCard onSelect={onSelect} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <PerformanceChart data={perf.data} loading={perf.loading} />
            </div>
            <div className="space-y-4">
              <SafetyRating insights={insights} />
              <PortfolioPulse insights={insights} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SectorAllocation holdings={portfolio.holdings} />
            <SignalsList
              holdings={portfolio.holdings}
              disagreement={disagreement}
              onSelect={onSelect}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Holdings</CardTitle>
            </CardHeader>
            <CardContent className="px-2 sm:px-6">
              <HoldingsTable
                holdings={portfolio.holdings}
                onSelect={onSelect}
                onAction={onAction}
              />
            </CardContent>
          </Card>

          <CashBalances
            balances={data.cashBalances}
            totalAud={data.currentCash}
            fxLive={data.fxLive}
          />
        </TabsContent>

        <TabsContent value="stocks">
          <StocksTab
            holdings={portfolio.holdings}
            technicals={stocks.data?.byTicker ?? {}}
            loading={stocks.loading}
            onSelect={onSelect}
            onAction={(t, ticker) => onAction(t, ticker)}
          />
        </TabsContent>

        <TabsContent value="analysis" className="space-y-6">
          <RebalancingCards
            redistribution={redistribution}
            holdings={portfolio.holdings}
            onSelect={onWatchSelect}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <PortfolioRisk />
            {/* [sizing] concentration / position-sizing widget */}
            <ConcentrationPanel />
            <EventsRadar />
            {/* [earnings] earnings calendar / revisions / PEAD panel */}
            <EarningsCalendar />
            {/* [insider] slow open-market insider cluster-buy overlay */}
            <InsiderPanel />
            {/* [intraday] intraday VWAP/ATR/micro-regime (daily-trader overlay) */}
            <IntradayPanel />
            {/* [scanner] "Today's Battle List" — pre-market gap scanner */}
            <BattleList onSelect={onWatchSelect} />
          </div>

          <RealizedPnl />

          <SignalPerformance />

          {/* [calibration] Additive conviction overlay panel. */}
          <ConvictionCalibration />

          <section className="space-y-3">
            <SectionTitle
              title="Allocation — before & after"
              subtitle="Proposed weights after the recommended trades clear."
            />
            <AllocationChart
              before={redistribution.before}
              after={redistribution.after}
            />
          </section>

          <section className="space-y-3">
            <SectionTitle
              title="Disagreement scorecard"
              subtitle="Where our signal diverges from company verdict, exec tone and the street."
            />
            <Card>
              <CardContent className="px-2 pt-6 sm:px-6">
                <DisagreementScorecard rows={disagreement} />
              </CardContent>
            </Card>
          </section>

          {/* [news] Hard catalysts — AI-triaged news, additive (own data fetch). */}
          <section className="space-y-3">
            <SectionTitle
              title="Hard catalysts"
              subtitle="AI-triaged news — only real catalysts (earnings, guidance, M&A, regulatory, contracts)."
            />
            <CatalystFeed />
          </section>

          <section className="space-y-3">
            <SectionTitle
              title="Announcements"
              subtitle="Recent company news across the book."
            />
            <AnnouncementsFeed holdings={portfolio.holdings} />
          </section>
        </TabsContent>

        <TabsContent value="watchlist">
          <WatchlistTab data={watch.data} loading={watch.loading} onSelect={onWatchSelect} />
        </TabsContent>

        <TabsContent value="analyzer">
          <ArticleAnalyzer />
        </TabsContent>

        {/* [journal] Trade journal + execution/slippage analytics */}
        <TabsContent value="journal" className="space-y-4">
          <JournalPanel />
        </TabsContent>

        <TabsContent value="ask">
          <AssistantChat />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      {subtitle ? (
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
      <Skeleton className="h-9 w-48 rounded-full" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="rounded-full bg-negative-muted p-3 [color:hsl(var(--negative))]">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div>
          <p className="font-semibold">Couldn’t load the dashboard</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
        </div>
        <Button onClick={onRetry} variant="outline">
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
