// Reducer coverage for the browser-side agent UI fold: a full simulated
// turn — user message, LLM request with streamed thinking + response deltas,
// code execution, completion, assistant reply — must reduce into the chat
// items and live active-work tail the agent feed renders.

import { describe, expect, test } from "vitest";
import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import type { Event } from "@iterate-com/ui/components/events/types";
import {
  AGENT_UI_PROVISIONAL_ACTIVITY_LIMIT,
  deriveAgentUiLiveStatus,
  initialAgentUiState,
  reduceAgentUi,
  reduceAgentUiRuntime,
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

function projectRuntime(
  reduced: ReturnType<typeof reduceAll>,
  sinceOffset: number,
  runtime: AgentRuntime = ZERO_AGENT_RUNTIME,
) {
  const projected = reduceAgentUiRuntime(reduced, {
    runtime,
    sinceOffset,
    since: new Date(Date.parse("2026-06-11T00:00:00.000Z") + sinceOffset * 1_000).toISOString(),
  });
  return { ...projected.endState, items: [...reduced.items, ...projected.items] };
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
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 0,
          chunks: [{ choices: [{ delta: { reasoning_content: "Reading the stream" } }] }],
        },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 1,
          chunks: [{ choices: [{ delta: { content: "const n = await " } }] }],
        },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 2,
          chunks: [{ choices: [{ delta: { content: "stream.count();" } }] }],
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

  test("streams coalesced multi-chunk windows (llm-response-chunks) into the live llm step", () => {
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
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 0,
          chunks: [
            { choices: [{ delta: { reasoning_content: "Reading the stream" } }] },
            { choices: [{ delta: { content: "const n = await " } }] },
          ],
        },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 1,
          chunks: [{ choices: [{ delta: { content: "stream.count();" } }] }],
        },
      },
    ]);

    expect(state.live?.steps[0]).toMatchObject({
      kind: "llm",
      status: "running",
      thinkingText: "Reading the stream",
      responseText: "const n = await stream.count();",
      // One entry per window whose chunks carried response text — the UI's
      // token-reveal stagger animates each window as a unit.
      responseWindows: ["const n = await ", "stream.count();"],
    });
  });

  test("committed assistant text extends streamed windows when the tail flush was lost", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", actor: { type: "user", origin: "web" }, content: "go" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 0,
          chunks: [{ choices: [{ delta: { content: "The lighthouse" } }] }],
        },
      },
      // The tail flush was swallowed; the committed assistant item carries
      // the full text the windows never received.
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "assistant", content: "The lighthouse keeper", llmRequestOffset: 10 },
      },
    ]);

    expect(state.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "The lighthouse keeper",
      responseWindows: ["The lighthouse", " keeper"],
    });
  });

  test("a cancelled settle's partialText extends streamed windows with the unflushed tail", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", actor: { type: "user", origin: "web" }, content: "go" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 10,
          sequence: 0,
          chunks: [{ choices: [{ delta: { content: "The lighthouse" } }] }],
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
      responseWindows: ["The lighthouse", " keeper"],
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

  test("stamps the summary activity onto the running code step as it lands", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 5,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: { executionId: "x1", code: "await work()", expiresAt: SCRIPT_EXPIRES_AT },
      },
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { title: "FirstFT roundup", activity: "Searching the five most recent emails" },
      },
    ]);

    expect(state.summaryActivity).toBe("Searching the five most recent emails");
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
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: { executionId: "x1", code: "await round1()", expiresAt: SCRIPT_EXPIRES_AT },
      },
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "Running script 1 of 2" },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 1 } },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: { executionId: "x2", code: "await round2()", expiresAt: SCRIPT_EXPIRES_AT },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x2", settlement: { status: "succeeded", result: 2 } },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: { executionId: "x3", code: "await round3()", expiresAt: SCRIPT_EXPIRES_AT },
      },
    ]);

    const codeSteps = state.live?.steps.filter((step) => step.kind === "code");
    expect(codeSteps).toMatchObject([
      { executionId: "x1", activitySummary: "Running script 1 of 2" },
      // x2's script appended no summary — the round's status is whatever the
      // stream's summary said as of that round.
      { executionId: "x2", activitySummary: "Running script 1 of 2" },
      // x3 inherits from BIRTH, so live headers and inferred (deadline/idle)
      // closes carry the status too — not only durable settles.
      { executionId: "x3", status: "running", activitySummary: "Running script 1 of 2" },
    ]);
  });

  test("llm-request-settled succeeded closes the step", () => {
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
        type: "events.iterate.com/agents/web-message-sent",
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
        type: "events.iterate.com/agent/llm-request-settled",
        payload: { requestOffset: 10, result: { status: "succeeded", text: "20" } },
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

    const completed = projectRuntime(
      reduceAll([
        ...countdownEvents,
        {
          type: "events.iterate.com/capability-host/script-run-settled",
          payload: { executionId: "agent-output:11", settlement: { status: "succeeded" } },
        },
      ]),
      20,
    );

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

  // Regression: prod stream agents/web/2026-08-07t15-50-03-269z. The script
  // sent the visible reply (deferred while its code step ran), settled, and
  // the stream went quiet — the journal fold alone must emit the reply, not
  // hold it hostage until a runtime transition or some future event arrives.
  test("flushes a script-sent reply when its script settles and nothing else is running", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
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
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "assistant",
          llmRequestOffset: 10,
          content: "```ts\nasync (itx) => {\n  await itx.chat.sendMessage('grok');\n}\n```",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: { requestOffset: 10, result: { status: "succeeded", text: "…" } },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          executionId: "agent-output:12",
          code: "async (itx) => {\n  await itx.chat.sendMessage('grok');\n}",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
        payload: { message: "I'm using **xai/grok-4.5**." },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "agent-output:12", settlement: { status: "succeeded" } },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.deferredAssistantMessages).toEqual([]);
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
        { kind: "code", executionId: "agent-output:12", status: "done", success: true },
      ],
    });
  });

  test("accumulates agent llm-response-chunks deltas", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 3,
        payload: { model: "test-model" },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: { llmRequestOffset: 3, sequence: 0, chunks: [{ response: "Hel" }] },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: { llmRequestOffset: 3, sequence: 1, chunks: [{ response: "lo" }] },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 3,
          sequence: 2,
          chunks: [{ choices: [{ delta: { reasoning_content: "hmm" } }] }],
        },
      },
    ]);

    expect(state.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "Hello",
      thinkingText: "hmm",
    });
  });

  test("tracks open callback connections including processor announcements", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/stream/connection-opened",
        payload: {
          connectionKey: "agent:agent",
          kind: "hosted",
          openedBy: {
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
        type: "events.iterate.com/stream/connection-opened",
        payload: {
          connectionKey: "browser:tab-1",
          kind: "session",
          openedBy: {
            description: "browser",
            user: {
              id: "usr_jonas",
              email: "jonas@example.com",
              name: "Jonas Temple",
              picture: "https://example.com/jonas.png",
            },
          },
        },
      },
      {
        type: "events.iterate.com/stream/connection-closed",
        payload: { connectionKey: "browser:tab-1", reason: "closed-by-owner" },
      },
    ]);

    expect(state.presence).toHaveLength(2);
    expect(state.presence[0]).toMatchObject({
      connectionKey: "agent:agent",
      connectionKind: "hosted",
      connected: true,
      processor: { slug: "agent", version: "0.1.0" },
    });
    expect(state.presence[1]).toMatchObject({
      connectionKey: "browser:tab-1",
      connectionKind: "session",
      connected: false,
      user: {
        id: "usr_jonas",
        email: "jonas@example.com",
        name: "Jonas Temple",
        picture: "https://example.com/jonas.png",
      },
    });
  });

  test("clears stale opener metadata when a connection key reopens", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/stream/connection-opened",
        payload: {
          connectionKey: "browser:tab-1",
          kind: "session",
          openedBy: {
            description: "browser",
            user: { email: "jonas@example.com", name: "Jonas Temple" },
          },
        },
      },
      {
        type: "events.iterate.com/stream/connection-opened",
        payload: {
          connectionKey: "browser:tab-1",
          kind: "session",
          openedBy: { description: "browser" },
        },
      },
    ]);

    expect(state.presence).toEqual([
      {
        connectionKey: "browser:tab-1",
        connectionKind: "session",
        connected: true,
        description: "browser",
      },
    ]);
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
        type: "events.iterate.com/stream/connection-opened",
        payload: { connectionKey: "agent:agent", kind: "hosted" },
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
    expect(state.presence).toMatchObject([{ connectionKey: "agent:agent", connected: false }]);
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

  test("shows a subtle processor-revived marker without disturbing a live activity", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", actor: { type: "user", origin: "web" }, content: "hi" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 5,
        payload: { model: "gpt-test", expiresAt: Date.parse("2026-06-11T00:10:00.000Z") },
      },
      // The incarnation died mid-turn; the platform revived the processor and
      // the open request was ADOPTED — it settles normally afterwards.
      {
        type: "events.iterate.com/stream/processor-revived",
        payload: { processorSlug: "agent", revivals: 2, version: "test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: {
          requestOffset: 5,
          durationMs: 2100,
          result: { status: "succeeded", text: "hi again" },
        },
      },
    ]);

    // The marker emitted in place; the adopted request still settled as one
    // ordinary completed step — no cancelled/failed outcome from the crash.
    expect(state.items).toContainEqual({
      kind: "processor-revived",
      id: "processor-revived-3",
      processorSlug: "agent",
      revivals: 2,
      timestampMs: Date.parse("2026-06-11T00:00:03.000Z"),
    });
    expect(state.live?.steps[0]).toMatchObject({
      kind: "llm",
      status: "done",
      outcome: "completed",
    });
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

    expect(state.items).toEqual([
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
    ]);
  });

  test("settles a completed LLM request at run-level idle even without an assistant message", () => {
    const state = projectRuntime(
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

  test("makes missing durable completions explicit when run-level idle closes work", () => {
    const state = projectRuntime(
      reduceAll([
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
      ]),
      8,
    );

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
    const requested = {
      type: "events.iterate.com/capability-host/script-run-requested",
      offset: 10,
      payload: {
        executionId: "late-script",
        code: "async () => mutate()",
        expiresAt: SCRIPT_EXPIRES_AT,
      },
    };
    const provisional = projectRuntime(reduceAll([requested]), 10).items.at(-1);
    const corrected = projectRuntime(
      reduceAll([
        requested,
        {
          type: "events.iterate.com/capability-host/script-run-settled",
          offset: 11,
          payload: {
            executionId: "late-script",
            settlement: { status: "succeeded", result: { committed: true } },
          },
        },
      ]),
      11,
    ).items.at(-1);

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
  });

  test("projects several unsettled scripts as one provisional activity", () => {
    const requestedEvents = [
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
    ];
    const state = projectRuntime(
      reduceAll([
        ...requestedEvents,
        {
          type: "events.iterate.com/capability-host/script-run-settled",
          offset: 12,
          payload: { executionId: "late-a", settlement: { status: "succeeded", result: "a" } },
        },
      ]),
      12,
    );

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

  test("treats live state as authoritative when journal projection is newer", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 12,
        payload: { model: "gpt-test" },
      },
    ]);
    const projected = projectRuntime(state, 11);

    expect(projected.live).toBeNull();
    expect(projected.items).toMatchObject([
      { kind: "activity", steps: [{ kind: "llm", status: "done" }] },
    ]);
  });

  test("settles activity from live state after a later non-runtime-changing event", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        offset: 1,
        payload: {
          executionId: "reply-script",
          code: 'async (itx) => itx.chat.sendMessage("kumquat")',
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
        offset: 2,
        payload: { message: "kumquat" },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        offset: 3,
        payload: { executionId: "reply-script", settlement: { status: "succeeded" } },
      },
      {
        type: "events.iterate.com/agents/context-added",
        offset: 4,
        payload: {
          role: "assistant",
          content: "The assistant sent this visible web-chat message: kumquat",
          llmRequestOffset: 99,
        },
      },
    ]);

    const projected = projectRuntime(state, 3);

    expect(projected.live).toBeNull();
    expect(projected.items).toMatchObject([
      { kind: "activity", steps: [{ kind: "code", status: "done", success: true }] },
      { kind: "assistant", text: "kumquat" },
    ]);
  });

  test("bounds provisional corrections when later input closes expired work", () => {
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
            expiresAt: baseMs + requestedOffset * 1_000 + 500,
          },
        },
        {
          type: "events.iterate.com/agents/context-added",
          offset: requestedOffset + 1,
          createdAt: new Date(baseMs + (requestedOffset + 1) * 1_000).toISOString(),
          payload: {
            role: "user",
            actor: { type: "user", origin: "web" },
            content: `next-${index}`,
          },
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

  test("does not append late chunks from an interrupted request into the next turn", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 7,
          sequence: 0,
          chunks: [{ choices: [{ delta: { content: "old partial" } }] }],
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
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 7,
          sequence: 1,
          chunks: [{ choices: [{ delta: { content: " stale chunk" } }] }],
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

  test("groups expired and unrecognized cancellations into one failed activity", () => {
    const state = projectRuntime(
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
    });
    expect(activity.steps[0]).not.toHaveProperty("cancelReason");
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
    });
    expect(state.live?.steps[0]).not.toHaveProperty("inputTokens");
    if (state.live == null) throw new Error("expected live activity");
    expect(summarizeAgentUiActivity(state.live)).toMatchObject({
      outcome: "interrupted",
      requestCount: 1,
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

describe("interpreted responses (userland response formats)", () => {
  test("derived events mark the llm step interpreted; uninterpreted turns stay plain", () => {
    const reduced = reduceAll([
      { type: "events.iterate.com/agent/llm-request-requested", payload: { model: "m" } },
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "assistant",
          content: 'Hi!\n<codemode status="Working">\nreturn 1\n</codemode>',
          llmRequestOffset: 1,
        },
      },
      // The userland interpreter's derived events, in its committed order:
      // the script extracted from the assistant event (offset 2) FIRST — so
      // the code step joins the request's still-open activity — then the
      // extracted prose (marked with the request offset).
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          code: "async (itx) => {\nreturn 1\n}",
          executionId: "agent-output:2",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
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
        type: "events.iterate.com/agents/context-added",
        payload: { role: "assistant", content: "Just prose.", llmRequestOffset: 1 },
      },
    ]);
    const plainStep = plain.live?.steps.find((step) => step.kind === "llm");
    expect(plainStep).toMatchObject({ assistantEventOffset: 2 });
    expect(plainStep).not.toHaveProperty("interpreted");
  });

  test("a classic fenced turn's extracted script also marks its step interpreted", () => {
    const reduced = reduceAll([
      { type: "events.iterate.com/agent/llm-request-requested", payload: { model: "m" } },
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "assistant",
          content: "```ts\nasync (itx) => 1\n```",
          llmRequestOffset: 1,
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          code: "async (itx) => 1",
          executionId: "agent-output:2",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
    ]);
    expect(reduced.live?.steps.find((step) => step.kind === "llm")).toMatchObject({
      interpreted: true,
    });
  });
});

describe("interpreted turn grouping", () => {
  test("script-before-prose keeps the whole turn in ONE activity, rounds paired", () => {
    const reduced = reduceAll([
      { type: "events.iterate.com/agent/llm-request-requested", payload: { model: "m" } },
      {
        type: "events.iterate.com/agents/context-added",
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
      // Userland order: script first (joins the request's activity), prose
      // second (defers — the activity is now working again).
      {
        type: "events.iterate.com/capability-host/script-run-requested",
        payload: {
          code: "async (itx) => 1",
          executionId: "agent-output:2",
          expiresAt: SCRIPT_EXPIRES_AT,
        },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
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
});

describe("live status derivation", () => {
  const request = { type: "events.iterate.com/agent/llm-request-requested", payload: {} };
  const requestSettled = (requestOffset: number) => ({
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset, result: { status: "succeeded", text: "await work()" } },
  });
  const scriptRequested = (executionId: string) => ({
    type: "events.iterate.com/capability-host/script-run-requested",
    payload: { executionId, code: "await work()", expiresAt: SCRIPT_EXPIRES_AT },
  });

  test("phases follow the running step: waiting → thinking → writing → running", () => {
    const waiting = reduceAll([{ ...request, offset: 5 }]);
    expect(deriveAgentUiLiveStatus(waiting)).toMatchObject({ phase: "waiting", statusText: null });

    const thinking = reduceAll([
      { ...request, offset: 5 },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 5,
          sequence: 0,
          chunks: [{ choices: [{ delta: { reasoning_content: "hmm" } }] }],
        },
      },
    ]);
    expect(deriveAgentUiLiveStatus(thinking)).toMatchObject({ phase: "thinking" });

    const writing = reduceAll([
      { ...request, offset: 5 },
      {
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: {
          llmRequestOffset: 5,
          sequence: 0,
          chunks: [{ choices: [{ delta: { content: "await work()" } }] }],
        },
      },
    ]);
    expect(deriveAgentUiLiveStatus(writing)).toMatchObject({ phase: "writing" });

    const running = reduceAll([{ ...request, offset: 5 }, scriptRequested("x1")]);
    expect(deriveAgentUiLiveStatus(running)).toMatchObject({ phase: "running" });
  });

  test("a script that durably settled WITH a value means another round: processing", () => {
    const state = reduceAll([
      { ...request, offset: 5 },
      requestSettled(5),
      scriptRequested("x1"),
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 42 } },
      },
    ]);
    expect(deriveAgentUiLiveStatus(state)).toMatchObject({ phase: "processing" });
    // A value-less settle (`return;`) ends the turn — no round is owed.
    const returned = reduceAll([
      { ...request, offset: 5 },
      requestSettled(5),
      scriptRequested("x1"),
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded" } },
      },
    ]);
    expect(deriveAgentUiLiveStatus(returned)).toMatchObject({ phase: "working" });
    // A failed settle isn't a promise of another round either.
    const failed = reduceAll([
      { ...request, offset: 5 },
      requestSettled(5),
      scriptRequested("x1"),
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: {
          executionId: "x1",
          settlement: {
            status: "failed",
            error: "boom",
            failureKind: "runtime",
            phase: "execution",
            executionMayHaveOccurred: true,
            cancellation: "not-applicable",
          },
        },
      },
    ]);
    expect(deriveAgentUiLiveStatus(failed)).toMatchObject({ phase: "working" });
  });

  test("statusText is this turn's summary only — a previous turn's text stays generic", () => {
    const turnOne = [
      { ...request, offset: 5 },
      requestSettled(5),
      scriptRequested("x1"),
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "Sweeping March refunds" },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 1 } },
      },
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
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", actor: { type: "user", origin: "web" }, content: "and April?" },
      },
      { ...request, offset: 50 },
    ]);
    expect(turnTwo.summaryActivity).toBe("Sweeping March refunds");
    expect(deriveAgentUiLiveStatus(turnTwo)).toMatchObject({ phase: "waiting", statusText: null });

    const turnTwoUpdated = reduceAll([
      ...turnOne,
      {
        type: "events.iterate.com/agents/context-added",
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
      scriptRequested("x1"),
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 42 } },
      },
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
      scriptRequested("x1"),
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 42 } },
      },
    ]);
    expect(state.paused).toBe(true);
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
    expect(resumed.paused).toBe(false);
  });
});

describe("summary updates racing settlement", () => {
  const request = (offset: number) => ({
    type: "events.iterate.com/agent/llm-request-requested",
    offset,
    payload: {},
  });
  const requestSettled2 = (requestOffset: number) => ({
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset, result: { status: "succeeded", text: "await work()" } },
  });
  const scriptRequested2 = (executionId: string) => ({
    type: "events.iterate.com/capability-host/script-run-requested",
    payload: { executionId, code: "await work()", expiresAt: SCRIPT_EXPIRES_AT },
  });

  test("a status append that lands just after the deferred-flush settle still reaches the card", () => {
    // The on-device weave: the script batches its status append with a
    // sendMessage and a value-less return via Promise.all, so the
    // summary-updated event can journal AFTER script-run-settled — which
    // already settled the activity to flush the deferred reply. The late
    // status must still land on the just-settled card (re-emitted as a
    // same-id correction), not evaporate.
    const state = reduceAll([
      request(5),
      requestSettled2(5),
      scriptRequested2("x1"),
      {
        type: "events.iterate.com/agents/web-message-sent",
        payload: { message: "All done." },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded" } },
      },
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "Extracting the voice brief" },
      },
    ]);
    expect(state.live).toBeNull();
    const activities = state.items.filter((item) => item.kind === "activity");
    expect(activities.at(-1)).toMatchObject({
      status: "done",
      steps: [{ kind: "llm" }, { kind: "code", activitySummary: "Extracting the voice brief" }],
    });
  });

  test("a status append during the processing gap reaches the settled step", () => {
    // Between a value-returning script settling and the next request
    // journaling, the activity is live but nothing runs — a status append
    // here previously stamped nothing.
    const state = reduceAll([
      request(5),
      requestSettled2(5),
      scriptRequested2("x1"),
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded", result: 42 } },
      },
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "Extracting the voice brief" },
      },
    ]);
    expect(state.live?.steps.at(-1)).toMatchObject({
      kind: "code",
      status: "done",
      activitySummary: "Extracting the voice brief",
    });
  });

  test("the correction window closes at the next turn: a later status leaves old cards alone", () => {
    const state = reduceAll([
      request(5),
      requestSettled2(5),
      scriptRequested2("x1"),
      {
        type: "events.iterate.com/agents/web-message-sent",
        payload: { message: "All done." },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        payload: { executionId: "x1", settlement: { status: "succeeded" } },
      },
      // The next turn begins…
      {
        type: "events.iterate.com/agents/context-added",
        payload: { role: "user", actor: { type: "user", origin: "web" }, content: "next" },
      },
      // …so this status belongs to the NEW turn, not the settled card.
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "A totally different job" },
      },
    ]);
    const activities = state.items.filter((item) => item.kind === "activity");
    expect(activities.at(-1)!.steps.at(-1)).not.toMatchObject({
      activitySummary: "A totally different job",
    });
  });
});
