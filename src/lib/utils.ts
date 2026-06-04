import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Currency formatter (AUD book, USD-priced US equities are tracked in book ccy). */
export function formatCurrency(
  value: number,
  opts: { compact?: boolean; sign?: boolean; whole?: boolean } = {}
): string {
  const fractionDigits = opts.compact ? 1 : opts.whole ? 0 : 2;
  const formatter = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: opts.compact ? 0 : fractionDigits,
    signDisplay: opts.sign ? "exceptZero" : "auto",
  });
  return formatter.format(value);
}

export function formatNumber(value: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat("en-AU", {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

export function formatPct(value: number, opts: { sign?: boolean } = {}): string {
  return new Intl.NumberFormat("en-AU", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
    signDisplay: opts.sign ? "exceptZero" : "auto",
  }).format(value / 100);
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
