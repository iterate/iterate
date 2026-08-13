import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  ASSISTANT_MESSAGE_TYPE,
  awaitingAgentActivity,
  latestAgentTitle,
  mergeEventsByOffset,
  newMobileAgentPath,
  reduceChatEvents,
  SCRIPT_RUN_SETTLED_TYPE,
  SUMMARY_UPDATED_TYPE,
  threadContextForScriptRun,
  USER_MESSAGE_TYPE,
} from "./chat.ts";

test("a sent message stays pending until the live feed acknowledges agent activity", () => {
  const sent = userMessage(17, "/script do the work");

  expect(awaitingAgentActivity([sent], sent.offset)).toBe(true);
  expect(
    awaitingAgentActivity(
      [sent, activity(18, "events.iterate.com/agents/context-added")],
      sent.offset,
    ),
  ).toBe(true);
  expect(
    awaitingAgentActivity(
      [sent, activity(18, "events.iterate.com/capability-host/script-run-requested")],
      sent.offset,
    ),
  ).toBe(false);
  expect(
    awaitingAgentActivity(
      [sent, activity(18, "events.iterate.com/agent/llm-request-requested")],
      sent.offset,
    ),
  ).toBe(false);
});

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

test("setStatus then a held fetch: the status shows while the run is still parked, unsettled", () => {
  // Misha's sanity check: `setStatus("foo"); fetch(...)` with the fetch held
  // at the egress door — no settlement exists yet, so the fold has no upper
  // bound and the run's own freshly written status is its context.
  const context = threadContextForScriptRun(
    [
      userMessage(1, "chase the refunds"),
      activity(2, "events.iterate.com/capability-host/script-run-requested"),
      summaryUpdated(3, { title: "Refund sweep", activity: "Emailing customers about refunds" }),
    ],
    { executionId: "run-a" },
  );
  expect(context).toEqual({
    settled: false,
    status: { title: "Refund sweep", activity: "Emailing customers about refunds" },
  });
});

test("another run's settlement does not bound this run's fold", () => {
  const context = threadContextForScriptRun(
    [
      activity(2, "events.iterate.com/capability-host/script-run-requested"),
      scriptRunSettled(3, "some-other-run"),
      summaryUpdated(4, { title: "Refund sweep", activity: "Emailing customers" }),
    ],
    { executionId: "run-a" },
  );
  expect(context).toMatchObject({ settled: false, status: { title: "Refund sweep" } });
});

test("a later turn's status is not this run's context — the run's settlement bounds the fold", () => {
  const context = threadContextForScriptRun(
    [
      summaryUpdated(1, { title: "Refund sweep", activity: "Emailing customers" }),
      activity(2, "events.iterate.com/capability-host/script-run-requested"),
      scriptRunSettled(4, "run-a"),
      summaryUpdated(7, { title: "Invoice chase", activity: "Chasing invoices" }),
    ],
    { executionId: "run-a" },
  );
  expect(context).toEqual({
    settled: true,
    status: { title: "Refund sweep", activity: "Emailing customers" },
  });
});

test("status fields fold independently: an activity-only update keeps the standing title", () => {
  const context = threadContextForScriptRun(
    [
      summaryUpdated(1, { title: "Refund sweep", activity: "Starting work" }),
      summaryUpdated(3, { activity: "Emailing customers about refunds" }),
    ],
    { executionId: "run-a" },
  );
  expect(context).toMatchObject({
    status: { title: "Refund sweep", activity: "Emailing customers about refunds" },
  });
});

test("an explicit null clears a status field, matching the summary vocabulary", () => {
  const context = threadContextForScriptRun(
    [
      summaryUpdated(1, { title: "Refund sweep", activity: "Starting work" }),
      summaryUpdated(2, { title: null }),
    ],
    { executionId: "run-a" },
  );
  expect(context).toMatchObject({ status: { title: null, activity: "Starting work" } });
});

test("a null status is provisional until the run settles, immutable after", () => {
  // The caching race the settled flag exists for: an agent Promise.alls its
  // status append with the work, so the fold can run before the status
  // lands. Unsettled + no status = provisional (retry later); the same
  // statusless thread AFTER settlement = immutable null (cache forever).
  const statusless = [userMessage(1, "add a healthcheck endpoint"), assistantMessage(3, "On it.")];
  expect(threadContextForScriptRun(statusless, { executionId: "run-a" })).toEqual({
    settled: false,
    status: null,
  });
  expect(threadContextForScriptRun([], { executionId: "run-a" })).toEqual({
    settled: false,
    status: null,
  });
  expect(
    threadContextForScriptRun([...statusless, scriptRunSettled(9, "run-a")], {
      executionId: "run-a",
    }),
  ).toEqual({ settled: true, status: null });
});

test("the chat title is the standing agent-set title, renames included", () => {
  expect(latestAgentTitle([])).toBeNull();
  expect(latestAgentTitle([userMessage(1, "hi")])).toBeNull();
  expect(
    latestAgentTitle([
      summaryUpdated(1, { title: "Refund sweep", activity: "Starting work" }),
      summaryUpdated(2, { activity: "Digging in" }), // activity-only update preserves the title
      summaryUpdated(3, { title: "Refund sweep for March" }),
    ]),
  ).toBe("Refund sweep for March");
  expect(
    latestAgentTitle([
      summaryUpdated(1, { title: "Refund sweep" }),
      summaryUpdated(2, { title: null }),
    ]),
  ).toBeNull();
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
