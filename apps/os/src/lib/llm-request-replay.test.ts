import { describe, expect, it } from "vitest";
import { replayLlmRequest } from "./llm-request-replay.ts";

// Raw rows exactly as the browser mirror returns them: the full committed
// event JSON, one string per row (json(raw_jsonb)).
let nextOffset = 1;
function row(type: string, payload: Record<string, unknown>, offset?: number): string {
  const at = offset ?? nextOffset;
  nextOffset = at + 1;
  return JSON.stringify({
    type,
    payload,
    offset: at,
    createdAt: `2026-07-11T00:00:${String(at).padStart(2, "0")}.000Z`,
    path: "/agents/web/demo",
  });
}

function conversationRows(): string[] {
  nextOffset = 1;
  return [
    row("events.iterate.com/agent/system-prompt-updated", { systemPrompt: "You are **demo**." }),
    row("events.iterate.com/agent/input-added", {
      content: "hello",
      llmRequestPolicy: { behaviour: "after-current-request" },
    }),
    row("events.iterate.com/agent/llm-request-requested", {
      model: "openai/gpt-5.5",
      requestId: "llm-request:gen-0",
    }),
    row("events.iterate.com/agent/output-added", { content: "hi there", llmRequestOffset: 3 }),
    row("events.iterate.com/agent/llm-request-completed", {
      durationMs: 1234,
      llmRequestOffset: 3,
      result: { status: "success" },
    }),
    row("events.iterate.com/agent/input-added", {
      content: "look at this",
      files: [
        {
          contentType: "image/png",
          filename: "cat.png",
          path: "/agents/web/demo/abc-cat.png",
          size: 12345,
          url: "https://files.example/abc-cat.png",
        },
      ],
      llmRequestPolicy: { behaviour: "after-current-request" },
    }),
    row("events.iterate.com/agent/llm-request-requested", {
      model: "openai/gpt-5.5",
      requestId: "llm-request:gen-1",
    }),
  ];
}

describe("replayLlmRequest", () => {
  it("rebuilds the exact wire messages for a request offset", () => {
    const replay = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 3 });
    expect(replay).not.toBeNull();
    expect(replay?.model).toBe("openai/gpt-5.5");
    expect(replay?.messages).toEqual([
      { role: "system", content: "You are **demo**." },
      { role: "user", content: "hello" },
    ]);
    // Settled by the completed event that references this offset.
    expect(replay?.outcome).toEqual({ status: "success", durationMs: 1234, errorMessage: null });
  });

  it("includes prior turns and flattens attachments to hint lines for later requests", () => {
    const replay = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 7 });
    expect(replay?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    const lastMessage = replay?.messages.at(-1);
    expect(lastMessage?.content).toContain("look at this");
    // The hint line IS what the model saw — the file never travels inline.
    expect(lastMessage?.content).toContain('itx.files.get("/agents/web/demo/abc-cat.png")');
    // No completion for this request yet.
    expect(replay?.outcome).toBeNull();
  });

  it("reports failed and cancelled outcomes", () => {
    const failed = replayLlmRequest({
      rawEventJsons: [
        ...conversationRows(),
        row("events.iterate.com/agent/llm-request-completed", {
          durationMs: 30012,
          llmRequestOffset: 7,
          result: { status: "failure", error: { message: "LLM request timed out" } },
        }),
      ],
      llmRequestOffset: 7,
    });
    expect(failed?.outcome).toEqual({
      status: "failure",
      durationMs: 30012,
      errorMessage: "LLM request timed out",
    });

    const cancelled = replayLlmRequest({
      rawEventJsons: [
        ...conversationRows(),
        row("events.iterate.com/agent/llm-request-cancelled", {
          phase: "requested",
          reason: "interrupted-by-user-input",
          llmRequestOffset: 7,
        }),
      ],
      llmRequestOffset: 7,
    });
    expect(cancelled?.outcome).toEqual({
      status: "cancelled",
      durationMs: null,
      errorMessage: null,
    });
  });

  it("returns null when the offset has no llm-request-requested event", () => {
    expect(replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 2 })).toBeNull();
    expect(
      replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 99 }),
    ).toBeNull();
  });

  it("skips malformed rows like the processor's own fold does", () => {
    const rows = ["not json", JSON.stringify({ half: "an event" }), ...conversationRows()];
    const replay = replayLlmRequest({ rawEventJsons: rows, llmRequestOffset: 3 });
    expect(replay?.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });
});
