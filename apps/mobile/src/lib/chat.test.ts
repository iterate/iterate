import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  ASSISTANT_MESSAGE_TYPE,
  lastVisibleMessageAtOrBefore,
  mergeEventsByOffset,
  newMobileAgentPath,
  reduceChatEvents,
  USER_MESSAGE_TYPE,
} from "./chat.ts";

test("reduces user and assistant messages into ordered bubbles", () => {
  const thread = reduceChatEvents([
    userMessage(1, "add a healthcheck endpoint"),
    activity(2, "events.iterate.com/agent/llm-request-requested"),
    activity(3, "events.iterate.com/capability-host/script-run-settled"),
    assistantMessage(4, "Done — /health returns 200 now."),
  ]);
  expect(thread).toMatchObject({
    working: false,
    maxOffset: 4,
    messages: [
      { role: "user", text: "add a healthcheck endpoint", offset: 1 },
      { role: "assistant", text: "Done — /health returns 200 now.", offset: 4 },
    ],
  });
});

test("working while the agent owes a reply, even through non-message activity", () => {
  const thread = reduceChatEvents([
    userMessage(1, "deploy it"),
    activity(2, "events.iterate.com/agent/llm-request-requested"),
    activity(3, "events.iterate.com/agent/token-usage-reported"),
  ]);
  expect(thread).toMatchObject({ working: true, maxOffset: 3 });
});

test("a follow-up user message flips working back on", () => {
  const thread = reduceChatEvents([
    userMessage(1, "hi"),
    assistantMessage(2, "hello!"),
    userMessage(3, "now do something slow"),
  ]);
  expect(thread).toMatchObject({ working: true });
});

test("empty thread is not working", () => {
  expect(reduceChatEvents([])).toMatchObject({ working: false, maxOffset: 0, messages: [] });
});

test("merge dedupes overlapping offsets and keeps order", () => {
  const initial = [userMessage(1, "a"), assistantMessage(2, "b")];
  const liveBatch = [assistantMessage(2, "b"), userMessage(3, "c")];
  const merged = mergeEventsByOffset(initial, liveBatch);
  expect(merged.map((e) => e.offset)).toEqual([1, 2, 3]);
});

test("last visible message before the offset wins over earlier ones", () => {
  const context = lastVisibleMessageAtOrBefore(
    [
      userMessage(1, "add a healthcheck endpoint"),
      assistantMessage(3, "On it — writing the handler now."),
      activity(5, "events.iterate.com/capability-host/script-run-requested"),
      assistantMessage(8, "Done — /health returns 200 now."),
    ],
    5,
  );
  expect(context).toMatchObject({ role: "assistant", text: "On it — writing the handler now." });
});

test("only messages after the offset means no context", () => {
  const context = lastVisibleMessageAtOrBefore([assistantMessage(9, "all done")], 5);
  expect(context).toEqual(null);
});

test("empty thread has no context", () => {
  expect(lastVisibleMessageAtOrBefore([], 5)).toEqual(null);
});

test("a message exactly at the offset counts", () => {
  const context = lastVisibleMessageAtOrBefore(
    [userMessage(2, "old ask"), userMessage(5, "send the invoice email")],
    5,
  );
  expect(context).toMatchObject({ role: "user", text: "send the invoice email" });
});

test("a user message can be the context too", () => {
  const context = lastVisibleMessageAtOrBefore(
    [assistantMessage(1, "what should I do?"), userMessage(4, "email the report to finance")],
    10,
  );
  expect(context).toMatchObject({ role: "user", text: "email the report to finance" });
});

test("context text collapses to one line and blank messages are skipped", () => {
  const context = lastVisibleMessageAtOrBefore(
    [userMessage(1, "fix the deploy\n\nthen tell me"), assistantMessage(2, "  \n  ")],
    5,
  );
  expect(context).toMatchObject({ role: "user", text: "fix the deploy then tell me" });
});

test("mobile agent paths follow the web slug convention under the mobile channel", () => {
  expect(newMobileAgentPath(new Date("2026-07-07T12:34:56.789Z"))).toEqual(
    "/agents/mobile/2026-07-07t12-34-56-789z",
  );
});

function userMessage(offset: number, content: string): StreamEvent {
  return {
    type: USER_MESSAGE_TYPE,
    payload: { content, role: "user" },
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/agents/mobile/test",
  };
}

function assistantMessage(offset: number, message: string): StreamEvent {
  return {
    type: ASSISTANT_MESSAGE_TYPE,
    payload: { message },
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/agents/mobile/test",
  };
}

function activity(offset: number, type: string): StreamEvent {
  return {
    type,
    payload: {},
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/agents/mobile/test",
  };
}
