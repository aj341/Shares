import { NextRequest, NextResponse } from "next/server";
import { analyzeArticle, recordHistory } from "@/lib/article-impact";
import { ExtractionError } from "@/lib/article-extractor";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Analyze a pasted article URL and return a structured stock-impact verdict. */
export async function POST(req: NextRequest) {
  try {
    const { url, ticker } = (await req.json()) as { url?: string; ticker?: string };
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "A url is required." } satisfies ApiError, {
        status: 400,
      });
    }
    const analysis = await analyzeArticle(url, ticker);
    recordHistory(analysis);
    return NextResponse.json(analysis);
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json({ error: err.message } satisfies ApiError, { status: 422 });
    }
    const body: ApiError = {
      error: "Failed to analyze article",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
