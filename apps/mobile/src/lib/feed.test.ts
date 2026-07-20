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
    event(3, "events.iterate.com/capability-host/script-run-requested", {
      executionId: "e1",
      code: "async (itx) => { return 1 }",
      expiresAt: Date.UTC(2026, 0, 1, 0, 1),
    }),
    event(4, "events.iterate.com/capability-host/script-run-settled", {
      executionId: "e1",
      settlement: { status: "succeeded", result: 1 },
    }),
    // Activities settle only once every step is done — the settled event is
    // what closes the roll-up, not the assistant message.
    event(5, "events.iterate.com/agent/llm-request-settled", {
      requestOffset: 2,
      result: { status: "succeeded", text: "Done." },
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
    event(3, "events.iterate.com/agent/llm-response-chunk", {
      llmRequestOffset: 2,
      chunk: { choices: [{ delta: { content: "const x" } }] },
    }),
    event(4, "events.iterate.com/agent/llm-response-chunk", {
      llmRequestOffset: 2,
      chunk: { choices: [{ delta: { content: " = 1" } }] },
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
    event(2, "events.iterate.com/capability-host/script-run-requested", {
      executionId: "e1",
      code: "1",
      expiresAt: Date.UTC(2026, 0, 1, 0, 1),
    }),
    event(3, "events.iterate.com/capability-host/script-run-settled", {
      executionId: "e1",
      settlement: { status: "succeeded" },
    }),
    event(4, "events.iterate.com/agent/llm-request-settled", {
      requestOffset: 1,
      result: { status: "succeeded", text: "ok" },
    }),
    event(5, "events.iterate.com/agents/web-message-sent", { message: "ok" }),
  ]);
  const activity = feed.items[0] as AgentUiActivity;
  expect(summarizeActivity(activity)).toBe("Ran code 1× · 1 request · 4 s");
});

test("a late durable script result replaces its provisional activity", () => {
  const feed = reduceFeed(PATH, [
    event(1, "events.iterate.com/agents/context-added", { content: "go", role: "user" }),
    event(2, "events.iterate.com/agent/llm-request-requested", {}),
    event(3, "events.iterate.com/agent/llm-request-settled", {
      requestOffset: 2,
      result: { status: "succeeded", text: "Done." },
    }),
    event(4, "events.iterate.com/capability-host/script-run-requested", {
      executionId: "slow-script",
      code: "async () => 'done'",
      expiresAt: Date.UTC(2026, 0, 1, 0, 0, 5),
    }),
    // The visible reply lands at the script deadline. The reducer closes the
    // activity with an explicit inferred outcome so the UI cannot spin forever.
    event(5, "events.iterate.com/agents/web-message-sent", { message: "Done." }),
    // The real stream can receive the durable settlement later (an approval
    // held the script in production). This correction carries the same activity id.
    event(6, "events.iterate.com/capability-host/script-run-settled", {
      executionId: "slow-script",
      settlement: { status: "succeeded", result: "done" },
    }),
  ]);

  expect(feed.items.map((item) => item.id)).toEqual(["user-1", "activity-2", "assistant-5"]);
  expect(feed.items[1]).toMatchObject({
    kind: "activity",
    steps: [
      { kind: "llm", status: "done" },
      { kind: "code", success: true },
    ],
  });
});

test("a reply that lands before a durable script's settlement still ends not-working", () => {
  const feed = reduceFeed(PATH, [
    event(1, "events.iterate.com/agents/context-added", { content: "go", role: "user" }),
    event(2, "events.iterate.com/agent/llm-request-requested", {}),
    event(3, "events.iterate.com/agent/llm-request-settled", {
      requestOffset: 2,
      result: { status: "succeeded", text: "Done." },
    }),
    event(4, "events.iterate.com/capability-host/script-run-requested", {
      executionId: "script",
      code: "async () => 'done'",
      expiresAt: Date.UTC(2026, 0, 1, 0, 2),
    }),
    // The visible message can arrive while a durable script is still pending
    // (well before its deadline); the trailing settlement must close the feed.
    event(5, "events.iterate.com/agents/web-message-sent", { message: "Done." }),
    event(6, "events.iterate.com/capability-host/script-run-settled", {
      executionId: "script",
      settlement: { status: "succeeded", result: "done" },
    }),
  ]);

  expect(feed.items.map((item) => item.id)).toEqual(["user-1", "activity-2", "assistant-5"]);
  expect(feed).toMatchObject({ working: false, live: null });
  expect(feed.items[1]).toMatchObject({ kind: "activity", status: "done" });
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
