import "server-only";

/**
 * IBKR Flex Web Service connector (read-only).
 *
 * Two-step protocol:
 *   1. SendRequest  -> returns a ReferenceCode + a GetStatement URL.
 *   2. GetStatement -> returns the statement XML (may report "generation in
 *      progress" briefly, so we poll a few times).
 *
 * We parse Open Positions (shares + avg cost) and the Cash Report (per-currency
 * ending cash). The token is read from env only and never logged.
 *
 * Docs: https://www.ibkrguides.com/clientportal/performanceandstatements/flex-web-service.htm
 */

const SEND_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
const FLEX_VERSION = "3";

/** Env var names we'll accept for the Flex token (canonical first). */
const TOKEN_ENV_NAMES = [
  "IBKR_FLEX_TOKEN",
  "IBKR_FLEX_WEB_TOKEN",
  "IBKR_TOKEN",
  "IBKR_API_TOKEN",
  "IBKR_API_KEY",
  "IBKR_API",
  "IBKR",
  "FLEX_TOKEN",
  "FLEX_WEB_TOKEN",
] as const;

function flexToken(): string | null {
  for (const name of TOKEN_ENV_NAMES) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

export function isIbkrConfigured(): boolean {
  return flexToken() !== null;
}

function queryId(): string {
  return process.env.IBKR_FLEX_QUERY_ID?.trim() || "1533679";
}

export type IbkrPosition = {
  symbol: string;
  quantity: number;
  avgPrice: number; // costBasisPrice
  costBasisMoney: number | null;
  currency: string;
  assetCategory: string;
  description: string | null;
};

export type IbkrCash = {
  currency: string;
  endingCash: number;
};

export type IbkrTrade = {
  symbol: string;
  tradeDate: string;
  buySell: string;
  quantity: number;
  tradePrice: number;
  commission: number | null;
  /** FIFO realized P&L booked by this execution (USD for US stocks). */
  realizedPnl: number | null;
  currency: string;
  assetCategory: string;
};

export type IbkrSymbolPerformance = {
  symbol: string;
  realizedTotal: number | null;
  unrealizedTotal: number | null;
};

export type IbkrStatement = {
  positions: IbkrPosition[];
  cash: IbkrCash[];
  /** Present only when the Flex query includes the Trades section. */
  trades: IbkrTrade[];
  /** Present only when the query includes Realized & Unrealized Performance. */
  performance: IbkrSymbolPerformance[];
  /** Raw sample of the first performance element (debug aid). */
  performanceSampleTag?: string | null;
  whenGenerated: string | null;
};

// --- tiny XML helpers (attribute extraction on flat Flex elements) ----------

/** Pull the value of one attribute from an element's opening tag. */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function num(tag: string, name: string): number | null {
  const v = attr(tag, name);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** All opening tags for an element name (handles self-closing + normal). */
function elements(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*?/?>`, "gi");
  return xml.match(re) ?? [];
}

function firstTagValue(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, "i"));
  return m ? m[1] : null;
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- protocol ---------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (!res.ok) throw new Error(`Flex HTTP ${res.status}`);
  return res.text();
}

/** Run the full Flex protocol and return the raw statement XML. */
export async function fetchFlexXml(): Promise<string> {
  const token = flexToken();
  if (!token) throw new Error("IBKR Flex token not configured");

  const sendXml = await fetchText(
    `${SEND_URL}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId())}&v=${FLEX_VERSION}`
  );
  const status = firstTagValue(sendXml, "Status");
  if (status !== "Success") {
    const code = firstTagValue(sendXml, "ErrorCode") ?? "?";
    const msg = firstTagValue(sendXml, "ErrorMessage") ?? "SendRequest failed";
    throw new Error(`Flex SendRequest: ${msg} (code ${code})`);
  }
  const ref = firstTagValue(sendXml, "ReferenceCode");
  const baseUrl = firstTagValue(sendXml, "Url");
  if (!ref || !baseUrl) throw new Error("Flex SendRequest: missing ReferenceCode/Url");

  const getUrl = `${baseUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(ref)}&v=${FLEX_VERSION}`;

  // Poll GetStatement — IBKR returns code 1019 while the statement is generating.
  for (let attempt = 0; attempt < 6; attempt++) {
    const xml = await fetchText(getUrl);
    if (xml.includes("<FlexQueryResponse")) return xml;
    const code = firstTagValue(xml, "ErrorCode");
    if (code && code !== "1019") {
      const msg = firstTagValue(xml, "ErrorMessage") ?? "GetStatement failed";
      throw new Error(`Flex GetStatement: ${msg} (code ${code})`);
    }
    await delay(2500);
  }
  throw new Error("Flex GetStatement: statement not ready after retries");
}

/** Fetch + parse the Flex statement into positions and cash. */
export async function fetchFlexStatement(): Promise<IbkrStatement> {
  const xml = await fetchFlexXml();

  const positions: IbkrPosition[] = elements(xml, "OpenPosition")
    .map((tag) => ({
      symbol: (attr(tag, "symbol") ?? "").toUpperCase(),
      quantity: num(tag, "position") ?? 0,
      avgPrice: num(tag, "costBasisPrice") ?? 0,
      costBasisMoney: num(tag, "costBasisMoney"),
      currency: attr(tag, "currency") ?? "USD",
      assetCategory: attr(tag, "assetCategory") ?? "",
      description: attr(tag, "description"),
    }))
    .filter((p) => p.symbol && p.quantity !== 0);

  const cash: IbkrCash[] = elements(xml, "CashReportCurrency")
    .map((tag) => ({
      currency: (attr(tag, "currency") ?? "").toUpperCase(),
      endingCash: num(tag, "endingCash") ?? 0,
    }))
    // Drop the BASE_SUMMARY aggregate row — we want per-currency lines.
    .filter((c) => c.currency && c.currency !== "BASE_SUMMARY");

  const whenGenerated =
    elements(xml, "FlexStatement")
      .map((t) => attr(t, "whenGenerated"))
      .find(Boolean) ?? null;

  // Optional sections — empty arrays when the Flex query doesn't include them.
  const trades: IbkrTrade[] = elements(xml, "Trade")
    .map((tag) => ({
      symbol: (attr(tag, "symbol") ?? "").toUpperCase(),
      tradeDate: attr(tag, "tradeDate") ?? "",
      buySell: attr(tag, "buySell") ?? "",
      quantity: num(tag, "quantity") ?? 0,
      tradePrice: num(tag, "tradePrice") ?? 0,
      commission: num(tag, "ibCommission"),
      realizedPnl: num(tag, "fifoPnlRealized"),
      currency: attr(tag, "currency") ?? "USD",
      assetCategory: attr(tag, "assetCategory") ?? "",
    }))
    .filter((t) => t.symbol && t.quantity !== 0);

  const performance: IbkrSymbolPerformance[] = elements(
    xml,
    "FIFOPerformanceSummaryUnderlying"
  )
    .map((tag) => ({
      symbol: (attr(tag, "symbol") ?? attr(tag, "underlyingSymbol") ?? "").toUpperCase(),
      realizedTotal: num(tag, "realizedTotal") ?? num(tag, "totalRealized"),
      unrealizedTotal: num(tag, "unrealizedTotal") ?? num(tag, "totalUnrealized"),
    }))
    .filter((p) => p.symbol);

  // Raw first performance tag — surfaces real attribute names via ?debug=1.
  const performanceSampleTag =
    elements(xml, "FIFOPerformanceSummaryUnderlying")[0]?.slice(0, 900) ?? null;

  return { positions, cash, trades, performance, performanceSampleTag, whenGenerated };
}
