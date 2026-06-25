import { NextResponse } from "next/server";
import { getRiskStatus } from "@/lib/risk-governor";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// [riskgov] Monitor-only risk status (no gating). Consumed by the risk card and
// the hero strip's "Mood".
export async function GET() {
  try {
    return NextResponse.json(await getRiskStatus());
  } catch (err) {
    return NextResponse.json(
      { error: "risk status unavailable", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
