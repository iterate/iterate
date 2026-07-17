// Reducer coverage for the browser-side agent UI fold: a full simulated
// turn — user message, LLM request with streamed thinking + response deltas,
// code execution, completion, assistant reply — must reduce into the chat
// items and live active-work tail the agent feed renders.

import { describe, expect, test } from "vitest";
import type { Event } from "@iterate-com/ui/components/events/types";
import {
  AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT,
  initialAgentUiState,
  reduceAgentUi,
  summarizeAgentUiActivity,
  type AgentUiItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  slackBotMessageWebhookPayload,
  slackHumanMessageWebhookPayload,
  telegramMessageWebhookPayload,
} from "../domains/integrations/webhook-fixtures.ts";

const SCRIPT_EXPIRES_AT = Date.parse("2026-06-11T00:15:00.000Z");

function reduceAll(events: Array<Partial<Event> & { type: string; payload?: unknown }>) {
  let offset = 0;
  const fullEvents = events.map((partial) => {
    offset += 1;
    return {
      offset: partial.offset ?? offset,
      createdAt: partial.createdAt ?? `2026-06-11T00:00:${String(offset).padStart(2, "0")}.000Z`,
      streamPath: "/agents/test",
      payload: partial.payload ?? {},
      ...partial,
    } as unknown as Event;
  });
  let state = initialAgentUiState();
  // Settled items live in SQLite feed_items rows (positions allocated by the
  // browser-feed projector); tests assert over the materialized list the
  // virtualizer would render.
  const items: AgentUiItem[] = [];
  for (const event of fullEvents) {
    const step = reduceAgentUi(state, event);
    state = step.endState;
    items.push(...step.items);
  }
  return { ...state, items };
}

function llmEvent(
  lifecycle: "requested" | "completed" | "cancelled",
  offset: number,
  reason = "durable-object-crashed",
) {
  return {
    type: `events.iterate.com/agent/llm-request-${lifecycle}`,
    ...(lifecycle === "requested" ? { offset } : {}),
    payload:
      lifecycle === "requested"
        ? { model: "gpt-test" }
        : lifecycle === "completed"
          ? { llmRequestOffset: offset, result: { status: "success" } }
          : { phase: "requested", llmRequestOffset: offset, reason },
  };
}

describe("agent-ui reducer", () => {
  test("streams thinking and response deltas into the live llm step", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
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
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: {
          llmRequestOffset: 10,
          sequence: 0,
          chunk: { choices: [{ delta: { reasoning_content: "Reading the stream" } }] },
        },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: {
          llmRequestOffset: 10,
          sequence: 1,
          chunk: { choices: [{ delta: { content: "const n = await " } }] },
        },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: {
          llmRequestOffset: 10,
          sequence: 2,
          chunk: { choices: [{ delta: { content: "stream.count();" } }] },
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
      thinkingText: "Reading the stream",
      responseText: "const n = await stream.count();",
    });
  });

  test("settles the activity into items when all work completes", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", actor: { type: "user", origin: "web" }, content: "hi" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 5,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "x1",
          code: "await stream.read()",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 12 } },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          llmRequestOffset: 5,
          durationMs: 2100,
          result: { status: "success", usage: { input_tokens: 9400, output_tokens: 300 } },
        },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
        payload: { message: "There are 12 inputs." },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.items.map((item) => item.kind)).toEqual(["user", "activity", "assistant"]);
    const activity = state.items[1];
    if (activity?.kind !== "activity") throw new Error("expected activity item");
    expect(activity.status).toBe("done");
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
      status: "done",
      code: "await stream.read()",
      result: 12,
      success: true,
      durationMs: 1000,
    });
  });

  test("keeps running script source and start time in the live activity", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "x1",
          code: "await itx.repo.readFile({ path: 'README.md' })",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
    ]);

    expect(state.items).toHaveLength(0);
    expect(state.live?.steps).toHaveLength(1);
    expect(state.live?.steps[0]).toMatchObject({
      kind: "code",
      executionId: "x1",
      status: "running",
      code: "await itx.repo.readFile({ path: 'README.md' })",
      startedAtMs: Date.parse("2026-06-11T00:00:01.000Z"),
    });
  });

  test("does not guess which script a malformed completion belongs to", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "exact-id-required",
          code: "async () => mutate()",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { settlement: { status: "succeeded", result: "wrong target" } },
      },
    ]);

    expect(state.live?.steps).toMatchObject([
      { kind: "code", executionId: "exact-id-required", status: "running" },
    ]);
  });

  test("does not derive agent state or durations from a malformed event timestamp", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "valid-start",
          code: "async () => mutate()",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        createdAt: "not-a-timestamp",
        payload: {
          executionId: "valid-start",
          settlement: { status: "succeeded", result: "must be ignored" },
        },
      },
    ]);

    expect(state.live?.steps).toMatchObject([
      { kind: "code", executionId: "valid-start", status: "running" },
    ]);
  });

  test("rejects script requests that do not satisfy the current deadline contract", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: { executionId: "missing-deadline", code: "return 1" },
      },
    ]);

    expect(state.items).toEqual([]);
    expect(state.live).toBeNull();
  });

  test("keeps the live indicator while a running script emits chat messages", () => {
    const countdownEvents: Array<Partial<Event> & { type: string; payload?: unknown }> = [
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test", requestId: "llm-request:gen-0" },
      },
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "assistant",
          llmRequestOffset: 10,
          content:
            "```ts\nasync (itx) => {\n  await itx.chat.sendMessage('20');\n  await new Promise((resolve) => setTimeout(resolve, 1000));\n}\n```",
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "agent-output:11",
          code: "async (itx) => {\n  await itx.chat.sendMessage('20');\n  await new Promise((resolve) => setTimeout(resolve, 1000));\n}",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: { llmRequestOffset: 10, result: { status: "success" } },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
        payload: { message: "20" },
      },
    ];
    const running = reduceAll(countdownEvents);

    expect(running.items).toEqual([]);
    expect(running.deferredAssistantMessages).toMatchObject([{ kind: "assistant", text: "20" }]);
    expect(running.queuedUserMessages).toEqual([]);
    expect(running.live?.steps.at(-1)).toMatchObject({
      kind: "code",
      executionId: "agent-output:11",
      status: "running",
    });

    const completed = reduceAll([
      ...countdownEvents,
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "agent-output:11", settlement: { status: "succeeded" } },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 20 },
      },
    ]);

    expect(completed.live).toBeNull();
    expect(completed.items.map((item) => item.kind)).toEqual(["activity", "assistant"]);
    expect(completed.items[0]).toMatchObject({
      kind: "activity",
      status: "done",
      steps: [
        { kind: "llm", status: "done" },
        { kind: "code", executionId: "agent-output:11", status: "done" },
      ],
    });
  });

  test("accumulates agent llm-response-chunk deltas", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 3,
        payload: { model: "test-model" },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: { llmRequestOffset: 3, sequence: 0, chunk: { response: "Hel" } },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: { llmRequestOffset: 3, sequence: 1, chunk: { response: "lo" } },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: {
          llmRequestOffset: 3,
          sequence: 2,
          chunk: { choices: [{ delta: { reasoning_content: "hmm" } }] },
        },
      },
    ]);

    expect(state.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "Hello",
      thinkingText: "hmm",
    });
  });

  test("tracks subscriber presence including processor announcements", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/stream/subscriber-connected",
        payload: {
          subscriptionKey: "agent:agent",
          direction: "outbound",
          subscriber: {
            incarnationId: "i1",
            processor: {
              announcement: {
                slug: "agent",
                version: "0.1.0",
                description: "Drives the LLM loop.",
                consumes: ["a"],
                emits: ["b"],
                ownedEvents: [{ type: "events.iterate.com/agents/context-added" }],
              },
            },
          },
        },
      },
      {
        type: "events.iterate.com/stream/subscriber-connected",
        payload: { subscriptionKey: "browser:tab-1", direction: "inbound" },
      },
      {
        type: "events.iterate.com/stream/subscriber-disconnected",
        payload: { subscriptionKey: "browser:tab-1", reason: "unsubscribed" },
      },
    ]);

    expect(state.presence).toHaveLength(2);
    expect(state.presence[0]).toMatchObject({
      subscriptionKey: "agent:agent",
      connected: true,
      processor: { slug: "agent", version: "0.1.0" },
    });
    expect(state.presence[1]).toMatchObject({ subscriptionKey: "browser:tab-1", connected: false });
  });

  test("does not show the bootstrap stream wake in the agent feed", () => {
    const state = reduceAll([
      { type: "events.iterate.com/stream/created" },
      { type: "events.iterate.com/stream/woken" },
    ]);

    expect(state.items).toEqual([]);
  });

  test("shows later stream wakes in the agent feed and clears presence", () => {
    const state = reduceAll([
      { type: "events.iterate.com/stream/created" },
      { type: "events.iterate.com/stream/woken" },
      {
        type: "events.iterate.com/stream/subscriber-connected",
        payload: { subscriptionKey: "agent:agent", direction: "outbound" },
      },
      { type: "events.iterate.com/stream/woken" },
    ]);

    expect(state.items).toEqual([
      {
        kind: "stream-woken",
        id: "stream-woken-4",
        text: "Stream durable object woke",
        timestampMs: Date.parse("2026-06-11T00:00:04.000Z"),
      },
    ]);
    expect(state.presence).toMatchObject([{ subscriptionKey: "agent:agent", connected: false }]);
  });

  test("shows child stream creation events in the agent feed", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/stream/child-stream-created",
        payload: { childPath: "/agents/test/child" },
      },
    ]);

    expect(state.items).toEqual([
      {
        kind: "child-stream-created",
        id: "child-stream-created-1",
        childPath: "/agents/test/child",
        timestampMs: Date.parse("2026-06-11T00:00:01.000Z"),
      },
    ]);
  });

  test("shows stream pause and resume events in the agent feed", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/stream/paused",
        payload: { reason: "Agent circuit breaker tripped." },
      },
      {
        type: "events.iterate.com/stream/resumed",
        payload: { reason: "Operator resumed the agent." },
      },
    ]);

    expect(state.items).toEqual([
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
    ]);
  });

  test("settles a completed LLM request at run-level idle even without an assistant message", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          llmRequestOffset: 7,
          durationMs: 250,
          result: { status: "success" },
        },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 8 },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.items.map((item) => item.kind)).toEqual(["activity"]);
    const activity = state.items[0];
    expect(activity).toMatchObject({ kind: "activity", status: "done" });
    expect(activity?.kind === "activity" ? activity.steps : []).toMatchObject([
      { kind: "llm", llmRequestOffset: 7, status: "done", outcome: "completed" },
    ]);
  });

  test("makes missing durable completions explicit when run-level idle closes work", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "script-without-completion",
          code: "async () => mutateExternalState()",
          expiresAt: Date.parse("2026-06-11T00:15:00.000Z"),
        },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 8 },
      },
    ]);

    const activity = state.items[0];
    if (activity?.kind !== "activity") throw new Error("expected activity item");
    expect(activity.steps).toMatchObject([
      {
        kind: "llm",
        status: "done",
        outcome: "failed",
        errorMessage: expect.stringMatching(/without a durable LLM completion/i),
      },
      {
        kind: "code",
        status: "done",
        success: false,
        errorMessage: expect.stringMatching(/outcome is unknown.*safe to re-run/i),
      },
    ]);
  });

  test("emits a same-id correction when a durable script settlement arrives after idle", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        offset: 10,
        payload: {
          executionId: "late-script",
          code: "async () => mutate()",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 10 },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: {
          executionId: "late-script",
          settlement: { status: "succeeded", result: { committed: true } },
        },
      },
    ]);

    expect(state.items).toHaveLength(2);
    const [provisional, corrected] = state.items;
    expect(provisional).toMatchObject({
      kind: "activity",
      steps: [{ kind: "code", outcomeSource: "inferred", success: false }],
    });
    expect(corrected).toMatchObject({
      kind: "activity",
      id: provisional?.id,
      steps: [
        {
          kind: "code",
          outcomeSource: "durable",
          success: true,
          result: { committed: true },
        },
      ],
    });
    if (corrected?.kind !== "activity" || corrected.steps[0]?.kind !== "code") {
      throw new Error("expected corrected code activity");
    }
    expect(corrected.steps[0]).not.toHaveProperty("errorMessage");
    expect(state.provisionalActivities).toEqual({});
  });

  test("stores one provisional activity for a group with several unsettled scripts", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        offset: 10,
        payload: {
          executionId: "late-a",
          code: "async () => mutateA()",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        offset: 11,
        payload: {
          executionId: "late-b",
          code: "async () => mutateB()",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 11 },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "late-a", settlement: { status: "succeeded", result: "a" } },
      },
    ]);

    expect(Object.values(state.provisionalActivities)).toHaveLength(1);
    expect(Object.keys(state.provisionalActivities)).toEqual(["activity-10"]);
    expect(state.items.at(-1)).toMatchObject({
      id: "activity-10",
      steps: [
        { kind: "code", executionId: "late-a", outcomeSource: "durable" },
        { kind: "code", executionId: "late-b", outcomeSource: "inferred" },
      ],
    });
  });

  test("bounds provisional activity corrections when completions never arrive", () => {
    const baseMs = Date.parse("2026-06-11T00:00:00.000Z");
    const eventCount = AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT + 8;
    const events = Array.from({ length: eventCount }, (_, index) => {
      const requestedOffset = index * 2 + 1;
      return [
        {
          type: "events.iterate.com/capability-host/script-run-requested",
          offset: requestedOffset,
          createdAt: new Date(baseMs + requestedOffset * 1_000).toISOString(),
          payload: {
            executionId: `missing-${index}`,
            code: "async () => mutate()",
            expiresAt: baseMs + 15 * 60_000,
          },
        },
        {
          type: "events.iterate.com/agent/status-changed",
          offset: requestedOffset + 1,
          createdAt: new Date(baseMs + (requestedOffset + 1) * 1_000).toISOString(),
          payload: { busy: false, sinceOffset: requestedOffset },
        },
      ];
    }).flat();

    const state = reduceAll(events);

    expect(Object.keys(state.provisionalActivities)).toHaveLength(
      AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT,
    );
    expect(state.provisionalActivities["activity-1"]).toBeUndefined();
    expect(state.provisionalActivities[`activity-${(eventCount - 1) * 2 + 1}`]).toBeDefined();
  });

  test("does not guess a phase from a malformed busy status event", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/status-changed",
        offset: 7,
        payload: { busy: true, sinceOffset: 6 },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.statusSinceOffset).toBeNull();
  });

  test("queues a user message that arrives mid-turn", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agents/context-added",
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
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          actor: { type: "user", origin: "web" },
          content: "also, one more thing",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          llmRequestOffset: 7,
          durationMs: 100,
          result: { status: "success" },
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

  test("does not append late chunks from an interrupted request into the next turn", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: {
          llmRequestOffset: 7,
          sequence: 0,
          chunk: { choices: [{ delta: { content: "old partial" } }] },
        },
      },
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          actor: { type: "user", origin: "web" },
          content: "oh this is taking too long",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-cancelled",
        payload: {
          phase: "requested",
          llmRequestOffset: 7,
          reason: "interrupted-by-user-input",
        },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: {
          llmRequestOffset: 7,
          sequence: 1,
          chunk: { choices: [{ delta: { content: " stale chunk" } }] },
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
      responseText: "old partial",
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

  test.for([
    {
      name: "renders a slack user message webhook as a user bubble",
      events: [
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: slackHumanMessageWebhookPayload({
            channel: "C08R1SMTZGD",
            text: "hey <@U9BOT> can you check <https://example.com/status|the status page>? a &amp; b",
            ts: "1783437255.864399",
            user: "U0123ABC",
          }),
        },
      ],
      expectedItems: [
        {
          kind: "user",
          text: "hey @U9BOT can you check [the status page](https://example.com/status)? a & b",
          via: { service: "slack", sender: "U0123ABC" },
        },
      ],
    },
    {
      name: "renders the bot's slack echo webhook as an assistant bubble",
      events: [
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: slackBotMessageWebhookPayload({
            botProfile: { name: "iterate" },
            subtype: "bot_message",
            text: "All 3 checks passed.",
            ts: "1783437299.000100",
          }),
        },
      ],
      expectedItems: [
        {
          kind: "assistant",
          text: "All 3 checks passed.",
          via: { service: "slack", sender: "iterate" },
        },
      ],
    },
    {
      name: "renders a third-party bot's slack message as a user bubble, not the assistant",
      events: [
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: slackBotMessageWebhookPayload({
            botId: "B0OTHER",
            botProfile: { name: "github", user_id: "UGITHUB" },
            subtype: "bot_message",
            text: "Deploy finished.",
            ts: "1783437300.000100",
          }),
        },
      ],
      expectedItems: [
        {
          kind: "user",
          text: "Deploy finished.",
          via: { service: "slack", sender: "github" },
        },
      ],
    },
    {
      name: "ignores non-message and edit slack webhooks",
      events: [
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: { type: "reaction_added", user: "U0123ABC", reaction: "eyes" },
            },
          },
        },
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: {
            body: {
              type: "event_callback",
              event: {
                type: "message",
                subtype: "message_changed",
                channel: "C08R1SMTZGD",
                message: { text: "edited text", user: "U0123ABC" },
              },
            },
          },
        },
        {
          type: "events.iterate.com/slack/webhook-received",
          payload: { body: { type: "url_verification", challenge: "x" } },
        },
      ],
      expectedItems: [],
    },
    {
      name: "renders a telegram message webhook as a user bubble (text, sender, media placeholders)",
      events: [
        {
          type: "events.iterate.com/telegram/webhook-received",
          payload: telegramMessageWebhookPayload({
            chatId: 42,
            date: 1_783_437_255,
            text: "what's the plan for today?",
          }),
        },
        // No username on the sender (falls back to first_name) and no text —
        // media renders as bracketed placeholders after the caption.
        {
          type: "events.iterate.com/telegram/webhook-received",
          payload: {
            botId: "7000001",
            body: {
              update_id: 100002,
              message: {
                message_id: 2,
                from: { id: 555, is_bot: false, first_name: "Misha" },
                chat: { id: 42, type: "private" },
                date: 1_783_437_299,
                caption: "look at this",
                photo: [{ file_id: "photo-1" }],
              },
            },
          },
        },
      ],
      expectedItems: [
        {
          kind: "user",
          text: "what's the plan for today?",
          via: { service: "telegram", sender: "misha" },
        },
        {
          kind: "user",
          text: "look at this [photo]",
          via: { service: "telegram", sender: "Misha" },
        },
      ],
    },
    {
      name: "renders a telegram send request as the assistant bubble and ignores non-message updates",
      events: [
        {
          type: "events.iterate.com/telegram/send-requested",
          payload: { text: "Started a fresh thread." },
        },
        // Membership updates, markers, and bot-authored echoes are not bubbles.
        {
          type: "events.iterate.com/telegram/webhook-received",
          payload: {
            botId: "7000001",
            body: { update_id: 3, my_chat_member: { chat: { id: 42 }, from: { id: 555 } } },
          },
        },
        {
          type: "events.iterate.com/telegram/message-sent",
          payload: { messageId: 9001, requestOffset: 1 },
        },
      ],
      expectedItems: [
        { kind: "assistant", text: "Started a fresh thread.", via: { service: "telegram" } },
      ],
    },
  ])("$name", ({ events, expectedItems }) => {
    expect(reduceAll(events).items).toMatchObject(expectedItems);
  });

  test("queues a slack user message that arrives mid-turn", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/slack/webhook-received",
        payload: slackHumanMessageWebhookPayload({
          channel: "C1",
          text: "one more",
          ts: "1.2",
          user: "U1",
        }),
      },
    ]);

    expect(state.items).toHaveLength(0);
    expect(state.queuedUserMessages).toMatchObject([{ kind: "user", text: "one more" }]);
  });

  test("shows only the attachments from the slack-agent's transcribed message", () => {
    // The slack message itself already rendered from the webhook event; the
    // slack-agent processor's context-added yaml transcription exists for
    // the model, not the user — but its stored file attachments are the only
    // browser-renderable copy of shared files.
    const file = {
      contentType: "image/png",
      filename: "screenshot.png",
      path: "files/screenshot.png",
      size: 123,
      url: "https://files.example/screenshot.png",
    };
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: "slack-agent:webhook-to-agent-input:41",
        payload: {
          content: "```yaml\nbody: ...\n```",
          role: "developer",
          actor: { type: "slack", userId: "U1" },
          files: [file],
        },
      },
    ]);

    expect(state.items).toMatchObject([
      { kind: "user", text: "", files: [file], via: { service: "slack", sender: "U1" } },
    ]);
  });

  test("keeps email/github transcription text visible — they have no raw-event bubble", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "developer",
          content:
            "`events.iterate.com/email/received` event received\n\n```yaml\nsubject: hi\n```",
          actor: { type: "email", address: "dana@example.com" },
        },
      },
    ]);

    expect(state.items).toMatchObject([
      {
        kind: "user",
        text: expect.stringContaining("subject: hi"),
        via: { service: "email", sender: "dana@example.com" },
      },
    ]);
  });

  test("renders inter-agent mail as a labeled user bubble", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "developer",
          content: "Done. Findings attached below.",
          actor: { type: "agent", path: "/agents/main/researcher" },
        },
      },
    ]);

    expect(state.items).toMatchObject([
      {
        kind: "user",
        text: "Done. Findings attached below.",
        via: { service: "agent", sender: "/agents/main/researcher" },
      },
    ]);
  });

  test("marks an LLM request cancelled when interrupted", () => {
    const state = reduceAll([
      llmEvent("requested", 7),
      llmEvent("cancelled", 7, "interrupted-by-user-input"),
      llmEvent("requested", 11),
      llmEvent("cancelled", 11, "future-cancel-reason"),
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 12 },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.items).toHaveLength(1);
    const activity = state.items[0];
    if (activity?.kind !== "activity") throw new Error("expected activity item");
    expect(activity.steps[0]).toMatchObject({
      kind: "llm",
      status: "done",
      outcome: "cancelled",
      cancelReason: "interrupted-by-user-input",
      durationMs: 1_000,
    });
    expect(activity.steps[1]).toMatchObject({ outcome: "cancelled" });
    expect(summarizeAgentUiActivity(activity).outcome).toBe("failed");
  });

  test("classifies crash recovery and preserves the first settled fact", () => {
    const state = reduceAll([
      llmEvent("requested", 1),
      llmEvent("cancelled", 1),
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", content: "and check the logs" },
      },
      { type: "events.iterate.com/agents/web-message-sent", payload: { message: "deferred" } },
      llmEvent("completed", 1),
      llmEvent("requested", 6),
      llmEvent("completed", 6),
      llmEvent("cancelled", 6),
      {
        type: "events.iterate.com/agent/status-changed",
        payload: { busy: false, sinceOffset: 8 },
      },
    ]);

    const activity = state.items[0];
    if (activity?.kind !== "activity") throw new Error("expected activity item");
    expect(state.items.map((item) => item.kind)).toEqual(["activity", "assistant", "user"]);
    expect(state.items[2]).toMatchObject({ text: "and check the logs" });
    expect(activity.steps).toMatchObject([
      { outcome: "cancelled", cancelReason: "durable-object-crashed" },
      { outcome: "completed" },
    ]);
    expect(summarizeAgentUiActivity(activity)).toMatchObject({
      outcome: "recovered",
      requestCount: 1,
      retryCount: 1,
    });
  });

  test("tallies token-usage reports and tracks the latest as context fullness", () => {
    // Payload shapes mirror the contract's payloads exactly — the reducer
    // reads by key, so made-up fields would pass silently and never catch
    // drift.
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/token-usage-reported",
        payload: {
          llmRequestOffset: 3,
          model: "openai/gpt-5.5",
          maxContextTokens: 272_000,
          inputTokens: 1_000,
          outputTokens: 50,
          cachedInputTokens: 800,
          reasoningOutputTokens: 10,
        },
      },
      // A model without the cache/reasoning breakdown still tallies.
      {
        type: "events.iterate.com/agent/token-usage-reported",
        payload: {
          llmRequestOffset: 7,
          model: "@cf/test/totals-only-model",
          maxContextTokens: 256_000,
          inputTokens: 2_000,
          outputTokens: 150,
        },
      },
    ]);

    expect(state.tokenUsage).toEqual({
      totalInputTokens: 3_000,
      totalOutputTokens: 200,
      totalCachedInputTokens: 800,
      totalReasoningOutputTokens: 10,
      lastReport: {
        model: "@cf/test/totals-only-model",
        maxContextTokens: 256_000,
        inputTokens: 2_000,
        outputTokens: 150,
      },
    });
    // Usage reports render in the strip, not as feed rows.
    expect(state.items).toHaveLength(0);
  });

  test("a compaction context clears the context-fullness reading but keeps lifetime totals", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/token-usage-reported",
        payload: {
          llmRequestOffset: 3,
          model: "openai/gpt-5.5",
          maxContextTokens: 272_000,
          inputTokens: 140_000,
          outputTokens: 500,
        },
      },
      {
        type: "events.iterate.com/agents/context-added",
        offset: 5,
        payload: {
          role: "developer",
          content: "[Compacted summary.]",
          compaction: { replacesHistoryThrough: 3 },
        },
      },
    ]);

    // The meter must not keep showing the pre-reset fullness after the
    // conversation it measured is gone; totals are lifetime, so they stay.
    expect(state.tokenUsage).toEqual({
      totalInputTokens: 140_000,
      totalOutputTokens: 500,
      totalCachedInputTokens: 0,
      totalReasoningOutputTokens: 0,
      lastReport: null,
    });
  });
});
