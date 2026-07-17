import { describe, expect, test } from "vitest";
import type { StreamEvent } from "../itx-api.generated.ts";
import { createAgentFeedModel } from "./agent-feed-model.ts";

let nextOffset = 1;
const event = (type: string, payload: Record<string, unknown>): StreamEvent => ({
  type,
  payload,
  path: "/agents/test",
  offset: nextOffset++,
  createdAt: new Date(1700000000000 + nextOffset * 1000).toISOString(),
});

describe("createAgentFeedModel", () => {
  test("folds a chat round into user, activity, and assistant items", () => {
    const model = createAgentFeedModel();

    const changed = model.applyEvents([
      event("events.iterate.com/agents/context-added", {
        role: "user",
        content: "hello agent",
        actor: { type: "user", origin: "web" },
        llmRequestPolicy: { behaviour: "after-current-request" },
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
      event("events.iterate.com/agent/llm-request-completed", {
        llmRequestOffset: 2,
        durationMs: 10,
        result: { status: "success" },
      }),
      event("events.iterate.com/agents/web-message-sent", { message: "hi human" }),
    ]);

    // LLM completion settles the live activity; the assistant reply follows.
    snapshot = model.snapshot();
    expect(snapshot.live).toBeNull();
    expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
    expect(snapshot.items[2]).toMatchObject({ kind: "assistant", text: "hi human" });
  });

  test("accumulates streamed response deltas on the live step", () => {
    const model = createAgentFeedModel();
    const requested = event("events.iterate.com/agent/llm-request-requested", {});
    const llmRequestOffset = requested.offset;
    model.applyEvents([
      requested,
      event("events.iterate.com/agent/llm-response-chunk", {
        llmRequestOffset,
        chunk: { response: "par" },
      }),
      event("events.iterate.com/agent/llm-response-chunk", {
        llmRequestOffset,
        chunk: { response: "tial" },
      }),
    ]);

    const live = model.snapshot().live;
    expect(live?.steps[0]).toMatchObject({ kind: "llm", responseText: "partial" });
  });

  test("ignores replayed events at or below the folded offset", () => {
    const model = createAgentFeedModel();
    const first = event("events.iterate.com/agents/context-added", {
      role: "user",
      content: "one",
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
    model.applyEvents([first]);
    expect(model.snapshot().lastOffset).toBe(first.offset);

    // A reconnect replays the same event; the fold must not duplicate it.
    expect(model.applyEvents([first])).toBe(false);
    expect(model.snapshot().items).toHaveLength(1);
  });
});
