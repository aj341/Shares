"use client";

import * as React from "react";
import { Send, Sparkles, User } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { askAssistant } from "@/lib/client";
import type { ChatMessage } from "@/lib/types";

const SUGGESTIONS = [
  "How is the portfolio doing overall?",
  "Which stock is doing best and worst?",
  "Is anything risky right now?",
  "What should I keep an eye on this week?",
  "Explain what NBIS does in simple terms",
];

const GREETING =
  "Hi! I can answer questions about this share portfolio in plain English — how it's doing, how a particular stock is performing, or what to watch. Ask me anything.";

export function AssistantChat() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = React.useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const next: ChatMessage[] = [...messages, { role: "user", content: q }];
      setMessages(next);
      setInput("");
      setBusy(true);
      try {
        const res = await askAssistant(next);
        setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
      } catch {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "Sorry — something went wrong. Please try again." },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [messages, busy]
  );

  return (
    <Card className="flex h-[70vh] min-h-[480px] flex-col overflow-hidden">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
          <Bubble role="assistant" text={GREETING} />
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.content} />
          ))}
          {busy && <Bubble role="assistant" text="…" pulsing />}

          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2 pt-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex items-center gap-2 border-t pt-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about the portfolio…"
            disabled={busy}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
        <p className="text-center text-[11px] text-muted-foreground">
          General information from the app&apos;s data — not financial advice. Talk to a licensed
          adviser before making decisions.
        </p>
      </CardContent>
    </Card>
  );
}

function Bubble({
  role,
  text,
  pulsing,
}: {
  role: ChatMessage["role"];
  text: string;
  pulsing?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
      <span
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-muted text-muted-foreground" : "bg-brand-muted [color:hsl(var(--brand))]"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </span>
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted/60 text-foreground",
          pulsing && "animate-pulse"
        )}
      >
        {text}
      </div>
    </div>
  );
}
