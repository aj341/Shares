"use client";

import { Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { CashBalance } from "@/lib/types";

const CCY_LABEL: Record<string, string> = {
  AUD: "AUD Cash",
  USD: "USD Cash",
  EUR: "EUR Cash",
  GBP: "GBP Cash",
};

/**
 * Dedicated cash section: per-currency balances and their AUD value, plus the
 * combined total. The rest of the dashboard shows only the combined AUD total.
 */
export function CashBalances({
  balances,
  totalAud,
  fxLive,
}: {
  balances: CashBalance[];
  totalAud: number;
  fxLive: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Cash Balances
        </CardTitle>
        <span className="text-[11px] text-muted-foreground">
          combined in AUD · {fxLive ? "live FX" : "est. FX"}
        </span>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        <div className="divide-y divide-border">
          {balances.map((b) => (
            <div
              key={b.currency}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="text-sm font-medium">
                {CCY_LABEL[b.currency] ?? `${b.currency} Cash`}
              </span>
              <span className="w-28 text-right font-mono-nums text-sm">
                {formatCurrency(b.amountAud)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 py-3">
            <span className="text-sm font-semibold">Total Cash</span>
            <span className="w-28 text-right font-mono-nums text-sm font-bold">
              {formatCurrency(totalAud)}
            </span>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Foreign balances are converted to AUD at current exchange rates.
        </p>
      </CardContent>
    </Card>
  );
}
