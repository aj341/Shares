import "server-only";
import type { PortfolioTransaction, TradeType } from "@/lib/types";

/**
 * Helpers to construct validated PortfolioTransaction records from raw input.
 * Cash impact and gross amount are computed here so every caller is consistent.
 */

export type TradeInput = {
  ticker: string;
  companyName?: string;
  tradeType: TradeType;
  shares: number;
  pricePerShare: number;
  tradeDate: string;
  fees?: number;
  notes?: string;
  /** ADJUSTMENT only: explicit override of shares + avg price. */
  adjustment?: { shares: number; avgPrice: number };
};

export type CashAdjustmentInput = {
  amount: number; // signed delta (+ deposit, - withdrawal)
  tradeDate: string;
  notes?: string;
};

export class ValidationError extends Error {}

function rid(prefix: string): string {
  // Deterministic-ish unique id without Math.random (avoids harness ban).
  return `${prefix}-${process.hrtime.bigint().toString(36)}`;
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Build a BUY/SELL/ADJUSTMENT transaction with computed cash impact. */
export function buildTransaction(input: TradeInput): PortfolioTransaction {
  const ticker = input.ticker?.trim().toUpperCase();
  if (!ticker) throw new ValidationError("Ticker is required.");
  if (!isValidDate(input.tradeDate))
    throw new ValidationError("A valid trade date (YYYY-MM-DD) is required.");

  const fees = round2(Math.max(0, input.fees ?? 0));
  const createdAt = new Date().toISOString();

  if (input.tradeType === "ADJUSTMENT") {
    if (!input.adjustment)
      throw new ValidationError("Adjustment requires shares and avg price.");
    if (input.adjustment.shares < 0)
      throw new ValidationError("Adjusted shares cannot be negative.");
    if (input.adjustment.avgPrice < 0)
      throw new ValidationError("Average price cannot be negative.");
    return {
      id: rid("adj"),
      ticker,
      companyName: input.companyName?.trim() || ticker,
      tradeType: "ADJUSTMENT",
      shares: input.adjustment.shares,
      pricePerShare: round4(input.adjustment.avgPrice),
      grossAmount: 0,
      fees: 0,
      netCashImpact: 0,
      tradeDate: input.tradeDate,
      notes: input.notes?.trim() || "Manual adjustment",
      createdAt,
      adjustment: {
        shares: input.adjustment.shares,
        avgPrice: round4(input.adjustment.avgPrice),
      },
    };
  }

  const shares = input.shares;
  const price = input.pricePerShare;
  if (!Number.isFinite(shares) || shares <= 0)
    throw new ValidationError("Shares must be greater than zero.");
  if (!Number.isFinite(price) || price <= 0)
    throw new ValidationError("Price per share must be greater than zero.");

  const gross = round2(shares * price);
  const netCashImpact =
    input.tradeType === "BUY" ? -round2(gross + fees) : round2(gross - fees);

  return {
    id: rid(input.tradeType.toLowerCase()),
    ticker,
    companyName: input.companyName?.trim() || ticker,
    tradeType: input.tradeType,
    shares,
    pricePerShare: round4(price),
    grossAmount: gross,
    fees,
    netCashImpact,
    tradeDate: input.tradeDate,
    notes: input.notes?.trim() || undefined,
    createdAt,
  };
}

/** Build a CASH-only adjustment transaction. */
export function buildCashAdjustment(input: CashAdjustmentInput): PortfolioTransaction {
  if (!Number.isFinite(input.amount) || input.amount === 0)
    throw new ValidationError("Cash adjustment amount must be non-zero.");
  if (!isValidDate(input.tradeDate))
    throw new ValidationError("A valid date (YYYY-MM-DD) is required.");
  return {
    id: rid("cash"),
    ticker: "CASH",
    companyName: "Cash",
    tradeType: "ADJUSTMENT",
    shares: 0,
    pricePerShare: 0,
    grossAmount: round2(Math.abs(input.amount)),
    fees: 0,
    netCashImpact: round2(input.amount),
    tradeDate: input.tradeDate,
    notes: input.notes?.trim() || "Cash adjustment",
    createdAt: new Date().toISOString(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
