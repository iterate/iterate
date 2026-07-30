import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  ASSISTANT_MESSAGE_TYPE,
  mergeEventsByOffset,
  newMobileAgentPath,
  reduceChatEvents,
  SCRIPT_RUN_SETTLED_TYPE,
  SUMMARY_UPDATED_TYPE,
  threadContextForScriptRun,
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

test("a status the script sets after its run request still counts as this run's context", () => {
  const context = threadContextForScriptRun(
    [
      userMessage(1, "chase the refunds"),
      activity(2, "events.iterate.com/capability-host/script-run-requested"),
      summaryUpdated(3, { title: "Refund sweep", activity: "Emailing customers about refunds" }),
      scriptRunSettled(6, "run-a"),
    ],
    { scriptRunRequestedEventOffset: 2, executionId: "run-a" },
  );
  expect(context).toEqual({
    kind: "status",
    title: "Refund sweep",
    activity: "Emailing customers about refunds",
  });
});

test("a later turn's status is not this run's context — the run's settlement bounds the fold", () => {
  const context = threadContextForScriptRun(
    [
      summaryUpdated(1, { title: "Refund sweep", activity: "Emailing customers" }),
      activity(2, "events.iterate.com/capability-host/script-run-requested"),
      scriptRunSettled(4, "run-a"),
      summaryUpdated(7, { title: "Invoice chase", activity: "Chasing invoices" }),
    ],
    { scriptRunRequestedEventOffset: 2, executionId: "run-a" },
  );
  expect(context).toEqual({
    kind: "status",
    title: "Refund sweep",
    activity: "Emailing customers",
  });
});

test("status fields fold independently: an activity-only update keeps the standing title", () => {
  const context = threadContextForScriptRun(
    [
      summaryUpdated(1, { title: "Refund sweep", activity: "Starting work" }),
      summaryUpdated(3, { activity: "Emailing customers about refunds" }),
    ],
    { scriptRunRequestedEventOffset: 2, executionId: "run-a" },
  );
  expect(context).toEqual({
    kind: "status",
    title: "Refund sweep",
    activity: "Emailing customers about refunds",
  });
});

test("an explicit null clears a status field, matching the summary vocabulary", () => {
  const context = threadContextForScriptRun(
    [
      summaryUpdated(1, { title: "Refund sweep", activity: "Starting work" }),
      summaryUpdated(2, { title: null }),
    ],
    { scriptRunRequestedEventOffset: 3, executionId: "run-a" },
  );
  expect(context).toEqual({ kind: "status", title: null, activity: "Starting work" });
});

test("an unsettled run's freshly written status is still its own", () => {
  const context = threadContextForScriptRun(
    [
      activity(2, "events.iterate.com/capability-host/script-run-requested"),
      summaryUpdated(3, { title: "Refund sweep", activity: "Emailing customers" }),
      scriptRunSettled(4, "some-other-run"),
    ],
    { scriptRunRequestedEventOffset: 2, executionId: "run-a" },
  );
  expect(context).toMatchObject({ kind: "status", title: "Refund sweep" });
});

test("statusless thread falls back to the last visible message at or before the run request", () => {
  const context = threadContextForScriptRun(
    [
      userMessage(1, "add a healthcheck endpoint"),
      assistantMessage(3, "On it — writing the handler now."),
      assistantMessage(8, "Done — /health returns 200 now."),
    ],
    { scriptRunRequestedEventOffset: 5, executionId: "run-a" },
  );
  expect(context).toEqual({
    kind: "message",
    role: "assistant",
    text: "On it — writing the handler now.",
  });
});

test("fallback: a message exactly at the run-request offset counts, user role included", () => {
  const context = threadContextForScriptRun(
    [userMessage(2, "old ask"), userMessage(5, "send the invoice email")],
    { scriptRunRequestedEventOffset: 5, executionId: "run-a" },
  );
  expect(context).toEqual({ kind: "message", role: "user", text: "send the invoice email" });
});

test("fallback text collapses to one line and blank messages are skipped", () => {
  const context = threadContextForScriptRun(
    [userMessage(1, "fix the deploy\n\nthen tell me"), assistantMessage(2, "  \n  ")],
    { scriptRunRequestedEventOffset: 5, executionId: "run-a" },
  );
  expect(context).toEqual({ kind: "message", role: "user", text: "fix the deploy then tell me" });
});

test("no status and only messages after the run request means no context; empty thread too", () => {
  expect(
    threadContextForScriptRun([assistantMessage(9, "all done")], {
      scriptRunRequestedEventOffset: 5,
      executionId: "run-a",
    }),
  ).toEqual(null);
  expect(
    threadContextForScriptRun([], { scriptRunRequestedEventOffset: 5, executionId: "run-a" }),
  ).toEqual(null);
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

function summaryUpdated(
  offset: number,
  payload: { title?: string | null; activity?: string | null },
): StreamEvent {
  return {
    type: SUMMARY_UPDATED_TYPE,
    payload,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/agents/mobile/test",
  };
}

function scriptRunSettled(offset: number, executionId: string): StreamEvent {
  return {
    type: SCRIPT_RUN_SETTLED_TYPE,
    payload: { executionId, settlement: { outcome: "fulfilled" } },
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
