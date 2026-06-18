import type { Signal, StatusTone } from "@/lib/types";

/** Maps domain status/signals to Badge variants and text classes. UI-only. */

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "positive"
  | "negative"
  | "warning"
  | "neutral"
  | "brand"
  | "violet";

export function toneToVariant(tone: StatusTone): BadgeVariant {
  return tone === "positive"
    ? "positive"
    : tone === "negative"
      ? "negative"
      : "neutral";
}

export function signalToVariant(signal: Signal): BadgeVariant {
  switch (signal) {
    case "STRONG_BUY":
    case "BUY":
      return "positive";
    case "HOLD":
      return "neutral";
    case "TRIM":
      return "warning";
    case "SELL":
      return "negative";
  }
}

/** Green/red text for signed figures. */
export function signedTextClass(value: number): string {
  if (value > 0) return "[color:hsl(var(--positive))]";
  if (value < 0) return "[color:hsl(var(--negative))]";
  return "text-muted-foreground";
}

export function toneTextClass(tone: StatusTone): string {
  if (tone === "positive") return "[color:hsl(var(--positive))]";
  if (tone === "negative") return "[color:hsl(var(--negative))]";
  return "text-muted-foreground";
}

/** Non-held (watchlist) verdict — buy-side language, never holder actions like Trim/Sell. */
export function researchLabel(score: number): string {
  if (score >= 70) return "Buy candidate";
  if (score >= 55) return "Watch";
  if (score >= 40) return "Marginal";
  return "Avoid";
}

export function researchVariant(score: number): BadgeVariant {
  if (score >= 70) return "positive";
  if (score >= 55) return "neutral";
  if (score >= 40) return "warning";
  return "negative";
}

/** Colored background pill for a 0-100 quality score chip (used on watchlist cards). */
export function scoreBadgeClass(score: number | null | undefined): string {
  if (score == null) return "bg-muted text-muted-foreground";
  if (score >= 70) return "bg-positive-muted [color:hsl(var(--positive))]";
  if (score >= 55) return "bg-muted text-foreground";
  if (score >= 40) return "bg-warning-muted [color:hsl(var(--warning))]";
  return "bg-negative-muted [color:hsl(var(--negative))]";
}

export function scoreColorClass(score: number): string {
  if (score >= 70) return "[color:hsl(var(--positive))]";
  if (score >= 55) return "text-foreground";
  if (score >= 40) return "[color:hsl(var(--warning))]";
  return "[color:hsl(var(--negative))]";
}

export function disagreementVariant(
  level: "low" | "medium" | "high"
): BadgeVariant {
  return level === "high" ? "negative" : level === "medium" ? "warning" : "neutral";
}
