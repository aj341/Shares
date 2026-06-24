"use client";

import { useEffect, useState } from "react";
import { ClipboardList, Copy, Check, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * [wfa] Order Tickets panel (DISPLAY ONLY — NEVER places orders).
 *
 * IBKR Flex is read-only; there is no order API. This panel renders pre-filled,
 * COPYABLE tickets (ticker, side, qty, suggested limit + stop, $ and % risk)
 * built by /api/order-tickets from the redistribution engine's already-sized
 * recommendations. The user enters them MANUALLY in IBKR. The banner makes the
 * read-only nature unmissable. Additive — no scoring/redistribution change.
 */

type OrderSide = "BUY" | "SELL" | "TRIM";
type StopBasis = "atr_like" | "percent" | "none";

type OrderTicket = {
  ticker: string;
  companyName?: string;
  side: OrderSide;
  quantity: number;
  lastPrice: number;
  limitPrice: number;
  stopPrice: number | null;
  stopBasis: StopBasis;
  stopDistancePct: number | null;
  notionalUsd: number;
  riskUsd: number | null;
  riskPctOfBook: number | null;
  origin: string;
  rationale: string;
  copyText: string;
};

type OrderTicketsResult = {
  tickets: OrderTicket[];
  totalRiskUsd: number;
  totalRiskPctOfBook: number;
  bookValue: number;
  fxUsdToBook: number;
  stopConfig: {
    atrMult: number;
    atrLookback: number;
    fallbackStopPct: number;
    limitSlippagePct: number;
  };
  asOf: string;
  displayOnly: boolean;
  disclaimer: string;
  hasData: boolean;
};

function sideVariant(side: OrderSide): "positive" | "negative" | "warning" {
  return side === "BUY" ? "positive" : side === "SELL" ? "negative" : "warning";
}

function stopBasisLabel(basis: StopBasis): string {
  return basis === "atr_like"
    ? "ATR-like (2× avg daily move)"
    : basis === "percent"
      ? "% stop (no history)"
      : "no stop";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function OrderTicketsPanel() {
  const [data, setData] = useState<OrderTicketsResult | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/order-tickets", { cache: "no-store" });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const json: OrderTicketsResult = await res.json();
        if (active) setData(json);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          Order Tickets
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>Display only &mdash; this does NOT place orders.</strong> IBKR
            Flex is read-only; there is no order API. Copy each ticket and enter
            it <strong>manually</strong> in IBKR. Suggestions from the app&rsquo;s
            engine, not financial advice.
          </span>
        </div>

        {error ? (
          <p className="text-muted-foreground">Couldn&rsquo;t load order tickets.</p>
        ) : data == null ? (
          <p className="text-muted-foreground">Loading&hellip;</p>
        ) : !data.hasData || data.tickets.length === 0 ? (
          <p className="text-muted-foreground">
            No actionable tickets right now &mdash; the redistribution engine has no
            BUY/TRIM/SELL recommendations to pre-fill. Tickets appear when the
            plan suggests a trade.
          </p>
        ) : (
          <div className="space-y-2">
            {data.tickets.map((t, i) => (
              <div
                key={`${t.ticker}-${t.side}-${i}`}
                className="rounded-md border bg-card/50 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={sideVariant(t.side)}>{t.side}</Badge>
                    <span className="font-medium">{t.ticker}</span>
                    <span className="text-xs text-muted-foreground">
                      {t.quantity} sh
                    </span>
                  </div>
                  <CopyButton text={t.copyText} />
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono-nums text-xs sm:grid-cols-4">
                  <span>
                    <span className="text-muted-foreground">Limit </span>
                    ${t.limitPrice.toFixed(2)}
                  </span>
                  <span>
                    <span className="text-muted-foreground">Stop </span>
                    {t.stopPrice != null ? `$${t.stopPrice.toFixed(2)}` : "—"}
                    {t.stopDistancePct != null ? (
                      <span className="text-muted-foreground"> ({t.stopDistancePct}%)</span>
                    ) : null}
                  </span>
                  <span>
                    <span className="text-muted-foreground">Notional </span>
                    ${Math.round(t.notionalUsd).toLocaleString("en-US")}
                  </span>
                  <span
                    className={cn(
                      t.riskPctOfBook != null && t.riskPctOfBook >= 1
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground"
                    )}
                  >
                    <span className="text-muted-foreground">Risk </span>
                    {t.riskUsd != null
                      ? `$${Math.round(t.riskUsd).toLocaleString("en-US")}`
                      : "—"}
                    {t.riskPctOfBook != null ? ` (${t.riskPctOfBook}% of book)` : ""}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stopBasisLabel(t.stopBasis)} · {t.rationale}
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Total stop risk ${Math.round(data.totalRiskUsd).toLocaleString("en-US")} (USD)
              {data.totalRiskPctOfBook ? ` ≈ ${data.totalRiskPctOfBook}% of the book` : ""}.
              Limits are last ±{data.stopConfig.limitSlippagePct}%; stops are{" "}
              {data.stopConfig.atrMult}× the ~{data.stopConfig.atrLookback}-day average
              daily move, or a {data.stopConfig.fallbackStopPct}% flat stop when price
              history is unavailable. Quantities come straight from the
              redistribution engine (already concentration-sized).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
