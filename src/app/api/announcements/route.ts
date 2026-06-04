import { NextResponse } from "next/server";
import { buildPortfolio } from "@/lib/portfolio";
import { buildAnnouncements } from "@/lib/dashboard";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const portfolio = await buildPortfolio();
    return NextResponse.json(buildAnnouncements(portfolio));
  } catch (err) {
    const body: ApiError = {
      error: "Failed to build announcements",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
