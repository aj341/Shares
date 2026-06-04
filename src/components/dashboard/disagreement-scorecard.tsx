"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn, formatPct } from "@/lib/utils";
import {
  disagreementVariant,
  signalToVariant,
  toneToVariant,
} from "@/lib/ui";
import { STATUS_LABELS } from "@/lib/constants";
import type { DisagreementRow, ExecTone } from "@/lib/types";

const EXEC_TONE_LABELS: Record<ExecTone, string> = {
  aligned: "Aligned",
  cautious: "Cautious",
  promotional: "Promotional",
  contradictory: "Contradictory",
  no_signal: "No signal",
};

const CONSENSUS_LABELS: Record<DisagreementRow["analystConsensus"], string> = {
  bullish: "Bullish",
  neutral: "Neutral",
  bearish: "Bearish",
  mixed: "Mixed",
};

export function DisagreementScorecard({ rows }: { rows: DisagreementRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No disagreement data available.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Ticker</TableHead>
          <TableHead>Company verdict</TableHead>
          <TableHead>Exec tone</TableHead>
          <TableHead>Analyst</TableHead>
          <TableHead className="text-right">Target upside</TableHead>
          <TableHead className="text-right">Our score</TableHead>
          <TableHead>Our signal</TableHead>
          <TableHead>Disagreement</TableHead>
          <TableHead className="min-w-[220px]">Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.ticker} className="hover:bg-muted/40">
            <TableCell className="font-semibold">{r.ticker}</TableCell>
            <TableCell>
              <Badge variant={toneToVariant(r.companyVerdict)}>
                {r.companyVerdict[0].toUpperCase() + r.companyVerdict.slice(1)}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {EXEC_TONE_LABELS[r.execTone]}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {CONSENSUS_LABELS[r.analystConsensus]}
            </TableCell>
            <TableCell
              className={cn(
                "text-right tabular-nums text-sm",
                r.analystTargetUpsidePct === null
                  ? "text-muted-foreground"
                  : r.analystTargetUpsidePct >= 0
                    ? "[color:hsl(var(--positive))]"
                    : "[color:hsl(var(--negative))]"
              )}
            >
              {r.analystTargetUpsidePct === null
                ? "—"
                : formatPct(r.analystTargetUpsidePct, { sign: true })}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {r.ourScore}
            </TableCell>
            <TableCell>
              <Badge variant={signalToVariant(r.ourSignal)}>
                {STATUS_LABELS[r.ourSignal]}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant={disagreementVariant(r.disagreementLevel)}>
                {r.disagreementLevel[0].toUpperCase() +
                  r.disagreementLevel.slice(1)}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {r.disagreementNotes}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
