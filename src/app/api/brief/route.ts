import { NextResponse } from "next/server";
import { buildBrief } from "@/lib/brief";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily AI brief: what to watch across the book today (cached, LLM-or-heuristic). */
export async function GET() {
  try {
    const brief = await buildBrief();
    return NextResponse.json(brief);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build brief",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
