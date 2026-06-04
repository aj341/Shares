import { NextResponse } from "next/server";
import { buildPortfolio } from "@/lib/portfolio";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const portfolio = await buildPortfolio();
    return NextResponse.json(portfolio);
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build portfolio",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
