import "server-only";
import { buildPortfolio, toAudPortfolio } from "@/lib/portfolio";
import { formatCurrency, formatUsd } from "@/lib/utils";
import type { AssistantResponse, ChatMessage } from "@/lib/types";

/**
 * Conversational assistant ("Ask"): answers plain-language questions about the
 * portfolio, grounded in the dashboard's own data, via Claude. Designed for a
 * non-expert user. Explicitly general information, not personalised advice.
 *
 * The model is given a fresh portfolio snapshot each turn and instructed to
 * answer ONLY from that data (no invented figures).
 */

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
const MAX_TURNS = 12; // cap conversation history sent to the model

const SYSTEM = `You are a friendly, patient assistant inside a personal share-portfolio dashboard.
You are helping a non-expert investor (think: explaining to a parent) understand THIS portfolio.

You are given a live snapshot of the portfolio (holdings, prices, values, profit/loss, the app's
own 0–100 score and signal per stock, recent news, and cash). Answer questions using ONLY that data
plus widely-known general knowledge about the companies.

Style:
- Warm, clear, plain English. Avoid jargon; if you must use a term, explain it in a few words.
- Be concise — a few short paragraphs or bullets. Use the actual numbers from the snapshot.
- You MAY give a balanced opinion/interpretation of what the data suggests (e.g. "the app rates
  this a HOLD because…"), framed as the dashboard's read of the data.

Hard rules:
- Do NOT invent figures, prices, news, or events. If the snapshot doesn't contain it, say you don't
  have that information.
- Do NOT tell the user to buy or sell specific amounts, or give personalised financial advice.
- Always remind, briefly, that this is general information from the app's data, not financial advice,
  and that decisions should be discussed with a licensed financial adviser.
- Currency: portfolio values, cash and profit/loss are in Australian dollars (A$); individual share
  prices are in US dollars (US$). Keep that distinction.`;

function buildContext(p: Awaited<ReturnType<typeof toAudPortfolio>>): string {
  const lines = p.holdings.map((h) => {
    const news = h.announcements
      .slice()
      .sort((a, b) => Math.abs(b.impactScore) - Math.abs(a.impactScore))[0];
    const newsStr = news ? ` Latest news: "${news.title}" (impact ${news.impactScore}).` : "";
    const verdict = h.verdict?.thesisUpdate || h.verdict?.summaryBullets?.[0] || "";
    return [
      `- ${h.ticker} (${h.companyName}): ${h.shares} shares, price ${formatUsd(h.currentPrice)},`,
      `value ${formatCurrency(h.marketValue)} (${h.portfolioWeight.toFixed(1)}% of portfolio),`,
      `P&L ${formatCurrency(h.unrealisedPnl, { sign: true })} (${h.unrealisedPnlPct.toFixed(1)}%),`,
      `score ${h.score}/100, signal ${h.signal}.`,
      verdict ? `App view: ${verdict}.` : "",
      newsStr,
    ]
      .filter(Boolean)
      .join(" ");
  });

  const cashLines = p.cashBalances
    .map((c) => `${c.currency} ${formatCurrency(c.amountAud)}`)
    .join(", ");

  return [
    `Portfolio value: ${formatCurrency(p.totalPortfolioValue)} (AUD). Cost basis ${formatCurrency(p.totalCostBasis)}.`,
    `Total unrealised profit/loss: ${formatCurrency(p.totalUnrealisedPnl, { sign: true })} (${p.totalUnrealisedPnlPct.toFixed(1)}%).`,
    `Cash: ${formatCurrency(p.cash)} total — by currency (AUD value): ${cashLines}.`,
    ``,
    `Holdings:`,
    ...lines,
  ].join("\n");
}

export async function answerQuestion(messages: ChatMessage[]): Promise<AssistantResponse> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return {
      reply:
        "The assistant isn't switched on yet (it needs an API key). Once that's added, you can ask me questions about the portfolio here.",
      source: "unavailable",
    };
  }

  const portfolio = toAudPortfolio(await buildPortfolio());
  const context = buildContext(portfolio);

  // Keep the last N turns; prepend the live snapshot as context.
  const recent = messages.slice(-MAX_TURNS).filter((m) => m.content.trim());
  const convo = recent.map((m) => ({ role: m.role, content: m.content }));
  if (convo.length === 0 || convo[0].role !== "user") {
    return { reply: "Ask me anything about the portfolio — how it's doing, a particular stock, or what to keep an eye on.", source: "llm" };
  }

  const systemWithData = `${SYSTEM}\n\n=== LIVE PORTFOLIO SNAPSHOT (as of now) ===\n${context}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemWithData,
        messages: convo,
      }),
    });
    if (!res.ok) {
      return { reply: "Sorry — I couldn't reach the assistant just now. Please try again in a moment.", source: "llm" };
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    return {
      reply: text || "I'm not sure how to answer that from the portfolio data. Try asking about a specific holding or the overall position.",
      source: "llm",
    };
  } catch {
    return { reply: "Sorry — the assistant timed out. Please try again.", source: "llm" };
  }
}
