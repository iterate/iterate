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
});
