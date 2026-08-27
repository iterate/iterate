import { describe, expect, it } from "vitest";
import { AgentProcessorContract } from "../domains/agents/agent-processor-contract.ts";
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
    row("events.iterate.com/agents/context-added", {
      role: "system",
      key: "agent/system-prompt",
      content: "You are **demo**.",
    }),
    row("events.iterate.com/agents/context-added", {
      role: "user",
      actor: { type: "user", origin: "web" },
      content: "hello",
      llmRequestPolicy: { behaviour: "after-current-request" },
    }),
    row("events.iterate.com/agent/llm-request-requested", {
      model: "openai/gpt-5.5",
      expiresAt: Date.parse("2026-07-11T00:01:00.000Z"),
    }),
    row("events.iterate.com/agents/context-added", {
      role: "assistant",
      content: "hi there",
      llmRequestOffset: 3,
    }),
    row("events.iterate.com/agent/llm-request-settled", {
      requestOffset: 3,
      durationMs: 1234,
      result: { status: "succeeded", text: "hi there" },
    }),
    row("events.iterate.com/agents/context-added", {
      role: "user",
      actor: { type: "user", origin: "web" },
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
      expiresAt: Date.parse("2026-07-11T00:01:00.000Z"),
    }),
  ];
}

describe("replayLlmRequest", () => {
  it("rebuilds the exact wire messages for a request offset", () => {
    const replay = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 3 });
    expect(replay).not.toBeNull();
    expect(replay?.model).toBe("openai/gpt-5.5");
    expect(replay?.messages).toEqual([
      {
        id: "3:0",
        role: "system",
        content: expect.stringContaining(
          "Journal-projected context messages are items from an append-only event stream",
        ),
      },
      {
        id: "3:1",
        // The standing document: one system message of tagged sections.
        role: "system",
        content: '<section key="agent/system-prompt">\nYou are **demo**.\n</section>',
      },
      { id: "3:2", role: "user", content: "hello" },
      {
        id: "3:3",
        role: "developer",
        // The request's own permanent send stamp, from the
        // llm-request-requested event's journaled append time — replay
        // reproduces it exactly, and every later request is a superset.
        content: "Requested at: 2026-07-11T00:00:03.000Z",
      },
    ]);
    // Settled by the settled event that points back at this offset.
    expect(replay?.outcome).toEqual({ status: "success", durationMs: 1234, errorMessage: null });
  });

  it("includes prior turns and flattens attachments to hint lines for later requests", () => {
    const replay = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 7 });
    expect(replay?.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "developer", // request 3's permanent send stamp
      "assistant",
      "user",
      "developer", // this request's own send stamp
    ]);
    const lastMessage = replay?.messages.at(-2);
    expect(lastMessage?.content).toContain("look at this");
    // The hint line IS what the model saw — the file never travels inline.
    expect(lastMessage?.content).toContain('itx.files.get("/agents/web/demo/abc-cat.png")');
    // No settlement for this request yet.
    expect(replay?.outcome).toBeNull();
  });

  it("reports succeeded, failed, and cancelled outcomes from the settled event", () => {
    const succeeded = replayLlmRequest({
      rawEventJsons: [
        ...conversationRows(),
        row("events.iterate.com/agent/llm-request-settled", {
          requestOffset: 7,
          durationMs: 1500,
          result: {
            status: "succeeded",
            text: "hi again",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        }),
      ],
      llmRequestOffset: 7,
    });
    expect(succeeded?.outcome).toEqual({ status: "success", durationMs: 1500, errorMessage: null });

    const failed = replayLlmRequest({
      rawEventJsons: [
        ...conversationRows(),
        row("events.iterate.com/agent/llm-request-settled", {
          requestOffset: 7,
          durationMs: 30012,
          result: { status: "failed", errorMessage: "LLM request timed out" },
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
        row("events.iterate.com/agent/llm-request-settled", {
          requestOffset: 7,
          result: {
            status: "cancelled",
            reason: "interrupted-by-user-input",
            partialText: "hi ag",
          },
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

  it("recovers the interrupted partial from the settled fact when chunks are gone", () => {
    const replay = replayLlmRequest({
      rawEventJsons: [
        ...conversationRows(),
        row("events.iterate.com/agent/llm-request-settled", {
          requestOffset: 7,
          result: {
            status: "cancelled",
            reason: "interrupted-by-user-input",
            partialText: "hi ag",
          },
        }),
      ],
      llmRequestOffset: 7,
    });
    expect(replay?.response).toEqual({ text: "hi ag", thinkingText: "", source: "output" });
  });

  it("returns the committed output as the response, with thinking from chunks", () => {
    const chunkRows = [
      row(
        "events.iterate.com/agent/llm-response-chunk",
        {
          chunk: { choices: [{ delta: { reasoning_content: "let me think" } }] },
          llmRequestOffset: 3,
          sequence: 0,
        },
        50,
      ),
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "hi " } }] }, llmRequestOffset: 3, sequence: 1 },
        51,
      ),
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "there" } }] }, llmRequestOffset: 3, sequence: 2 },
        52,
      ),
    ];
    const replay = replayLlmRequest({
      rawEventJsons: conversationRows(),
      chunkEventJsons: chunkRows,
      llmRequestOffset: 3,
    });
    // The committed assistant context text is authoritative over the streamed
    // concatenation; thinking only ever exists in the chunks.
    expect(replay?.response).toEqual({
      text: "hi there",
      thinkingText: "let me think",
      source: "output",
    });
  });

  it("re-assembles a partial response from chunks when no output committed", () => {
    // Request 7 was cancelled mid-stream: chunks are the only copy. Sequence
    // order wins even when rows arrive shuffled.
    const chunkRows = [
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "world" } }] }, llmRequestOffset: 7, sequence: 1 },
        60,
      ),
      row(
        "events.iterate.com/agent/llm-response-chunk",
        {
          chunk: { choices: [{ delta: { content: "hello " } }] },
          llmRequestOffset: 7,
          sequence: 0,
        },
        61,
      ),
      // Another request's chunk must not bleed in.
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "NOPE" } }] }, llmRequestOffset: 3, sequence: 0 },
        62,
      ),
    ];
    const replay = replayLlmRequest({
      rawEventJsons: conversationRows(),
      chunkEventJsons: chunkRows,
      llmRequestOffset: 7,
    });
    expect(replay?.response).toEqual({ text: "hello world", thinkingText: "", source: "chunks" });
  });

  it("re-assembles a partial response from coalesced llm-response-chunks windows", () => {
    // Windows carry many chunks in provider order; flush sequence order wins
    // even when rows arrive shuffled.
    const chunkRows = [
      row(
        "events.iterate.com/agent/llm-response-chunks",
        {
          chunks: [{ choices: [{ delta: { content: "world" } }] }],
          llmRequestOffset: 7,
          sequence: 1,
        },
        60,
      ),
      row(
        "events.iterate.com/agent/llm-response-chunks",
        {
          chunks: [
            { choices: [{ delta: { reasoning_content: "hmm" } }] },
            { choices: [{ delta: { content: "hello " } }] },
          ],
          llmRequestOffset: 7,
          sequence: 0,
        },
        61,
      ),
    ];
    const replay = replayLlmRequest({
      rawEventJsons: conversationRows(),
      chunkEventJsons: chunkRows,
      llmRequestOffset: 7,
    });
    expect(replay?.response).toEqual({
      text: "hello world",
      thinkingText: "hmm",
      source: "chunks",
    });
  });

  it("dedupes chunk rows by sequence (evicted-then-restreamed attempts leave two rows per sequence)", () => {
    // Chunk rows are ephemeral and evictable: a sweep mid-turn followed by a
    // retry re-appends the same sequences at new offsets, and the browser
    // mirror (which never deletes) keeps both copies. First occurrence wins.
    const chunk = (content: string, sequence: number, offset: number) =>
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content } }] }, llmRequestOffset: 7, sequence },
        offset,
      );
    const replay = replayLlmRequest({
      rawEventJsons: conversationRows(),
      chunkEventJsons: [
        chunk("hello ", 0, 60),
        chunk("world", 1, 61),
        // The restreamed copies of the same sequences, at later offsets.
        chunk("hello ", 0, 90),
        chunk("world", 1, 91),
      ],
      llmRequestOffset: 7,
    });
    expect(replay?.response).toEqual({ text: "hello world", thinkingText: "", source: "chunks" });
  });

  it("derives token counts, latency, and tokens/second from the lifecycle events", () => {
    // Request 7 (still open in conversationRows). Timeline — createdAt encodes
    // the offset as seconds (see row()): requested at :07, first chunk at :10,
    // last chunk at :14, settled at :15. Time-to-first-chunk anchors on the
    // requested event itself (there is no dial event, so it includes any
    // pre-dial delay): 3s. Generation window first chunk → settled: 5s,
    // 100 output tok = 20 tok/s.
    const rows = [
      ...conversationRows(),
      row(
        "events.iterate.com/agent/llm-request-settled",
        {
          requestOffset: 7,
          durationMs: 5000,
          result: {
            status: "succeeded",
            text: "ab",
            rawResponse: { streamed: true, cloudflareAiGatewayResponseCacheStatus: "HIT" },
          },
        },
        15,
      ),
      row(
        "events.iterate.com/agent/token-usage-reported",
        {
          llmRequestOffset: 7,
          model: "openai/gpt-5.5",
          maxContextTokens: 272000,
          inputTokens: 2500,
          outputTokens: 100,
          cachedInputTokens: 2400,
          reasoningOutputTokens: 18,
        },
        16,
      ),
    ];
    const chunkRows = [
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "a" } }] }, llmRequestOffset: 7, sequence: 0 },
        10,
      ),
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "b" } }] }, llmRequestOffset: 7, sequence: 1 },
        14,
      ),
    ];
    const replay = replayLlmRequest({
      rawEventJsons: rows,
      chunkEventJsons: chunkRows,
      llmRequestOffset: 7,
    });
    expect(replay?.stats).toEqual({
      tokens: {
        inputTokens: 2500,
        outputTokens: 100,
        cachedInputTokens: 2400,
        reasoningOutputTokens: 18,
        maxContextTokens: 272000,
      },
      timeToFirstChunkMs: 3000,
      generationMs: 5000,
      chunkCount: 2,
      outputTokensPerSecond: 20,
      gatewayCacheStatus: "HIT",
      rawResponse: { streamed: true, cloudflareAiGatewayResponseCacheStatus: "HIT" },
    });
  });

  it("ends the generation window at the last chunk when the request never settled", () => {
    // Request 7 streamed two chunks and then nothing more committed — no
    // settled event. The window can only be measured to the last chunk.
    const chunkRows = [
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "a" } }] }, llmRequestOffset: 7, sequence: 0 },
        10,
      ),
      row(
        "events.iterate.com/agent/llm-response-chunk",
        { chunk: { choices: [{ delta: { content: "b" } }] }, llmRequestOffset: 7, sequence: 1 },
        14,
      ),
    ];
    const replay = replayLlmRequest({
      rawEventJsons: conversationRows(),
      chunkEventJsons: chunkRows,
      llmRequestOffset: 7,
    });
    // Requested at :07 → first chunk :10; first chunk :10 → last chunk :14.
    expect(replay?.stats.timeToFirstChunkMs).toBe(3000);
    expect(replay?.stats.generationMs).toBe(4000);
    expect(replay?.outcome).toBeNull();
  });

  it("reports empty stats when the journal has no usage or chunks", () => {
    const replay = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 7 });
    expect(replay?.stats).toEqual({
      tokens: null,
      timeToFirstChunkMs: null,
      generationMs: null,
      chunkCount: 0,
      outputTokensPerSecond: null,
      gatewayCacheStatus: null,
      rawResponse: null,
    });
  });

  it("reports no response when nothing streamed or committed", () => {
    const replay = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 7 });
    expect(replay?.response).toBeNull();
  });

  it("labels a request sent by an older fold as reconstructed; a current-version stamp is byte-exact", () => {
    // conversationRows' requested events carry no contractVersion stamp —
    // pre-migration requests, rebuilt under the current fold.
    const oldFold = replayLlmRequest({ rawEventJsons: conversationRows(), llmRequestOffset: 3 });
    expect(oldFold?.reconstructed).toBe(true);

    const stamped = replayLlmRequest({
      rawEventJsons: [
        ...conversationRows().slice(0, 2),
        row(
          "events.iterate.com/agent/llm-request-requested",
          {
            model: "openai/gpt-5.5",
            contractVersion: AgentProcessorContract.version,
            expiresAt: Date.parse("2026-07-11T00:01:00.000Z"),
          },
          3,
        ),
      ],
      llmRequestOffset: 3,
    });
    expect(stamped?.reconstructed).toBe(false);
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
    // at(-2): the trailing clock stamp sits after the conversation.
    expect(replay?.messages.at(-2)).toEqual({
      id: "3:2",
      role: "user",
      content: "hello",
    });
  });
});
