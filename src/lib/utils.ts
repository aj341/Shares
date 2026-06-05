import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Money formatter with an explicit currency prefix. We prefix manually (rather
 * than Intl currency style) so AUD and USD are visually distinct: portfolio
 * value / P&L / cash are in AUD ("A$"), while per-share prices stay in USD
 * ("$"), mirroring the broker.
 */
function money(
  value: number,
  symbol: string,
  opts: { compact?: boolean; sign?: boolean; whole?: boolean } = {}
): string {
  const fractionDigits = opts.compact ? 1 : opts.whole ? 0 : 2;
  const num = new Intl.NumberFormat("en-US", {
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: opts.compact ? 0 : fractionDigits,
  }).format(Math.abs(value));
  const sign = value < 0 ? "-" : opts.sign && value > 0 ? "+" : "";
  return `${sign}${symbol}${num}`;
}

/** AUD formatter for portfolio value / P&L / cash (book currency → "A$"). */
export function formatCurrency(
  value: number,
  opts: { compact?: boolean; sign?: boolean; whole?: boolean } = {}
): string {
  return money(value, "A$", opts);
}

/** USD formatter for per-share prices (US equities are quoted in USD → "$"). */
export function formatUsd(
  value: number,
  opts: { sign?: boolean; whole?: boolean } = {}
): string {
  return money(value, "$", opts);
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
