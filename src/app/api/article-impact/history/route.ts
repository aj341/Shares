import { NextResponse } from "next/server";
import { getHistory } from "@/lib/article-impact";

export const dynamic = "force-dynamic";

/** Recent analyses (Postgres-backed, with in-memory fallback). */
export async function GET() {
  return NextResponse.json({ history: await getHistory() });
}
