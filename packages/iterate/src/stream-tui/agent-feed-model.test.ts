import { describe, expect, test } from "vitest";
import type { StreamEvent } from "../../../../apps/os/src/types.ts";
import { createAgentFeedModel } from "./agent-feed-model.ts";

let nextOffset = 1;
const event = (type: string, payload: Record<string, unknown>): StreamEvent => ({
  type,
  payload,
  offset: nextOffset++,
  createdAt: new Date(1700000000000 + nextOffset * 1000).toISOString(),
});

describe("createAgentFeedModel", () => {
  test("folds a chat round into user, activity, and assistant items", () => {
    const model = createAgentFeedModel();

    const changed = model.applyEvents([
      event("events.iterate.com/agents/user-message-received", {
        content: "hello agent",
        origin: "web",
      }),
      event("events.iterate.com/agent/llm-request-requested", { model: "gpt-test" }),
    ]);
    expect(changed).toBe(true);

    // The user message settles immediately; the LLM round is still live.
    let snapshot = model.snapshot();
    expect(snapshot.items).toMatchObject([{ kind: "user", text: "hello agent" }]);
    expect(snapshot.live).toMatchObject({
      kind: "activity",
      status: "running",
      steps: [{ kind: "llm", status: "running" }],
    });

    model.applyEvents([
      event("events.iterate.com/agents/web-message-sent", { message: "hi human" }),
    ]);

    // The assistant reply settles the live activity, then itself.
    snapshot = model.snapshot();
    expect(snapshot.live).toBeNull();
    expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
    expect(snapshot.items[2]).toMatchObject({ kind: "assistant", text: "hi human" });
  });

  test("accumulates streamed response deltas on the live step", () => {
    const model = createAgentFeedModel();
    const requested = event("events.iterate.com/agent/llm-request-requested", {});
    const llmRequestId = requested.offset;
    model.applyEvents([
      requested,
      event("events.iterate.com/openai-ws/llm-response-chunk", {
        llmRequestId,
        chunk: { type: "response.output_text.delta", delta: "par" },
      }),
      event("events.iterate.com/openai-ws/llm-response-chunk", {
        llmRequestId,
        chunk: { type: "response.output_text.delta", delta: "tial" },
      }),
    ]);

    const live = model.snapshot().live;
    expect(live?.steps[0]).toMatchObject({ kind: "llm", responseText: "partial" });
  });

  test("ignores replayed events at or below the folded offset", () => {
    const model = createAgentFeedModel();
    const first = event("events.iterate.com/agents/user-message-received", { content: "one" });
    model.applyEvents([first]);
    expect(model.snapshot().lastOffset).toBe(first.offset);

    // A reconnect replays the same event; the fold must not duplicate it.
    expect(model.applyEvents([first])).toBe(false);
    expect(model.snapshot().items).toHaveLength(1);
  });
});
