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
import { StockDetailSheet } from "@/components/dashboard/stock-detail-sheet";
import { AllocationChart, AllocationDonut } from "@/components/dashboard/allocation-chart";
import { SafetyRating } from "@/components/dashboard/safety-rating";
import { PortfolioPulse } from "@/components/dashboard/portfolio-pulse";
import { SignalsList } from "@/components/dashboard/signals-list";
import { PerformanceChart } from "@/components/dashboard/performance-chart";
import {
  RedistributionSummaryCards,
  RedistributionTable,
} from "@/components/dashboard/redistribution-table";
import { DisagreementScorecard } from "@/components/dashboard/disagreement-scorecard";
import {
  PortfolioDialogs,
  type DialogState,
  type DialogType,
} from "@/components/dashboard/portfolio-dialogs";
import { fetchDashboard, fetchPerformance } from "@/lib/client";
import { computeInsights } from "@/lib/insights";
import type { DashboardResponse, PerformanceResponse } from "@/lib/types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DashboardResponse };

type PerfState = { loading: boolean; data: PerformanceResponse | null };

export function DashboardShell() {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [perf, setPerf] = React.useState<PerfState>({ loading: true, data: null });
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

  React.useEffect(() => {
    void load();
    void loadPerf();
  }, [load, loadPerf]);

  const handleSelect = (ticker: string) => {
    setSelected(ticker);
    setSheetOpen(true);
  };

  const openDialog = (type: DialogType, ticker?: string) =>
    setDialog({ type, ticker });

  const refreshAll = React.useCallback(() => {
    void load();
    void loadPerf();
  }, [load, loadPerf]);

  const selectedHolding =
    state.status === "ready"
      ? state.data.portfolio.holdings.find((h) => h.ticker === selected) ?? null
      : null;

  return (
    <div className="min-h-screen">
      <Header
        source={state.status === "ready" ? state.data.source : undefined}
        onRefresh={refreshAll}
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
            onSelect={handleSelect}
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
  onRefresh,
  loading,
}: {
  source?: string;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="container mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-[hsl(var(--brand))] to-[hsl(var(--violet))] p-2 text-white shadow-lg shadow-[hsl(var(--brand))]/20">
            <LineChart className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none">AJ’s Portfolio</h1>
            <p className="text-[11px] text-muted-foreground">Trading Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <LiveClock />
          {source ? (
            <Badge variant={source === "mock" ? "warning" : "positive"}>
              {source === "mock" ? "Mock data" : `Live · ${source}`}
            </Badge>
          ) : null}
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
  onSelect,
  onAction,
}: {
  data: DashboardResponse;
  perf: PerfState;
  onSelect: (ticker: string) => void;
  onAction: (type: DialogType, ticker?: string) => void;
}) {
  const { portfolio, redistribution, disagreement } = data;
  const insights = computeInsights(portfolio);

  return (
    <div className="space-y-6">
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
        <TabsList className="rounded-full">
          <TabsTrigger value="overview" className="rounded-full px-4">
            Overview
          </TabsTrigger>
          <TabsTrigger value="analysis" className="rounded-full px-4">
            Analysis
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <PerformanceChart data={perf.data} loading={perf.loading} />
            </div>
            <div className="space-y-4">
              <SafetyRating insights={insights} />
              <PortfolioPulse insights={insights} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <AllocationDonut title="Allocation" data={redistribution.before} />
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
        </TabsContent>

        <TabsContent value="analysis" className="space-y-6">
          <section className="space-y-3">
            <SectionTitle
              title="Recommended trades"
              subtitle="Generated from scores, verdicts, the 30% cap and the 5% cash buffer."
            />
            <Card>
              <CardContent className="px-2 pt-6 sm:px-6">
                <RedistributionTable
                  recommendations={redistribution.recommendations}
                />
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <SectionTitle title="Redistribution summary" />
            <RedistributionSummaryCards summary={redistribution.summary} />
          </section>

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
      <div className="grid gap-4 lg:grid-cols-3">
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
