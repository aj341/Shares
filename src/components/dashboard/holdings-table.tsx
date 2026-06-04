"use client";

import {
  ChevronRight,
  MoreHorizontal,
  Plus,
  Minus,
  Pencil,
  Receipt,
  Archive,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatCurrency, formatNumber, formatPct } from "@/lib/utils";
import { signalToVariant, signedTextClass, scoreColorClass } from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import type { DialogType } from "@/components/dashboard/portfolio-dialogs";

export function HoldingsTable({
  holdings,
  onSelect,
  onAction,
}: {
  holdings: Holding[];
  onSelect: (ticker: string) => void;
  onAction?: (type: DialogType, ticker: string) => void;
}) {
  if (holdings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">No active holdings</p>
        <p className="text-xs text-muted-foreground">
          Add positions in <code>src/lib/constants.ts</code> to populate the book.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="min-w-[180px]">Holding</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Day</TableHead>
          <TableHead className="text-right">Mkt Value</TableHead>
          <TableHead className="text-right">Unreal. P&L</TableHead>
          <TableHead className="text-right">Weight</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead>Signal</TableHead>
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {holdings.map((h) => (
          <TableRow
            key={h.ticker}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(h.ticker)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(h.ticker);
              }
            }}
            className="cursor-pointer"
          >
            <TableCell>
              <div className="flex flex-col">
                <span className="font-mono-nums font-semibold">{h.ticker}</span>
                <span className="max-w-[200px] truncate text-xs text-muted-foreground">
                  {h.companyName}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right font-mono-nums">
              {formatNumber(h.shares, 0)}
            </TableCell>
            <TableCell className="text-right font-mono-nums">
              {formatCurrency(h.currentPrice)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right font-mono-nums",
                signedTextClass(h.dayChangePct)
              )}
            >
              {formatPct(h.dayChangePct, { sign: true })}
            </TableCell>
            <TableCell className="text-right font-mono-nums">
              {formatCurrency(h.marketValue, { compact: true })}
            </TableCell>
            <TableCell
              className={cn(
                "text-right font-mono-nums",
                signedTextClass(h.unrealisedPnl)
              )}
            >
              <div className="flex flex-col items-end">
                <span>{formatCurrency(h.unrealisedPnl, { sign: true, compact: true })}</span>
                <span className="text-xs">
                  {formatPct(h.unrealisedPnlPct, { sign: true })}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right font-mono-nums">
              {formatNumber(h.portfolioWeight, 1)}%
            </TableCell>
            <TableCell
              className={cn(
                "text-right font-mono-nums font-semibold",
                scoreColorClass(h.score)
              )}
            >
              {h.score}
            </TableCell>
            <TableCell>
              <Badge variant={signalToVariant(h.signal)}>
                {STATUS_LABELS[h.signal]}
              </Badge>
            </TableCell>
            <TableCell onClick={(e) => e.stopPropagation()}>
              {onAction ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`Actions for ${h.ticker}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onAction("buy", h.ticker)}>
                      <Plus className="h-4 w-4" /> Add shares
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAction("sell", h.ticker)}>
                      <Minus className="h-4 w-4" /> Sell shares
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAction("edit", h.ticker)}>
                      <Pencil className="h-4 w-4" /> Edit holding
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAction("history", h.ticker)}>
                      <Receipt className="h-4 w-4" /> View transactions
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onAction("archive", h.ticker)}
                    >
                      <Archive className="h-4 w-4" /> Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
