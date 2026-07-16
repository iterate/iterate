import { expect, test } from "vitest";
import type { StreamEvent } from "../../../os/src/itx-api.generated.ts";
import { reduceFeed, summarizeActivity, type AgentUiActivity } from "./feed.ts";

const PATH = "/agents/mobile/test";

test("a full round reduces to user → activity → assistant", () => {
  const feed = reduceFeed(PATH, [
    event(1, "events.iterate.com/agents/context-added", {
      content: "add a healthcheck",
      role: "user",
    }),
    event(2, "events.iterate.com/agent/llm-request-requested", { model: "gpt-x" }),
    event(3, "events.iterate.com/capability-host/script-execution-requested", {
      executionId: "e1",
      code: "async (itx) => { return 1 }",
    }),
    event(4, "events.iterate.com/capability-host/script-execution-completed", {
      executionId: "e1",
      result: 1,
      durationMs: 1200,
    }),
    // Activities settle only once every step is done — the completed event is
    // what closes the roll-up, not the assistant message.
    event(5, "events.iterate.com/agent/llm-request-completed", {
      llmRequestId: 2,
      result: { status: "success" },
    }),
    event(6, "events.iterate.com/agents/web-message-sent", { message: "Done." }),
  ]);
  expect(feed.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
  expect(feed).toMatchObject({ working: false, live: null });
  const activity = feed.items[1] as AgentUiActivity;
  expect(activity.steps).toMatchObject([
    { kind: "llm", status: "done" },
    { kind: "code", status: "done", code: "async (itx) => { return 1 }", success: true },
  ]);
});

test("streaming response text lands on the live activity while working", () => {
  const feed = reduceFeed(PATH, [
    event(1, "events.iterate.com/agents/context-added", { content: "go", role: "user" }),
    event(2, "events.iterate.com/agent/llm-request-requested", {}),
    event(3, "events.iterate.com/openai-ws/llm-response-chunk", {
      llmRequestId: 2,
      chunk: { type: "response.output_text.delta", delta: "const x" },
    }),
    event(4, "events.iterate.com/openai-ws/llm-response-chunk", {
      llmRequestId: 2,
      chunk: { type: "response.output_text.delta", delta: " = 1" },
    }),
  ]);
  expect(feed).toMatchObject({
    working: true,
    live: { steps: [{ kind: "llm", status: "running", responseText: "const x = 1" }] },
  });
  // The live activity is renderable as the last feed item.
  expect(feed.items.at(-1)).toBe(feed.live);
});

test("summarizes a settled activity", () => {
  const feed = reduceFeed(PATH, [
    event(1, "events.iterate.com/agent/llm-request-requested", {}),
    event(2, "events.iterate.com/capability-host/script-execution-requested", {
      executionId: "e1",
      code: "1",
    }),
    event(3, "events.iterate.com/capability-host/script-execution-completed", {
      executionId: "e1",
    }),
    event(4, "events.iterate.com/agent/llm-request-completed", {
      llmRequestId: 1,
      result: { status: "success" },
    }),
    event(5, "events.iterate.com/agents/web-message-sent", { message: "ok" }),
  ]);
  const activity = feed.items[0] as AgentUiActivity;
  expect(summarizeActivity(activity)).toMatch(/^Ran code 1× · 1 request · \d+(\.\d+)?s$/);
});

function event(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    type,
    payload,
    offset,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString(),
    path: PATH,
  };
}
