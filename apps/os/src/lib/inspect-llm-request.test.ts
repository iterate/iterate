import { describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamEventReadInput } from "iterate/processors";
import { inspectLlmRequest } from "./inspect-llm-request.ts";

function event(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return { offset, type, payload, path: "/agents/test", createdAt: new Date(0).toISOString() };
}

function reader(events: StreamEvent[]) {
  return vi.fn(async (input: StreamEventReadInput) => ({
    streamId: "test-stream",
    streamMaxOffset: events.at(-1)?.offset ?? 0,
    events: events
      .filter(
        (event) =>
          event.offset > (input.afterOffset ?? 0) &&
          event.offset < (input.beforeOffset ?? Infinity) &&
          (!input.eventTypes || input.eventTypes.includes(event.type)),
      )
      .slice(0, input.limit),
  }));
}

describe("bounded server LLM inspection", () => {
  it("pages the prompt prefix and response lifecycle separately", async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      event(index + 1, "events.iterate.com/agents/context-added", {
        role: "user",
        content: `message ${index}`,
      }),
    );
    events.push(
      event(502, "events.iterate.com/agent/llm-request-requested", {
        model: "openai/gpt-5.5",
        expiresAt: 1000,
      }),
    );
    events.push(
      event(503, "events.iterate.com/agents/context-added", {
        role: "assistant",
        content: "done",
        llmRequestOffset: 502,
      }),
    );
    events.push(
      event(504, "events.iterate.com/agent/llm-request-settled", {
        requestOffset: 502,
        result: { status: "succeeded" },
      }),
    );
    const read = reader(events);
    const result = await inspectLlmRequest(read, 502);
    expect(result?.response?.text).toBe("done");
    expect(result?.outcome?.status).toBe("success");
    expect(read.mock.calls.map(([input]) => input.afterOffset)).toEqual([
      Number.MAX_SAFE_INTEGER,
      0,
      250,
      500,
      502,
    ]);
    expect(
      read.mock.calls
        .slice(1, 4)
        .every(([input]) => input.beforeOffset === 503 && input.includeEphemeral === false),
    ).toBe(true);
    expect(read.mock.calls.at(-1)?.[0].eventTypes).not.toContain(
      "events.iterate.com/agent/llm-request-requested",
    );
  });

  it("stops a large history with an explicit inspection-window error", async () => {
    const events = Array.from({ length: 10_002 }, (_, index) =>
      event(index + 1, "events.iterate.com/agents/context-added", {
        role: "user",
        content: "hello",
      }),
    );
    const read = reader(events);
    await expect(inspectLlmRequest(read, 10_002)).rejects.toThrow("inspection window exceeded");
    expect(read).toHaveBeenCalledTimes(42);
  });

  it("rejects a changed stream lifetime during pagination", async () => {
    const read = reader([
      event(1, "events.iterate.com/agents/context-added", { content: "hello" }),
    ]);
    read.mockResolvedValueOnce({ streamId: "old", streamMaxOffset: 1, events: [] });
    await expect(inspectLlmRequest(read, 1)).rejects.toThrow("stream was recreated");
  });
});
