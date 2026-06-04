import "server-only";
import { parse, type HTMLElement } from "node-html-parser";
import type { ExtractedArticle } from "@/lib/types";

/**
 * Server-side article extraction. Fetches the page HTML and pulls the
 * headline, source, author, publish date, canonical URL and main body text,
 * stripping scripts/nav/footer/aside. No DOM/browser — uses node-html-parser,
 * so JS-rendered or bot-blocked pages may yield little body (handled by caller).
 */

export class ExtractionError extends Error {}

function isValidArticleUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

function metaContent(root: HTMLElement, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const c = el?.getAttribute("content")?.trim();
    if (c) return c;
  }
  return undefined;
}

export async function extractArticle(rawUrl: string): Promise<ExtractedArticle> {
  const url = isValidArticleUrl(rawUrl);
  if (!url) throw new ExtractionError("That doesn't look like a valid article URL.");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        // Identify as a regular browser; many sites 403 unknown agents.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
  } catch {
    throw new ExtractionError("Couldn't reach that page (timeout or network error).");
  }

  if (res.status === 403 || res.status === 401) {
    throw new ExtractionError("That site blocks automated access — try a different source.");
  }
  if (!res.ok) {
    throw new ExtractionError(`The page returned ${res.status}.`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    throw new ExtractionError("That URL isn't an HTML article page.");
  }

  const html = await res.text();
  const root = parse(html, { blockTextElements: { script: false, style: false } });

  // Remove junk.
  root
    .querySelectorAll("script,style,noscript,nav,footer,aside,header,form,svg,iframe")
    .forEach((el) => el.remove());

  const headline =
    metaContent(root, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    root.querySelector("h1")?.text?.trim() ||
    root.querySelector("title")?.text?.trim() ||
    "Untitled article";

  const source =
    metaContent(root, ['meta[property="og:site_name"]']) ||
    url.hostname.replace(/^www\./, "");

  const author =
    metaContent(root, ['meta[name="author"]', 'meta[property="article:author"]']) ||
    root.querySelector('[rel="author"]')?.text?.trim() ||
    undefined;

  const publishDate =
    metaContent(root, [
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[name="date"]',
      'meta[name="pubdate"]',
      'meta[property="og:updated_time"]',
    ]) ||
    root.querySelector("time[datetime]")?.getAttribute("datetime") ||
    undefined;

  const canonicalUrl =
    root.querySelector('link[rel="canonical"]')?.getAttribute("href") || undefined;

  // Body: prefer <article>, else gather substantive paragraphs.
  const scope = root.querySelector("article") ?? root;
  const paras = scope
    .querySelectorAll("p")
    .map((p) => p.text.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 40);

  const body = dedupe(paras).join("\n\n").slice(0, 12000);

  if (body.length < 200) {
    throw new ExtractionError(
      "Couldn't extract readable article text (the page may be paywalled or JavaScript-rendered)."
    );
  }

  return {
    url: url.toString(),
    canonicalUrl,
    source,
    headline: clean(headline),
    author,
    publishDate,
    body,
  };
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}
