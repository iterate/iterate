import { describe, expect, it } from "vitest";
import { runWorkersAiAttempt } from "./workers-ai-transport.ts";

describe("runWorkersAiAttempt", () => {
  it("cancels the response stream on deadline so no chunk lands after the failure", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"hel"}\n\n'));
        // …and never closes: a wedged upstream mid-stream.
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunks: unknown[] = [];

    await expect(
      runWorkersAiAttempt({
        ai: { run: async () => body },
        deadlineMs: 50,
        messages: [{ role: "user", content: "hi" }],
        model: "test-model",
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
      }),
    ).rejects.toThrow(/timed out/);

    // The reader was cancelled BEFORE the error settled the attempt: the
    // source stops producing, so nothing can journal a chunk after the
    // caller records the timeout failure.
    expect(cancelled).toBe(true);
    expect(chunks).toEqual([{ response: "hel" }]);
  });

  it("caps the dial itself, not just the drain", async () => {
    await expect(
      runWorkersAiAttempt({
        ai: { run: () => new Promise(() => {}) },
        deadlineMs: 50,
        messages: [{ role: "user", content: "hi" }],
        model: "test-model",
        onChunk: async () => {},
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("pins medium reasoning effort (plus streamed usage) for OpenAI reasoning models only", async () => {
    const bodies: Record<string, unknown>[] = [];
    const ai = {
      run: async (_model: string, body: unknown) => {
        bodies.push(body as Record<string, unknown>);
        return { response: "ok" };
      },
    };
    for (const model of ["openai/gpt-5.5", "@cf/moonshotai/kimi-k2.7-code"]) {
      await runWorkersAiAttempt({
        ai,
        deadlineMs: 1_000,
        messages: [{ role: "user", content: "hi" }],
        model,
        onChunk: async () => {},
      });
    }
    expect(bodies[0]).toMatchObject({
      reasoning_effort: "medium",
      stream_options: { include_usage: true },
    });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).not.toHaveProperty("stream_options");
  });

  it("drains OpenAI chat-completion chunks: delta text, empty final delta, usage-only chunk", async () => {
    // The gpt-5.5 SSE shape on Workers AI: chat.completion.chunk frames with
    // choices[].delta.content, a finish_reason frame with an empty delta, and
    // (with include_usage) a trailing usage frame whose choices array is EMPTY.
    const encoder = new TextEncoder();
    const frames = [
      { choices: [{ delta: { content: "hel", role: "assistant" }, index: 0 }] },
      { choices: [{ delta: { content: "lo" }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const completion = await runWorkersAiAttempt({
      ai: { run: async () => body },
      deadlineMs: 1_000,
      messages: [{ role: "user", content: "hi" }],
      model: "openai/gpt-5.5",
      onChunk: async () => {},
    });

    expect(completion.text).toBe("hello");
    expect(completion.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    });
  });
});
