"use client";

import * as React from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toneToVariant } from "@/lib/ui";
import type { Announcement } from "@/lib/types";

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
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function impactLabel(score: number): string {
  if (score > 0) return `+${score}`;
  return String(score);
}

export function AnnouncementsTimeline({
  announcements,
}: {
  announcements: Announcement[];
}) {
  if (announcements.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No recent announcements.
      </p>
    );
  }

  return (
    <ol className="relative space-y-5 border-l border-border pl-5">
      {announcements.map((a, i) => (
        <AnnouncementItem key={`${a.date}-${i}`} a={a} />
      ))}
    </ol>
  );
}

function AnnouncementItem({ a }: { a: Announcement }) {
  const [expanded, setExpanded] = React.useState(false);
  // ~110 chars ≈ the 2-line clamp at drawer width, so offer "read full" beyond that.
  const isLong = a.summary.length > 110;

  return (
    <li className="relative">
      <span
        aria-hidden
        className={cn(
          "absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ring-4 ring-background",
          a.impact === "positive"
            ? "bg-[hsl(var(--positive))]"
            : a.impact === "negative"
              ? "bg-[hsl(var(--negative))]"
              : "bg-muted-foreground/60"
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDate(a.date)}
        </span>
        <Badge variant="outline" className="text-[10px]">
          {TYPE_LABELS[a.type]}
        </Badge>
        <Badge variant={toneToVariant(a.impact)} className="text-[10px]">
          Impact {impactLabel(a.impactScore)}
        </Badge>
      </div>
      <div className="mt-1 flex items-start gap-1.5">
        <p className="text-sm font-medium">{a.title}</p>
        {a.url ? (
          <a
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Open source"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-0.5 text-sm text-muted-foreground",
          isLong && !expanded && "line-clamp-2"
        )}
      >
        {a.summary}
      </p>
      <div className="mt-1 flex items-center gap-3">
        <p className="text-xs text-muted-foreground/70">{a.source}</p>
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-0.5 text-xs font-medium [color:hsl(var(--brand))] hover:underline"
          >
            {expanded ? "Show less" : "Read full announcement"}
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            />
          </button>
        ) : null}
      </div>
    </li>
  );
}
