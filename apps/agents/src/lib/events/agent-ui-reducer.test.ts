// Reducer coverage for the browser-side agent UI fold: a full simulated
// turn — user message, LLM request with streamed thinking + response deltas,
// the context's script run, completion, assistant reply — must reduce into the
// chat items and live active-work tail the agent feed renders.
import { expect, test } from "vitest";
import { RUN_DEADLINE_MS, type RunSettlement } from "iterate/stream/run";
import { appendText } from "../chunked-text.ts";
import type { StreamEvent } from "./stream-event.ts";
import {
  deriveAgentUiLiveStatus,
  initialAgentUiState,
  reduceAgentUi,
  settleAgentUiAtIdleBoundary,
  summarizeAgentUiActivity,
  type AgentUiActivity,
  type AgentUiItem,
} from "./agent-ui-reducer.ts";

test("streams thinking and response deltas into the live llm step", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "count the inputs",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 10,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 0,
        responseDelta: "",
        thinkingDelta: "Reading the stream",
      },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 1,
        responseDelta: "const n = await ",
        thinkingDelta: "",
      },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 2,
        responseDelta: "stream.count();",
        thinkingDelta: "",
      },
    },
  ]);

  expect(state.items).toHaveLength(1);
  expect(state.items[0]).toMatchObject({ kind: "user", text: "count the inputs" });
  expect(state.live).not.toBeNull();
  expect(state.live?.steps).toHaveLength(1);
  expect(state.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "running",
    model: "gpt-test",
    thinkingText: appendText("", "Reading the stream"),
    responseText: appendText(appendText("", "const n = await "), "stream.count();"),
  });
});

test("a window that adds thinking and text at once streams both into the live llm step", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "count the inputs",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 10,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 0,
        responseDelta: "const n = await ",
        thinkingDelta: "Reading the stream",
      },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 1,
        responseDelta: "stream.count();",
        thinkingDelta: "",
      },
    },
  ]);

  expect(state.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "running",
    thinkingText: appendText("", "Reading the stream"),
    responseText: appendText(appendText("", "const n = await "), "stream.count();"),
  });
});

test("committed assistant text extends streamed windows when the tail flush was lost", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "go" },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 10,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 0,
        responseDelta: "The lighthouse",
        thinkingDelta: "",
      },
    },
    // The tail flush was swallowed; the committed assistant item carries
    // the full text the windows never received.
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "assistant", content: "The lighthouse keeper", llmRequestOffset: 10 },
    },
  ]);

  expect(state.live?.steps[0]).toMatchObject({
    kind: "llm",
    responseText: "The lighthouse keeper",
  });
});

test("a cancelled settle's partialText extends streamed windows with the unflushed tail", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "go" },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 10,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 10,
        sequence: 0,
        responseDelta: "The lighthouse",
        thinkingDelta: "",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 10,
        result: {
          status: "cancelled",
          reason: "interrupted-by-user-input",
          // The interrupt stranded " keeper" in the coalescing buffer — it
          // never flushed, but the settled fact carries the full partial.
          partialText: "The lighthouse keeper",
        },
      },
    },
  ]);

  const step =
    state.live?.steps[0] ??
    state.items.flatMap((item) => (item.kind === "activity" ? item.steps : []))[0];
  expect(step).toMatchObject({
    kind: "llm",
    outcome: "cancelled",
    responseText: "The lighthouse keeper",
  });
});

test("settles the activity into items when all work completes", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "hi" },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    runRequested(3, "await stream.read()"),
    runSettled(3, { status: "succeeded", result: 12 }),
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 5,
        durationMs: 2100,
        result: {
          status: "succeeded",
          text: "There are 12 inputs.",
          usage: { inputTokens: 9400, outputTokens: 300 },
        },
      },
    },
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "There are 12 inputs." },
    },
  ]);

  expect(state.live).toBeNull();
  expect(state.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
  const activity = state.items[1];
  if (activity?.kind !== "activity") throw new Error("expected activity item");
  expect(activity).toMatchObject({ status: "done" });
  expect(activity.steps).toHaveLength(2);
  expect(activity.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    inputTokens: 9400,
    outputTokens: 300,
    durationMs: 2100,
    outcome: "completed",
  });
  expect(activity.steps[1]).toMatchObject({
    kind: "code",
    requestOffset: 3,
    status: "done",
    code: "await stream.read()",
    result: 12,
    success: true,
    durationMs: 1000,
  });
});

test("a run the context's restart interrupted shows the platform's error, not an invalid settlement", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    runRequested(2, "await stream.read()"),
    runSettled(2, {
      status: "failed",
      error: "the context restarted before the script finished",
      failureKind: "interrupted",
    }),
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: { requestOffset: 5, durationMs: 100, result: { status: "succeeded", text: "ok" } },
    },
    { type: "events.iterate.com/agent/web-message-sent", payload: { message: "ok" } },
  ]);
  const activity = state.items.find((item) => item.kind === "activity");
  if (activity?.kind !== "activity") throw new Error("expected activity item");
  expect(activity.steps[1]).toMatchObject({
    kind: "code",
    success: false,
    errorMessage: "the context restarted before the script finished",
  });
});

test("stamps the summary activity onto the running code step as it lands", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    runRequested(2),
    {
      type: "events.iterate.com/agent/summary-updated",
      payload: { title: "FirstFT roundup", activity: "Searching the five most recent emails" },
    },
  ]);

  expect(state).toMatchObject({ summaryActivity: "Searching the five most recent emails" });
  expect(state.live?.steps.at(-1)).toMatchObject({
    kind: "code",
    status: "running",
    activitySummary: "Searching the five most recent emails",
  });
});

test("a round that never updates the summary inherits the stream status as of that round", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    runRequested(2, "await round1()"),
    {
      type: "events.iterate.com/agent/summary-updated",
      payload: { activity: "Running script 1 of 2" },
    },
    runSettled(2, { status: "succeeded", result: 1 }),
    runRequested(5, "await round2()"),
    runSettled(5, { status: "succeeded", result: 2 }),
    runRequested(7, "await round3()"),
  ]);

  const codeSteps = state.live?.steps.filter((step) => step.kind === "code");
  expect(codeSteps).toMatchObject([
    { requestOffset: 2, activitySummary: "Running script 1 of 2" },
    // The second script appended no summary — the round's status is whatever
    // the stream's summary said as of that round.
    { requestOffset: 5, activitySummary: "Running script 1 of 2" },
    // The third inherits from BIRTH, so the live header carries the status
    // too — not only settled rounds.
    { requestOffset: 7, status: "running", activitySummary: "Running script 1 of 2" },
  ]);
});

test("llm-request-settled succeeded closes the step", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "hi" },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 5,
        durationMs: 2100,
        result: {
          status: "succeeded",
          text: "done",
          usage: { inputTokens: 9400, outputTokens: 300 },
        },
      },
    },
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "There are 12 inputs." },
    },
  ]);

  expect(state.live).toBeNull();
  expect(state.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
  const activity = state.items[1];
  if (activity?.kind !== "activity") throw new Error("expected activity item");
  expect(activity.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "completed",
    durationMs: 2100,
    inputTokens: 9400,
    outputTokens: 300,
  });
});

test("llm-request-settled failed and cancelled map to step outcomes", () => {
  const failed = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 5,
        result: { status: "failed", errorMessage: "model exploded" },
      },
    },
  ]);
  expect(failed.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "failed",
    errorMessage: "model exploded",
  });

  const interrupted = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 5,
        result: {
          status: "cancelled",
          reason: "interrupted-by-user-input",
          partialText: "Hel",
        },
      },
    },
  ]);
  expect(interrupted.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "cancelled",
    cancelReason: "interrupted-by-user-input",
  });

  const expired = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: { requestOffset: 5, result: { status: "cancelled", reason: "expired" } },
    },
  ]);
  expect(expired.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "cancelled",
    cancelReason: "expired",
  });
});

test("keeps running script source, start time and deadline in the live activity", () => {
  const state = reduceAll([runRequested(1, "await itx.repo.readFile({ path: 'README.md' })")]);

  expect(state.items).toHaveLength(0);
  expect(state.live?.steps).toHaveLength(1);
  const startedAtMs = Date.parse("2026-06-11T00:00:01.000Z");
  expect(state.live?.steps[0]).toMatchObject({
    kind: "code",
    id: "code-1",
    requestOffset: 1,
    status: "running",
    code: "await itx.repo.readFile({ path: 'README.md' })",
    startedAtMs,
    // the platform settles a run still going then `deadline` — the feed counts down to it
    deadlineAtMs: startedAtMs + RUN_DEADLINE_MS,
  });
});

test("does not guess which script a settlement without its request's offset belongs to", () => {
  const state = reduceAll([
    runRequested(1, "async () => mutate()"),
    {
      type: "events.iterate.com/itx/run-settled",
      payload: { settlement: { status: "succeeded", result: "wrong target" } },
    },
  ]);

  expect(state.live?.steps).toMatchObject([{ kind: "code", requestOffset: 1, status: "running" }]);
});

test("does not derive agent state or durations from a malformed event timestamp", () => {
  const state = reduceAll([
    runRequested(1, "async () => mutate()"),
    {
      ...runSettled(1, { status: "succeeded", result: "must be ignored" }),
      createdAt: "not-a-timestamp",
    },
  ]);

  expect(state.live?.steps).toMatchObject([{ kind: "code", requestOffset: 1, status: "running" }]);
});

test("a run request RunRequested refuses (no code) is no step", () => {
  const state = reduceAll([
    { type: "events.iterate.com/itx/run-requested", payload: { code: "" } },
  ]);

  expect(state).toMatchObject({ items: [] });
  expect(state.live).toBeNull();
});

test("keeps the live indicator while a running script emits chat messages", () => {
  const countdownEvents: Array<Partial<StreamEvent> & { type: string; payload?: unknown }> = [
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 10,
      payload: { model: "gpt-test", requestId: "llm-request:gen-0" },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "assistant",
        llmRequestOffset: 10,
        content:
          "<codemode>\nawait itx.chat.sendMessage('20');\nawait new Promise((resolve) => setTimeout(resolve, 1000));\n</codemode>",
      },
    },
    runRequested(
      3,
      "async (itx) => {\n  await itx.chat.sendMessage('20');\n  await new Promise((resolve) => setTimeout(resolve, 1000));\n}",
      2,
    ),
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: { requestOffset: 10, result: { status: "succeeded", text: "20" } },
    },
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "20" },
    },
  ];
  const running = reduceAll(countdownEvents);

  expect(running).toMatchObject({ items: [] });
  expect(running.deferredAssistantMessages).toMatchObject([{ kind: "assistant", text: "20" }]);
  expect(running).toMatchObject({ queuedUserMessages: [] });
  expect(running.live?.steps.at(-1)).toMatchObject({
    kind: "code",
    requestOffset: 3,
    status: "running",
  });

  const completed = settleAtIdle(reduceAll([...countdownEvents, runSettled(3)]), 20);

  expect(completed.live).toBeNull();
  expect(completed.items.map((item) => item.kind)).toEqual(["activity", "assistant"]);
  expect(completed.items[0]).toMatchObject({
    kind: "activity",
    status: "done",
    steps: [
      { kind: "llm", status: "done" },
      { kind: "code", requestOffset: 3, status: "done" },
    ],
  });
});

// Regression: prod stream agents/web/2026-08-07t15-50-03-269z. The script
// sent the visible reply (deferred while its code step ran), settled, and
// the stream went quiet — the journal fold alone must emit the reply, not
// hold it hostage until an idle boundary or some future event arrives.
test("flushes a script-sent reply when its script settles and nothing else is running", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "ok what model are you using?",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 10,
      payload: { model: "xai/grok-4.5" },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "assistant",
        llmRequestOffset: 10,
        content: "<codemode>\nawait itx.chat.sendMessage('grok');\n</codemode>",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: { requestOffset: 10, result: { status: "succeeded", text: "…" } },
    },
    runRequested(5, "async (itx) => {\n  await itx.chat.sendMessage('grok');\n}", 3),
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "I'm using **xai/grok-4.5**." },
    },
    runSettled(5),
  ]);

  expect(state.live).toBeNull();
  expect(state).toMatchObject({ deferredAssistantMessages: [] });
  expect(state.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
  expect(state.items.at(-1)).toMatchObject({
    kind: "assistant",
    text: "I'm using **xai/grok-4.5**.",
  });
  expect(state.items[1]).toMatchObject({
    kind: "activity",
    status: "done",
    steps: [
      { kind: "llm", status: "done", outcome: "completed" },
      { kind: "code", requestOffset: 5, status: "done", success: true },
    ],
  });
});

test("stream wakes are not chat rows", () => {
  const state = reduceAll([
    { type: "events.iterate.com/itx/created" },
    { type: "events.iterate.com/itx/woken" },
    { type: "events.iterate.com/itx/woken" },
  ]);

  expect(state).toMatchObject({ items: [] });
});

test("a durable rebuild recovers the interrupted partial from the settled fact", () => {
  // Chunks are ephemeral: a refold from the journal has none, so the step's
  // streamed text must come from settled.result.partialText.
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 5,
      payload: { model: "gpt-test", expiresAt: Date.parse("2026-06-11T00:10:00.000Z") },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 5,
        result: {
          status: "cancelled",
          reason: "interrupted-by-user-input",
          partialText: "Let me check your cal",
        },
      },
    },
  ]);
  expect(state.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "cancelled",
    cancelReason: "interrupted-by-user-input",
    responseText: "Let me check your cal",
  });
});

test("shows stream pause and resume events in the agent feed", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/itx/paused",
      payload: { reason: "Agent circuit breaker tripped." },
    },
    {
      type: "events.iterate.com/itx/resumed",
      payload: { reason: "Operator resumed the agent." },
    },
  ]);

  expect(state).toMatchObject({
    items: [
      {
        kind: "stream-paused",
        id: "stream-paused-1",
        text: "Agent paused",
        reason: "Agent circuit breaker tripped.",
        timestampMs: Date.parse("2026-06-11T00:00:01.000Z"),
      },
      {
        kind: "stream-resumed",
        id: "stream-resumed-2",
        text: "Agent resumed",
        reason: "Operator resumed the agent.",
        timestampMs: Date.parse("2026-06-11T00:00:02.000Z"),
      },
    ],
  });
});

test("shows agent pause and resume (the turn-loop breaker) as the same marker rows", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/paused",
      payload: {
        reason: "autonomous turn limit reached (100 consecutive turns without external input)",
      },
    },
    {
      type: "events.iterate.com/agent/resumed",
      payload: { reason: "external input" },
    },
  ]);

  expect(state).toMatchObject({
    items: [
      {
        kind: "stream-paused",
        id: "stream-paused-1",
        text: "Agent paused",
        reason: "autonomous turn limit reached (100 consecutive turns without external input)",
        timestampMs: Date.parse("2026-06-11T00:00:01.000Z"),
      },
      {
        kind: "stream-resumed",
        id: "stream-resumed-2",
        text: "Agent resumed",
        reason: "external input",
        timestampMs: Date.parse("2026-06-11T00:00:02.000Z"),
      },
    ],
  });
});

test("settles a completed LLM request at run-level idle even without an assistant message", () => {
  const state = settleAtIdle(
    reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: {
          requestOffset: 7,
          durationMs: 250,
          result: { status: "succeeded", text: "done" },
        },
      },
    ]),
    8,
  );

  expect(state.live).toBeNull();
  expect(state.items.map((item) => item.kind)).toEqual(["activity"]);
  const activity = state.items[0];
  expect(activity).toMatchObject({ kind: "activity", status: "done" });
  expect(activity?.kind === "activity" ? activity.steps : []).toMatchObject([
    { kind: "llm", llmRequestOffset: 7, status: "done", outcome: "completed" },
  ]);
});

test("the reported idle boundary closes no running step: the model call and the script stay running until their own settlements land", () => {
  const events = [
    { type: "events.iterate.com/agent/llm-request-requested", offset: 1, payload: { model: "m" } },
    runRequested(2, "async () => mutateExternalState()"),
  ];
  const idle = settleAtIdle(reduceAll(events), 8);

  expect(idle).toMatchObject({ items: [] });
  expect(idle.live?.steps).toMatchObject([
    { kind: "llm", status: "running" },
    { kind: "code", status: "running" },
  ]);

  // The platform settles every run: one still going at RUN_DEADLINE_MS is settled `deadline`.
  const settled = settleAtIdle(
    reduceAll([
      ...events,
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: { requestOffset: 1, result: { status: "succeeded", text: "…" } },
      },
      runSettled(2, {
        status: "failed",
        error:
          "itx.run: the script did not finish within 10 minutes; it may have partly run, and it is not run again",
        failureKind: "deadline",
      }),
    ]),
    8,
  );
  expect(settled.live).toBeNull();
  expect(settled.items).toMatchObject([
    {
      kind: "activity",
      status: "done",
      steps: [
        { kind: "llm", status: "done", outcome: "completed" },
        {
          kind: "code",
          status: "done",
          success: false,
          errorMessage: expect.stringMatching(/did not finish within 10 minutes/),
        },
      ],
    },
  ]);
});

test("a script settlement that lands after the idle report closes the step it names", () => {
  const requested = runRequested(10, "async () => mutate()");
  const idle = settleAtIdle(reduceAll([requested]), 10);
  expect(idle).toMatchObject({ items: [] });
  expect(idle.live?.steps).toMatchObject([{ kind: "code", requestOffset: 10, status: "running" }]);

  const settled = settleAtIdle(
    reduceAll([requested, runSettled(10, { status: "succeeded", result: { committed: true } })]),
    11,
  );
  expect(settled.items).toMatchObject([
    {
      kind: "activity",
      id: "activity-10",
      steps: [{ kind: "code", status: "done", success: true, result: { committed: true } }],
    },
  ]);
  const [activity] = settled.items;
  if (activity?.kind !== "activity") throw new Error("expected the settled activity");
  expect(activity.steps[0]).not.toHaveProperty("errorMessage");
});

test("an activity with one of its two scripts still running stays live at the idle report", () => {
  const state = settleAtIdle(
    reduceAll([
      runRequested(10, "async () => mutateA()"),
      runRequested(11, "async () => mutateB()"),
      runSettled(10, { status: "succeeded", result: "a" }),
    ]),
    12,
  );

  expect(state).toMatchObject({ items: [] });
  expect(state.live).toMatchObject({
    id: "activity-10",
    steps: [
      { kind: "code", requestOffset: 10, status: "done", result: "a" },
      { kind: "code", requestOffset: 11, status: "running" },
    ],
  });
});

test("the reported idle boundary never closes a running model call: only its llm-request-settled does", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 12,
      payload: { model: "gpt-test" },
    },
  ]);
  const projected = settleAtIdle(state, 11);

  expect(projected).toMatchObject({ items: [] });
  expect(projected.live?.steps).toMatchObject([{ kind: "llm", status: "running" }]);
});

test("the reported idle boundary settles the activity after a later journal event", () => {
  const state = reduceAll([
    runRequested(1, 'async (itx) => itx.chat.sendMessage("kumquat")'),
    {
      type: "events.iterate.com/agent/web-message-sent",
      offset: 2,
      payload: { message: "kumquat" },
    },
    { ...runSettled(1), offset: 3 },
    {
      type: "events.iterate.com/agent/context-added",
      offset: 4,
      payload: {
        role: "assistant",
        content: "The assistant sent this visible web-chat message: kumquat",
        llmRequestOffset: 99,
      },
    },
  ]);

  const projected = settleAtIdle(state, 3);

  expect(projected.live).toBeNull();
  expect(projected.items).toMatchObject([
    { kind: "activity", steps: [{ kind: "code", status: "done", success: true }] },
    { kind: "assistant", text: "kumquat" },
  ]);
});

test("a script past its deadline stays running through later input, which queues, until the platform's `deadline` settlement closes it", () => {
  const baseMs = Date.parse("2026-06-11T00:00:00.000Z");
  const at = (ms: number) => new Date(baseMs + ms).toISOString();
  const pastDeadline = reduceAll([
    { ...runRequested(1, "async () => mutate()"), createdAt: at(0) },
    {
      type: "events.iterate.com/agent/context-added",
      offset: 2,
      createdAt: at(RUN_DEADLINE_MS + 1_000),
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "still there?" },
    },
  ]);
  expect(pastDeadline).toMatchObject({ items: [] });
  expect(pastDeadline.queuedUserMessages).toMatchObject([{ text: "still there?" }]);
  expect(pastDeadline.live?.steps).toMatchObject([{ kind: "code", status: "running" }]);

  const settled = reduceAll([
    { ...runRequested(1, "async () => mutate()"), createdAt: at(0) },
    {
      type: "events.iterate.com/agent/context-added",
      offset: 2,
      createdAt: at(RUN_DEADLINE_MS + 1_000),
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "still there?" },
    },
    {
      ...runSettled(1, {
        status: "failed",
        error: "itx.run: the script did not finish within 10 minutes",
        failureKind: "deadline",
      }),
      offset: 3,
      createdAt: at(RUN_DEADLINE_MS + 2_000),
    },
  ]);
  expect(settled.live).toBeNull();
  expect(settled.items).toMatchObject([
    {
      kind: "activity",
      steps: [{ kind: "code", success: false, durationMs: RUN_DEADLINE_MS + 2_000 }],
    },
    { kind: "user", text: "still there?" },
  ]);
});

test("queues a user message that arrives mid-turn", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 7,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "also, one more thing",
      },
    },
  ]);

  // The interjected message should stay pinned after the live activity
  // instead of settling into chronological feed rows before the current turn.
  expect(state.items).toHaveLength(0);
  expect(state.queuedUserMessages).toHaveLength(1);
  expect(state.queuedUserMessages[0]).toMatchObject({
    kind: "user",
    text: "also, one more thing",
  });
  expect(state.live?.steps[0]).toMatchObject({ kind: "llm", status: "running" });
});

test("settles queued user messages before the next LLM request starts", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 7,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "also, one more thing",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 7,
        durationMs: 100,
        result: { status: "succeeded", text: "on it" },
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 12,
      payload: { model: "gpt-test" },
    },
  ]);

  expect(state.items.map((item) => item.kind)).toEqual(["activity", "user"]);
  expect(state.items[1]).toMatchObject({
    kind: "user",
    text: "also, one more thing",
  });
  expect(state.queuedUserMessages).toHaveLength(0);
  expect(state.live?.steps).toHaveLength(1);
  expect(state.live?.steps[0]).toMatchObject({ kind: "llm", llmRequestOffset: 12 });
});

test("a request that input starts while a script still runs moves the input into the transcript and joins the script's activity", () => {
  const events = [
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "do X" },
    },
    { type: "events.iterate.com/agent/llm-request-requested", offset: 2, payload: { model: "m" } },
    requestSettled(2),
    runRequested(4, "async () => longWork()"),
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and then?" },
    },
    { type: "events.iterate.com/agent/llm-request-requested", offset: 6, payload: { model: "m" } },
    requestSettled(6),
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "still working on X", llmRequestOffset: 6 },
    },
    runSettled(4),
  ];

  // The second request answers "and then?": the composer no longer shows it
  // queued, and the request joins the activity the script keeps running.
  const answering = reduceAll(events.slice(0, 6));
  expect(answering).toMatchObject({
    queuedUserMessages: [],
    items: [
      { kind: "user", text: "do X" },
      { kind: "user", text: "and then?" },
    ],
  });
  expect(answering.live?.steps).toMatchObject([
    { kind: "llm", llmRequestOffset: 2, status: "done" },
    { kind: "code", requestOffset: 4, status: "running" },
    { kind: "llm", llmRequestOffset: 6, status: "running" },
  ]);

  // Its answer lands at once, above the activity the script still runs: no
  // settled activity row yet, the script still running, nothing held.
  const replied = reduceAll(events.slice(0, 8));
  expect(replied).toMatchObject({
    deferredAssistantMessages: [],
    items: [
      { kind: "user", text: "do X" },
      { kind: "user", text: "and then?" },
      { kind: "assistant", text: "still working on X" },
    ],
  });
  expect(replied.live?.steps).toMatchObject([
    { kind: "llm", llmRequestOffset: 2, status: "done" },
    { kind: "code", requestOffset: 4, status: "running" },
    { kind: "llm", llmRequestOffset: 6, status: "done", outcome: "completed" },
  ]);

  // The script returned nothing, so its settlement ends the turn: journal
  // facts alone close the one activity, whole and clean.
  const settled = reduceAll(events);
  expect(settled.live).toBeNull();
  expect(settled.items).toMatchObject([
    { kind: "user", text: "do X" },
    { kind: "user", text: "and then?" },
    { kind: "assistant", text: "still working on X" },
    {
      kind: "activity",
      id: "activity-2",
      status: "done",
      steps: [
        { kind: "llm", llmRequestOffset: 2 },
        { kind: "code", requestOffset: 4, success: true },
        { kind: "llm", llmRequestOffset: 6 },
      ],
    },
  ]);
  expect(settled.items.filter((item) => item.kind === "activity")).toHaveLength(1);
  expect(summarizeAgentUiActivity(settled.items[3] as AgentUiActivity)).toMatchObject({
    outcome: "clean",
  });
});

test("a reply that lands at once leaves the activity open when the script returns a value: the follow-up request joins it", () => {
  const events = [
    runRequested(1, "async () => longWork()"),
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and then?" },
    },
    { type: "events.iterate.com/agent/llm-request-requested", offset: 3, payload: { model: "m" } },
    requestSettled(3),
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "X is still running.", llmRequestOffset: 3 },
    },
    runSettled(1, { status: "succeeded", result: { done: true } }),
    { type: "events.iterate.com/agent/llm-request-requested", offset: 7, payload: { model: "m" } },
    requestSettled(7),
  ];

  const returned = reduceAll(events.slice(0, 6));
  expect(returned.items).toMatchObject([
    { kind: "user", text: "and then?" },
    { kind: "assistant", text: "X is still running." },
  ]);
  expect(returned.live?.steps).toMatchObject([
    { kind: "code", requestOffset: 1, status: "done", success: true },
    { kind: "llm", llmRequestOffset: 3, status: "done" },
  ]);

  const followedUp = reduceAll(events);
  expect(followedUp.items.filter((item) => item.kind === "activity")).toHaveLength(0);
  expect(followedUp.live?.steps).toMatchObject([
    { kind: "code", requestOffset: 1 },
    { kind: "llm", llmRequestOffset: 3 },
    { kind: "llm", llmRequestOffset: 7, status: "done" },
  ]);
});

test("a reply whose request wrote a script that still runs waits for that script, even beside an older running script", () => {
  const events = [
    runRequested(1, "async () => longWork()"),
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and then?" },
    },
    { type: "events.iterate.com/agent/llm-request-requested", offset: 3, payload: { model: "m" } },
    requestSettled(3),
    // The answer's own script (asked for while processing its assistant
    // item), then its prose: the prose belongs after the script it announced.
    runRequested(5, "async () => more()"),
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "Starting Y too.", llmRequestOffset: 3 },
    },
    runSettled(1),
    runSettled(5),
  ];

  const olderSettled = reduceAll(events.slice(0, 7));
  expect(olderSettled).toMatchObject({
    items: [{ kind: "user", text: "and then?" }],
    deferredAssistantMessages: [{ text: "Starting Y too." }],
  });
  expect(olderSettled.live?.steps).toMatchObject([
    { kind: "code", requestOffset: 1, status: "done" },
    { kind: "llm", llmRequestOffset: 3, status: "done" },
    { kind: "code", requestOffset: 5, status: "running" },
  ]);

  expect(reduceAll(events)).toMatchObject({
    live: null,
    deferredAssistantMessages: [],
    items: [
      { kind: "user", text: "and then?" },
      { kind: "activity", steps: [{ kind: "code" }, { kind: "llm" }, { kind: "code" }] },
      { kind: "assistant", text: "Starting Y too." },
    ],
  });
});

test("a reply that lands at once follows the replies held before it in log order, and leaves later input queued", () => {
  const state = reduceAll([
    runRequested(1, "async () => longWork()"),
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and then?" },
    },
    { type: "events.iterate.com/agent/llm-request-requested", offset: 3, payload: { model: "m" } },
    // A transport echo while the request runs is held behind the running work.
    { type: "events.iterate.com/agent/web-message-sent", payload: { message: "echo" } },
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "one more" },
    },
    requestSettled(3),
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "X is still running.", llmRequestOffset: 3 },
    },
  ]);

  expect(state).toMatchObject({
    items: [
      { kind: "user", text: "and then?" },
      { kind: "assistant", text: "echo" },
      { kind: "assistant", text: "X is still running." },
    ],
    deferredAssistantMessages: [],
    // No request has taken it up yet: it stays in the composer's queue.
    queuedUserMessages: [{ text: "one more" }],
  });
  expect(state.live?.steps).toMatchObject([
    { kind: "code", requestOffset: 1, status: "running" },
    { kind: "llm", llmRequestOffset: 3, status: "done" },
  ]);
});

test("a message that names no request still waits for the running script", () => {
  const state = reduceAll([
    runRequested(1, "async () => longWork()"),
    { type: "events.iterate.com/agent/llm-request-requested", offset: 2, payload: { model: "m" } },
    requestSettled(2),
    { type: "events.iterate.com/agent/web-message-sent", payload: { message: "from a script" } },
  ]);

  expect(state).toMatchObject({
    items: [],
    deferredAssistantMessages: [{ text: "from a script" }],
  });
});

test("a request that input starts while a script still runs moves the script's earlier reply into the transcript before that input", () => {
  const state = reduceAll([
    runRequested(1, "async () => longWork()"),
    { type: "events.iterate.com/agent/web-message-sent", payload: { message: "still on X" } },
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and then?" },
    },
    { type: "events.iterate.com/agent/llm-request-requested", offset: 4, payload: { model: "m" } },
    requestSettled(4),
    runSettled(1),
  ]);

  expect(state).toMatchObject({
    items: [
      { kind: "assistant", text: "still on X" },
      { kind: "user", text: "and then?" },
    ],
    deferredAssistantMessages: [],
    queuedUserMessages: [],
    live: {
      steps: [
        { kind: "code", status: "done" },
        { kind: "llm", llmRequestOffset: 4, status: "done" },
      ],
    },
  });
});

test("a settling script flushes its held reply and the input that queued behind it in log order", () => {
  const state = reduceAll([
    runRequested(1, "async () => longWork()"),
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and then?" },
    },
    { type: "events.iterate.com/agent/web-message-sent", payload: { message: "X is done" } },
    runSettled(1),
  ]);

  expect(state.items).toMatchObject([
    { kind: "activity", steps: [{ kind: "code", status: "done", success: true }] },
    { kind: "user", text: "and then?" },
    { kind: "assistant", text: "X is done" },
  ]);
  expect(state).toMatchObject({ deferredAssistantMessages: [], queuedUserMessages: [] });
});

test("does not append late chunks from an interrupted request into the next turn", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 7,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 7,
        sequence: 0,
        responseDelta: "old partial",
        thinkingDelta: "",
      },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "oh this is taking too long",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 7,
        result: {
          status: "cancelled",
          reason: "interrupted-by-user-input",
          partialText: "old partial",
        },
      },
    },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 7,
        sequence: 1,
        responseDelta: " stale chunk",
        thinkingDelta: "",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 12,
      payload: { model: "gpt-test" },
    },
  ]);

  expect(state.items.map((item) => item.kind)).toEqual(["activity", "user"]);
  const activity = state.items[0];
  if (activity?.kind !== "activity") throw new Error("expected activity item");
  expect(activity.steps[0]).toMatchObject({
    kind: "llm",
    llmRequestOffset: 7,
    outcome: "cancelled",
    responseText: appendText("", "old partial"),
  });
  expect(state.items[1]).toMatchObject({
    kind: "user",
    text: "oh this is taking too long",
  });
  expect(state.live?.steps).toHaveLength(1);
  expect(state.live?.steps[0]).toMatchObject({
    kind: "llm",
    llmRequestOffset: 12,
    responseText: "",
  });
});

test("renders the loop's own developer context (a format correction) as a user bubble", () => {
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "developer",
        content: "Your code did NOT run: the <codemode> tag was empty.",
        actor: { type: "agent" },
      },
    },
  ]);

  expect(state.items).toMatchObject([
    { kind: "user", text: "Your code did NOT run: the <codemode> tag was empty." },
  ]);
});

test("a user message's attachments render without a URL: the page signs one per file", () => {
  const file = {
    contentType: "image/png",
    filename: "screenshot.png",
    path: "files/screenshot.png",
    size: 123,
  };
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", content: "", files: [file] },
    },
  ]);

  expect(state.items).toMatchObject([{ kind: "user", text: "", files: [file] }]);
});

test("groups expired and unrecognized cancellations into one failed activity", () => {
  const state = settleAtIdle(
    reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: {
          requestOffset: 7,
          result: { status: "cancelled", reason: "future-cancel-reason" },
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 11,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: { requestOffset: 11, result: { status: "cancelled", reason: "expired" } },
      },
    ]),
    5,
  );

  expect(state.live).toBeNull();
  expect(state.items).toHaveLength(1);
  const activity = state.items[0];
  if (activity?.kind !== "activity") throw new Error("expected activity item");
  // A reason this UI does not recognize stays unmapped; a cancelled step
  // without a recognized reason still counts as a failure.
  expect(activity.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "cancelled",
    durationMs: 1_000,
    cancelReason: undefined,
  });
  expect(activity.steps[1]).toMatchObject({ outcome: "cancelled", cancelReason: "expired" });
  expect(summarizeAgentUiActivity(activity)).toMatchObject({
    outcome: "failed",
    requestCount: 2,
  });
});

test("the first settlement wins when a duplicate races in", () => {
  // The contract collapses a zombie incarnation racing an interrupt to one
  // settlement; if both appends still land, the UI must keep the first fact.
  const state = reduceAll([
    {
      type: "events.iterate.com/agent/llm-request-requested",
      offset: 1,
      payload: { model: "gpt-test" },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 1,
        result: {
          status: "cancelled",
          reason: "interrupted-by-user-input",
          partialText: "Hel",
        },
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: {
        requestOffset: 1,
        durationMs: 2_000,
        result: {
          status: "succeeded",
          text: "late zombie response",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      },
    },
  ]);

  expect(state.live?.steps[0]).toMatchObject({
    kind: "llm",
    status: "done",
    outcome: "cancelled",
    cancelReason: "interrupted-by-user-input",
    inputTokens: undefined,
  });
  if (!state.live) throw new Error("expected live activity");
  expect(summarizeAgentUiActivity(state.live)).toMatchObject({
    outcome: "interrupted",
    requestCount: 1,
  });
});

test("derived events mark the llm step interpreted; uninterpreted turns stay plain", () => {
  const answered = [
    { type: "events.iterate.com/agent/llm-request-requested", payload: { model: "m" } },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "assistant",
        content: 'Hi!\n<codemode status="Working">\nreturn 1\n</codemode>',
        llmRequestOffset: 1,
      },
    },
    // The agent's derived events, in its committed order: the run it asked
    // for while processing the assistant event (offset 2) FIRST — so the code
    // step joins the request's still-open activity — then the extracted prose
    // (marked with the request offset).
    runRequested(3, "async (itx) => {\nreturn 1\n}", 2),
  ];
  // the run alone marks the response interpreted: the Script tab carries the code
  expect(reduceAll(answered).live?.steps[0]).toMatchObject({
    kind: "llm",
    assistantEventOffset: 2,
    interpreted: true,
  });
  const reduced = reduceAll([
    ...answered,
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "Hi!", llmRequestOffset: 1 },
    },
  ]);
  const llmStep = reduced.live?.steps.find((step) => step.kind === "llm");
  expect(llmStep).toMatchObject({ assistantEventOffset: 2, interpreted: true });
  // The extracted prose still becomes the assistant bubble (deferred until
  // the live round settles, like any mid-turn assistant message).
  expect(reduced.deferredAssistantMessages).toMatchObject([{ text: "Hi!" }]);

  // A plain turn (no derived events) is NOT marked.
  const plain = reduceAll([
    { type: "events.iterate.com/agent/llm-request-requested", payload: { model: "m" } },
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "assistant", content: "Just prose.", llmRequestOffset: 1 },
    },
  ]);
  const plainStep = plain.live?.steps.find((step) => step.kind === "llm");
  expect(plainStep).toMatchObject({ assistantEventOffset: 2 });
  expect(plainStep).not.toHaveProperty("interpreted");
});

test("script-before-prose keeps the whole turn in ONE activity, rounds paired", () => {
  const reduced = reduceAll([
    { type: "events.iterate.com/agent/llm-request-requested", payload: { model: "m" } },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "assistant",
        content: 'Hi!\n<codemode status="Working">\nreturn 1\n</codemode>',
        llmRequestOffset: 1,
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-settled",
      payload: { requestOffset: 1, result: { status: "succeeded", text: "…" } },
    },
    // The agent's order: script first (joins the request's activity), prose
    // second (defers — the activity is now working again).
    runRequested(4, "async (itx) => 1", 2),
    {
      type: "events.iterate.com/agent/web-message-sent",
      payload: { message: "Hi!", llmRequestOffset: 1 },
    },
  ]);
  // No settled activity item was flushed mid-turn: the request and its
  // extracted code live in the SAME activity.
  expect(reduced.items.filter((item) => item.kind === "activity")).toHaveLength(0);
  expect(reduced.live?.steps.map((step) => step.kind)).toEqual(["llm", "code"]);
  // The prose deferred (the activity is working) instead of splitting it.
  expect(reduced.deferredAssistantMessages).toMatchObject([{ text: "Hi!" }]);
});

test("phases follow the running step: waiting → thinking → writing → running", () => {
  const waiting = reduceAll([{ ...request, offset: 5 }]);
  expect(deriveAgentUiLiveStatus(waiting)).toMatchObject({ phase: "waiting", statusText: null });

  const thinking = reduceAll([
    { ...request, offset: 5 },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 5,
        sequence: 0,
        responseDelta: "",
        thinkingDelta: "hmm",
      },
    },
  ]);
  expect(deriveAgentUiLiveStatus(thinking)).toMatchObject({ phase: "thinking" });

  const writing = reduceAll([
    { ...request, offset: 5 },
    {
      type: "events.iterate.com/agent/llm-response-frame",
      payload: {
        llmRequestOffset: 5,
        sequence: 0,
        responseDelta: "await work()",
        thinkingDelta: "",
      },
    },
  ]);
  expect(deriveAgentUiLiveStatus(writing)).toMatchObject({ phase: "writing" });

  const running = reduceAll([{ ...request, offset: 5 }, runRequested(2)]);
  expect(deriveAgentUiLiveStatus(running)).toMatchObject({ phase: "running" });
});

test("a script that settled WITH a value means another round: processing", () => {
  const state = reduceAll([
    { ...request, offset: 5 },
    requestSettled(5),
    runRequested(3),
    runSettled(3, { status: "succeeded", result: 42 }),
  ]);
  expect(deriveAgentUiLiveStatus(state)).toMatchObject({ phase: "processing" });
  // A value-less settle (`return;`) ends the turn — no round is owed.
  const returned = reduceAll([
    { ...request, offset: 5 },
    requestSettled(5),
    runRequested(3),
    runSettled(3),
  ]);
  expect(deriveAgentUiLiveStatus(returned)).toMatchObject({ phase: "working" });
  // A failed settle isn't a promise of another round either.
  const failed = reduceAll([
    { ...request, offset: 5 },
    requestSettled(5),
    runRequested(3),
    runSettled(3, { status: "failed", error: "boom", failureKind: "runtime" }),
  ]);
  expect(deriveAgentUiLiveStatus(failed)).toMatchObject({ phase: "working" });
});

test("statusText is this turn's summary only — a previous turn's text stays generic", () => {
  const turnOne = [
    { ...request, offset: 5 },
    requestSettled(5),
    runRequested(3),
    {
      type: "events.iterate.com/agent/summary-updated",
      payload: { activity: "Sweeping March refunds" },
    },
    runSettled(3, { status: "succeeded", result: 1 }),
  ];
  expect(deriveAgentUiLiveStatus(reduceAll(turnOne))).toMatchObject({
    phase: "processing",
    statusText: "Sweeping March refunds",
  });

  // A user message settles the turn; the next turn's live activity starts
  // fresh — the stream's standing summary is stale for the live row (code
  // steps still inherit it for round headers, unchanged).
  const turnTwo = reduceAll([
    ...turnOne,
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and April?" },
    },
    { ...request, offset: 50 },
  ]);
  expect(turnTwo).toMatchObject({ summaryActivity: "Sweeping March refunds" });
  expect(deriveAgentUiLiveStatus(turnTwo)).toMatchObject({ phase: "waiting", statusText: null });

  const turnTwoUpdated = reduceAll([
    ...turnOne,
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and April?" },
    },
    { ...request, offset: 50 },
    {
      type: "events.iterate.com/agent/summary-updated",
      payload: { activity: "Sweeping April refunds" },
    },
  ]);
  expect(deriveAgentUiLiveStatus(turnTwoUpdated)).toMatchObject({
    statusText: "Sweeping April refunds",
  });
});

test("agent/paused settles an idle live activity from journal facts alone", () => {
  // The processing gap's guard: the autonomous breaker parks the loop after
  // a script returned a value — without this settle the "another round is
  // owed" inference would spin forever on journal-only surfaces (mobile).
  const state = reduceAll([
    { ...request, offset: 5 },
    requestSettled(5),
    runRequested(3),
    runSettled(3, { status: "succeeded", result: 42 }),
    {
      type: "events.iterate.com/agent/paused",
      payload: { reason: "autonomous turn limit reached" },
    },
  ]);
  expect(state.live).toBeNull();
  expect(state.items.map((item) => item.kind)).toEqual(["activity", "stream-paused"]);
  expect(state.items[0]).toMatchObject({ kind: "activity", status: "done" });
});

test("agent/paused while a request is open keeps the live activity running", () => {
  // Operator/script-appendable mid-request: the open request drains and
  // settles normally, so the pause must not archive the running step.
  const state = reduceAll([
    { ...request, offset: 5 },
    { type: "events.iterate.com/agent/paused", payload: { reason: "operator hold" } },
  ]);
  expect(state.items.map((item) => item.kind)).toEqual(["stream-paused"]);
  expect(state.live?.steps).toMatchObject([{ kind: "llm", status: "running" }]);
});

test("a value-settled script on a PAUSED loop settles the activity — never processing", () => {
  // The pause folded mid-request; the drained request's script then settles
  // WITH a value. No follow-up round is coming and no second pause fact
  // will arrive, so the settle itself must close the activity instead of
  // leaving a permanent "processing" claim.
  const state = reduceAll([
    { ...request, offset: 5 },
    { type: "events.iterate.com/agent/paused", payload: { reason: "operator hold" } },
    requestSettled(5),
    runRequested(4),
    runSettled(4, { status: "succeeded", result: 42 }),
  ]);
  expect(state).toMatchObject({ paused: true });
  expect(state.live).toBeNull();
  expect(state.items.filter((item) => item.kind === "activity")).toMatchObject([
    { status: "done" },
  ]);
  // And resuming clears the flag for the next real turn.
  const resumed = reduceAll([
    { ...request, offset: 5 },
    { type: "events.iterate.com/agent/paused", payload: {} },
    { type: "events.iterate.com/agent/resumed", payload: {} },
  ]);
  expect(resumed).toMatchObject({ paused: false });
});

function reduceAll(events: Array<Partial<StreamEvent> & { type: string; payload?: unknown }>) {
  let offset = 0;
  const fullEvents = events.map((partial) => {
    offset += 1;
    return {
      offset: partial.offset ?? offset,
      createdAt: partial.createdAt || `2026-06-11T00:00:${String(offset).padStart(2, "0")}.000Z`,
      payload: partial.payload ?? {},
      ...partial,
    } as unknown as StreamEvent;
  });
  let state = initialAgentUiState();
  // The feed renders every settled item in emission order.
  const items: AgentUiItem[] = [];
  for (const event of fullEvents) {
    const step = reduceAgentUi(state, event);
    state = step.endState;
    items.push(...step.items);
  }
  return { ...state, items };
}

/** The agent reports itself idle at the moment of `sinceOffset` (one second per offset). */
function settleAtIdle(reduced: ReturnType<typeof reduceAll>, sinceOffset: number) {
  const projected = settleAgentUiAtIdleBoundary(
    reduced,
    new Date(Date.parse("2026-06-11T00:00:00.000Z") + sinceOffset * 1_000).toISOString(),
  );
  return { ...projected.endState, items: [...reduced.items, ...projected.items] };
}

const request = { type: "events.iterate.com/agent/llm-request-requested", payload: {} };
const requestSettled = (requestOffset: number) => ({
  type: "events.iterate.com/agent/llm-request-settled",
  payload: { requestOffset, result: { status: "succeeded", text: "await work()" } },
});
/** The context's `itx/run-requested` at `offset`; `askedWhile` is the assistant item the agent was
 *  processing when it asked (the engine's `whileProcessing` stamp). */
const runRequested = (offset: number, code = "await work()", askedWhile?: number) => ({
  type: "events.iterate.com/itx/run-requested",
  offset,
  payload: { code },
  ...(askedWhile !== undefined && {
    source: {
      processor: {
        slug: "agent",
        version: "1",
        whileProcessing: { offset: askedWhile, type: "events.iterate.com/agent/context-added" },
      },
    },
  }),
});
/** The platform's `itx/run-settled` for the run requested at `requestOffset`. */
const runSettled = (
  requestOffset: number,
  settlement: RunSettlement = { status: "succeeded" },
) => ({
  type: "events.iterate.com/itx/run-settled",
  payload: { requestOffset, settlement },
});
