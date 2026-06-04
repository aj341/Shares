"use client";

import { MessageSquare, MessagesSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { BadgeVariant } from "@/lib/ui";
import type { ExecCommentary, ExecTone } from "@/lib/types";

const TONE_META: Record<ExecTone, { label: string; variant: BadgeVariant }> = {
  aligned: { label: "Aligned", variant: "positive" },
  cautious: { label: "Cautious", variant: "warning" },
  promotional: { label: "Promotional", variant: "warning" },
  contradictory: { label: "Contradictory", variant: "negative" },
  no_signal: { label: "No signal", variant: "neutral" },
};

export function ExecutiveSentiment({ exec }: { exec: ExecCommentary }) {
  const meta = TONE_META[exec.tone];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          Executive Sentiment
        </CardTitle>
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {!exec.hasExecComments ? (
          <p className="text-sm text-muted-foreground">
            No executive commentary detected in recent disclosures.
          </p>
        ) : exec.keyPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Executives commented, but no distinct signal extracted.
          </p>
        ) : (
          <ul className="space-y-2">
            {exec.keyPoints.map((point, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
