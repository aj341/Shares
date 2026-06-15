"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  archiveHolding,
  fetchTransactions,
  patchHolding,
  postCashAdjustment,
  postTransaction,
} from "@/lib/client";
import { cn, formatUsd } from "@/lib/utils";
import { signedTextClass } from "@/lib/ui";
import type { Holding, PortfolioTransaction } from "@/lib/types";

export type DialogType =
  | "addStock"
  | "buy"
  | "sell"
  | "edit"
  | "archive"
  | "cash"
  | "history";

export type DialogState = { type: DialogType; ticker?: string } | null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function PortfolioDialogs({
  state,
  holdings,
  onClose,
  onSuccess,
}: {
  state: DialogState;
  holdings: Holding[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const open = state !== null;
  const holding = state?.ticker
    ? holdings.find((h) => h.ticker === state.ticker) ?? null
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        {state?.type === "addStock" && (
          <TradeForm mode="addStock" onClose={onClose} onSuccess={onSuccess} />
        )}
        {state?.type === "buy" && holding && (
          <TradeForm mode="buy" holding={holding} onClose={onClose} onSuccess={onSuccess} />
        )}
        {state?.type === "sell" && holding && (
          <TradeForm mode="sell" holding={holding} onClose={onClose} onSuccess={onSuccess} />
        )}
        {state?.type === "edit" && holding && (
          <EditForm holding={holding} onClose={onClose} onSuccess={onSuccess} />
        )}
        {state?.type === "archive" && holding && (
          <ArchiveForm holding={holding} onClose={onClose} onSuccess={onSuccess} />
        )}
        {state?.type === "cash" && <CashForm onClose={onClose} onSuccess={onSuccess} />}
        {state?.type === "history" && (
          <HistoryView ticker={state.ticker} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared form scaffolding
// ---------------------------------------------------------------------------

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </label>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-2 rounded-md bg-negative-muted px-3 py-2 text-sm [color:hsl(var(--negative))]">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {message}
    </p>
  );
}

function useSubmit(onSuccess: () => void, onClose: () => void) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSuccess();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// ---------------------------------------------------------------------------
// Buy / Sell / Add stock
// ---------------------------------------------------------------------------

function TradeForm({
  mode,
  holding,
  onClose,
  onSuccess,
}: {
  mode: "addStock" | "buy" | "sell";
  holding?: Holding;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { busy, error, run } = useSubmit(onSuccess, onClose);
  const isSell = mode === "sell";

  const [ticker, setTicker] = React.useState(holding?.ticker ?? "");
  const [companyName, setCompanyName] = React.useState(holding?.companyName ?? "");
  const [shares, setShares] = React.useState("");
  const [price, setPrice] = React.useState(
    holding ? String(holding.currentPrice) : ""
  );
  const [date, setDate] = React.useState(today());
  const [fees, setFees] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const sharesNum = Number(shares);
  const priceNum = Number(price);
  const feesNum = Number(fees) || 0;
  const owned = holding?.shares ?? 0;

  const estimate =
    Number.isFinite(sharesNum) && Number.isFinite(priceNum)
      ? sharesNum * priceNum + (isSell ? -feesNum : feesNum)
      : 0;

  const sellTooMany = isSell && sharesNum > owned;
  const valid =
    ticker.trim() &&
    sharesNum > 0 &&
    priceNum > 0 &&
    !sellTooMany;

  const title =
    mode === "addStock" ? "Add stock" : mode === "buy" ? `Buy ${holding?.ticker}` : `Sell ${holding?.ticker}`;

  const submit = () =>
    run(() =>
      postTransaction({
        ticker: ticker.trim().toUpperCase(),
        companyName: companyName.trim() || undefined,
        tradeType: isSell ? "SELL" : "BUY",
        shares: sharesNum,
        pricePerShare: priceNum,
        tradeDate: date,
        fees: feesNum,
        notes: notes.trim() || undefined,
      })
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {mode === "addStock"
            ? "Record a buy for a new position. Cash is reduced by the cost."
            : isSell
              ? `You own ${owned} shares. Proceeds are added to cash.`
              : "Add shares to this holding. Cost basis re-averages automatically."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        {mode === "addStock" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ticker">
              <Input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="AAPL"
                autoFocus
              />
            </Field>
            <Field label="Company" hint="Optional — defaults to ticker">
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Apple Inc."
              />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Shares" hint={isSell ? `Max ${owned}` : undefined}>
            <Input
              type="number"
              min="0"
              step="any"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              autoFocus={mode !== "addStock"}
            />
          </Field>
          <Field label="Price / share (USD)">
            <Input
              type="number"
              min="0"
              step="any"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Trade date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Fees" hint="Optional">
            <Input
              type="number"
              min="0"
              step="any"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <Field label="Notes" hint="Optional">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {isSell ? "Est. proceeds" : "Est. cost"}
          </span>
          <span className="font-mono-nums font-semibold">
            {formatUsd(Math.abs(estimate))}
          </span>
        </div>

        {sellTooMany && <ErrorBanner message={`Cannot sell more than ${owned} shares.`} />}
        {error && <ErrorBanner message={error} />}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSell ? "Record sell" : mode === "addStock" ? "Add stock" : "Record buy"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Manual edit (ADJUSTMENT)
// ---------------------------------------------------------------------------

function EditForm({
  holding,
  onClose,
  onSuccess,
}: {
  holding: Holding;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { busy, error, run } = useSubmit(onSuccess, onClose);
  const [shares, setShares] = React.useState(String(holding.shares));
  const [avgPrice, setAvgPrice] = React.useState(String(holding.entryPrice));
  const [notes, setNotes] = React.useState("");

  const sharesNum = Number(shares);
  const avgNum = Number(avgPrice);
  const valid = sharesNum >= 0 && avgNum >= 0;

  const submit = () =>
    run(() =>
      patchHolding(holding.ticker, {
        shares: sharesNum,
        avgPrice: avgNum,
        companyName: holding.companyName,
        notes: notes.trim() || undefined,
      })
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit {holding.ticker}</DialogTitle>
        <DialogDescription>Manual admin adjustment of this holding.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <p className="flex items-start gap-2 rounded-md bg-warning-muted px-3 py-2 text-xs [color:hsl(var(--warning))]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Manual adjustments override transaction-derived values and can diverge
          from your trade history. Prefer Buy/Sell for real trades.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shares">
            <Input
              type="number"
              min="0"
              step="any"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
            />
          </Field>
          <Field label="Avg entry price">
            <Input
              type="number"
              min="0"
              step="any"
              value={avgPrice}
              onChange={(e) => setAvgPrice(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Reason / notes" hint="Optional">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <ErrorBanner message={error} />}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Save adjustment
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function ArchiveForm({
  holding,
  onClose,
  onSuccess,
}: {
  holding: Holding;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { busy, error, run } = useSubmit(onSuccess, onClose);
  const hasShares = holding.shares > 0;
  const submit = () => run(() => archiveHolding(holding.ticker, hasShares));

  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive {holding.ticker}?</DialogTitle>
        <DialogDescription>
          Removes it from active holdings. The transaction history is kept.
        </DialogDescription>
      </DialogHeader>
      {hasShares ? (
        <p className="flex items-start gap-2 rounded-md bg-warning-muted px-3 py-2 text-xs [color:hsl(var(--warning))]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {holding.ticker} still has {holding.shares} shares. Archiving will force-
          remove it without recording a sale.
        </p>
      ) : null}
      {error && <ErrorBanner message={error} />}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={submit} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {hasShares ? "Force archive" : "Archive"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cash adjustment
// ---------------------------------------------------------------------------

function CashForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { busy, error, run } = useSubmit(onSuccess, onClose);
  const [direction, setDirection] = React.useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState(today());
  const [notes, setNotes] = React.useState("");

  const amt = Number(amount);
  const valid = amt > 0;
  const signed = direction === "deposit" ? amt : -amt;

  const submit = () =>
    run(() =>
      postCashAdjustment({ amount: signed, tradeDate: date, notes: notes.trim() || undefined })
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Adjust cash</DialogTitle>
        <DialogDescription>Record a deposit or withdrawal of cash.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-2">
          {(["deposit", "withdraw"] as const).map((d) => (
            <Button
              key={d}
              type="button"
              variant={direction === d ? "default" : "outline"}
              onClick={() => setDirection(d)}
              className="capitalize"
            >
              {d}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (USD)">
            <Input
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes" hint="Optional">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <ErrorBanner message={error} />}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {direction === "deposit" ? "Add cash" : "Withdraw cash"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Transaction history
// ---------------------------------------------------------------------------

function HistoryView({ ticker }: { ticker?: string }) {
  const [txs, setTxs] = React.useState<PortfolioTransaction[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetchTransactions()
      .then((r) => setTxs(r.transactions))
      .catch((e) => setError((e as Error).message));
  }, []);

  const rows = (txs ?? []).filter((t) => (ticker ? t.ticker === ticker : true));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{ticker ? `${ticker} transactions` : "Transaction ledger"}</DialogTitle>
        <DialogDescription>
          Holdings are derived from this ledger.
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] overflow-auto">
        {error ? (
          <ErrorBanner message={error} />
        ) : txs === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No transactions yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b text-left">
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">Type</th>
                {!ticker && <th className="py-2 pr-2">Ticker</th>}
                <th className="py-2 pr-2 text-right">Shares</th>
                <th className="py-2 pr-2 text-right">Price</th>
                <th className="py-2 pr-2 text-right">Cash impact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="py-2 pr-2 tabular-nums">{t.tradeDate}</td>
                  <td className="py-2 pr-2">
                    <Badge
                      variant={
                        t.tradeType === "BUY"
                          ? "positive"
                          : t.tradeType === "SELL"
                            ? "negative"
                            : "neutral"
                      }
                      className="text-[10px]"
                    >
                      {t.tradeType}
                    </Badge>
                  </td>
                  {!ticker && (
                    <td className="py-2 pr-2 font-mono-nums font-medium">{t.ticker}</td>
                  )}
                  <td className="py-2 pr-2 text-right font-mono-nums">
                    {t.shares || "—"}
                  </td>
                  <td className="py-2 pr-2 text-right font-mono-nums">
                    {t.pricePerShare ? formatUsd(t.pricePerShare) : "—"}
                  </td>
                  <td
                    className={cn(
                      "py-2 pr-2 text-right font-mono-nums",
                      signedTextClass(t.netCashImpact)
                    )}
                  >
                    {t.netCashImpact
                      ? formatUsd(t.netCashImpact, { sign: true })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
