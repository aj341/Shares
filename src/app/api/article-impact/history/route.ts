import { NextResponse } from "next/server";
import { getHistory } from "@/lib/article-impact";

export const dynamic = "force-dynamic";

/** Recent analyses this server instance has run (ephemeral, in-memory). */
export async function GET() {
  return NextResponse.json({ history: getHistory() });
}
