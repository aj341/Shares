"use client";

import * as React from "react";
import { ChevronDown, ExternalLink, Newspaper } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toneToVariant } from "@/lib/ui";
import type { Announcement, Holding } from "@/lib/types";

type FeedItem = Announcement & { ticker: string };

const TYPE_LABELS: Record<Announcement["type"], string> = {
  earnings: "Earnings",
  filing: "Filing",
  product: "Product",
  analyst: "Analyst",
  macro: "Macro",
  other: "Other",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

export function AnnouncementsFeed({ holdings }: { holdings: Holding[] }) {
  const items: FeedItem[] = holdings
    .flatMap((h) => h.announcements.map((a) => ({ ...a, ticker: h.ticker })))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No recent announcements.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((a, i) => (
        <FeedRow key={`${a.ticker}-${a.date}-${i}`} item={a} />
      ))}
    </div>
  );
}

function FeedRow({ item: a }: { item: FeedItem }) {
  const [open, setOpen] = React.useState(false);
  const isLong = a.summary.length > 110;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md bg-muted p-1.5 text-muted-foreground">
            <Newspaper className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono-nums text-[10px]">
                {a.ticker}
              </Badge>
              <span className="text-xs text-muted-foreground tabular-nums">{formatDate(a.date)}</span>
              <Badge variant="outline" className="text-[10px]">
                {TYPE_LABELS[a.type]}
              </Badge>
              <Badge variant={toneToVariant(a.impact)} className="text-[10px]">
                Impact {a.impactScore > 0 ? `+${a.impactScore}` : a.impactScore}
              </Badge>
            </div>
            <p className="mt-1 flex items-start gap-1.5 text-sm font-medium">
              {a.title}
              {a.url && (
                <a href={a.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 text-muted-foreground hover:text-foreground">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </p>
            <p className={cn("mt-0.5 text-sm text-muted-foreground", isLong && !open && "line-clamp-2")}>
              {a.summary}
            </p>
            {isLong && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium [color:hsl(var(--brand))] hover:underline"
              >
                {open ? "Show less" : "Read full announcement"}
                <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
              </button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
