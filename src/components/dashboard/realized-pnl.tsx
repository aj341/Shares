"use client";

import * as React from "react";
import { ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCurrency } from "@/lib/utils";
import { signedTextClass } from "@/lib/ui";

type RealizedItem = {
  symbol: string;
  currency: string;
  realized: number;
  realizedShortTerm: number | null;
  realizedLongTerm: number | null;
  realizedAud: number;
};

type RealizedResponse = {
  items: RealizedItem[];
  totalRealizedAud: number | null;
  hasData: boolean;
};

/** Realized P&L straight from IBKR's FIFO books (statement period, ~30d). */
export function RealizedPnl() {
  const [data, setData] = React.useState<RealizedResponse | null>(null);

  React.useEffect(() => {
    fetch("/api/realized", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data || !data.hasData) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ReceiptText className="h-4 w-4 text-muted-foreground" />
          Realized P&L — last 30 days (IBKR books)
        </CardTitle>
        {data.totalRealizedAud != null && (
          <span
            className={cn(
              "font-mono-nums text-sm font-bold",
              signedTextClass(data.totalRealizedAud)
            )}
          >
            {formatCurrency(data.totalRealizedAud, { sign: true })}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-1.5">
        {data.items.map((i) => (
          <div key={i.symbol} className="flex items-center justify-between text-sm">
            <span className="font-mono-nums font-semibold">{i.symbol}</span>
            <span className="flex items-center gap-3">
              {i.realizedLongTerm != null && i.realizedLongTerm !== 0 && (
                <span className="text-[10px] uppercase text-muted-foreground">
                  LT (held &gt;12m): {Math.round(i.realizedLongTerm).toLocaleString()} {i.currency}
                </span>
              )}
              <span className={cn("font-mono-nums", signedTextClass(i.realizedAud))}>
                {formatCurrency(i.realizedAud, { sign: true })}
              </span>
            </span>
          </div>
        ))}
        <p className="pt-2 text-[11px] text-muted-foreground">
          FIFO, commissions included, converted to AUD at current rates. LT = lots
          held &gt;12 months (CGT-discount relevant). Source: IBKR Flex statement.
        </p>
      </CardContent>
    </Card>
  );
}
