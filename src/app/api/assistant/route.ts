import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/assistant";
import type { ApiError, ChatMessage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Conversational Q&A about the portfolio, grounded in the dashboard's data. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { messages?: ChatMessage[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const clean = messages
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string"
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    const result = await answerQuestion(clean);
    return NextResponse.json(result);
  } catch (err) {
    const body: ApiError = {
      error: "Assistant failed",
      detail: (err as Error).message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
