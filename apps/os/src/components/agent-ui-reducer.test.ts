// Reducer coverage for the browser-side agent UI processor: a full simulated
// turn — user message, LLM request with streamed thinking + response deltas,
// code execution, completion, assistant reply — must reduce into the chat
// items and live active-work tail the agent feed renders.

import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/ui/components/events/types";
import {
  initialAgentUiState,
  planAgentUiOps,
} from "@iterate-com/ui/components/events/agent-ui-reducer";

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
  const { endState, ops } = planAgentUiOps(initialAgentUiState(), fullEvents);
  // Settled items live in SQLite rows (one op per dense local_index); tests
  // assert over the materialized list the virtualizer would render.
  return { ...endState, items: ops.map((op) => op.item) };
}

describe("agent-ui reducer", () => {
  it("streams thinking and response deltas into the live llm step", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { content: "count the inputs", origin: "web" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          connectionId: "c1",
          llmRequestId: 10,
          sequence: 0,
          chunk: { type: "response.reasoning_summary_text.delta", delta: "Reading the stream" },
        },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          connectionId: "c1",
          llmRequestId: 10,
          sequence: 1,
          chunk: { type: "response.output_text.delta", delta: "const n = await " },
        },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          connectionId: "c1",
          llmRequestId: 10,
          sequence: 2,
          chunk: { type: "response.output_text.delta", delta: "stream.count();" },
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

  it("settles the activity into items when all work completes", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { content: "hi", origin: "web" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 5,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: { executionId: "x1", code: "await stream.read()" },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-completed",
        payload: { executionId: "x1", ok: true, result: 12, durationMs: 400, logs: [] },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          llmRequestId: 5,
          provider: "openai-ws",
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
      durationMs: 400,
    });
  });

  it("keeps running script source and start time in the live activity", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: { executionId: "x1", code: "await itx.repo.readFile({ path: 'README.md' })" },
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

  it("keeps the live indicator while a running script emits chat messages", () => {
    const countdownEvents: Array<Partial<Event> & { type: string; payload?: unknown }> = [
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test", requestId: "llm-request:gen-0" },
      },
      {
        type: "events.iterate.com/agent/output-added",
        payload: {
          llmRequestId: 10,
          content:
            "```js\nasync (itx) => {\n  await itx.chat.sendMessage({ message: '20' });\n  await new Promise((resolve) => setTimeout(resolve, 1000));\n}\n```",
        },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: {
          executionId: "agent-output:11",
          code: "async (itx) => {\n  await itx.chat.sendMessage({ message: '20' });\n  await new Promise((resolve) => setTimeout(resolve, 1000));\n}",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: { llmRequestId: 10, result: { status: "success" } },
      },
      {
        type: "events.iterate.com/agents/web-message-sent",
        payload: { message: "20" },
      },
    ];
    const running = reduceAll(countdownEvents);

    expect(running.items).toMatchObject([{ kind: "assistant", text: "20" }]);
    expect(running.live?.steps.at(-1)).toMatchObject({
      kind: "code",
      executionId: "agent-output:11",
      status: "running",
    });

    const completed = reduceAll([
      ...countdownEvents,
      {
        type: "events.iterate.com/capability-host/script-execution-completed",
        payload: { executionId: "agent-output:11", ok: true, logs: [] },
      },
    ]);

    expect(completed.live).toBeNull();
    expect(completed.items.map((item) => item.kind)).toEqual(["assistant", "activity"]);
    expect(completed.items[1]).toMatchObject({
      kind: "activity",
      status: "done",
      steps: [
        { kind: "llm", status: "done" },
        { kind: "code", executionId: "agent-output:11", status: "done" },
      ],
    });
  });

  it("streams the itx openai-ws llm-response-chunk frames into the live llm step", () => {
    // itx journals every raw Responses-WS frame as llm-response-chunk
    // ({llmRequestId, sequence, chunk}). Regression guard: the feed once
    // showed only a bare spinner because the reducer ignored these frames.
    const state = reduceAll([
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { content: "count the inputs", origin: "web" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          llmRequestId: 10,
          sequence: 0,
          chunk: { type: "response.reasoning_summary_text.delta", delta: "Reading the stream" },
        },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          llmRequestId: 10,
          sequence: 1,
          chunk: { type: "response.output_text.delta", delta: "const n = await " },
        },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          llmRequestId: 10,
          sequence: 2,
          chunk: { type: "response.output_text.delta", delta: "stream.count();" },
        },
      },
    ]);

    expect(state.live?.steps.at(-1)).toMatchObject({
      kind: "llm",
      status: "running",
      thinkingText: "Reading the stream",
      responseText: "const n = await stream.count();",
    });
  });

  it("accumulates cloudflare-ai chunk deltas", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 3,
        payload: { model: "test-model" },
      },
      {
        type: "events.iterate.com/cloudflare-ai/llm-response-chunk",
        payload: { llmRequestId: 3, sequence: 0, chunk: { response: "Hel" } },
      },
      {
        type: "events.iterate.com/cloudflare-ai/llm-response-chunk",
        payload: { llmRequestId: 3, sequence: 1, chunk: { response: "lo" } },
      },
      {
        type: "events.iterate.com/cloudflare-ai/llm-response-chunk",
        payload: {
          llmRequestId: 3,
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

  it("tracks subscriber presence including processor announcements", () => {
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
                ownedEvents: [{ type: "events.iterate.com/agent/input-added" }],
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

  it("does not show the bootstrap stream wake in the agent feed", () => {
    const state = reduceAll([
      { type: "events.iterate.com/stream/created" },
      { type: "events.iterate.com/stream/woken" },
    ]);

    expect(state.items).toEqual([]);
  });

  it("shows later stream wakes in the agent feed and clears presence", () => {
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

  it("shows child stream creation events in the agent feed", () => {
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

  it("settles a completed LLM request even without an assistant message", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          llmRequestId: 7,
          provider: "openai-ws",
          durationMs: 250,
          result: { status: "success" },
        },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.items.map((item) => item.kind)).toEqual(["activity"]);
    const activity = state.items[0];
    expect(activity).toMatchObject({ kind: "activity", status: "done" });
    expect(activity?.kind === "activity" ? activity.steps : []).toMatchObject([
      { kind: "llm", llmRequestId: 7, status: "done", outcome: "completed" },
    ]);
  });

  it("does not clear running work from idle status alone", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/status-updated",
        payload: { status: "idle", reason: "request complete" },
      },
    ]);

    expect(state.items).toHaveLength(0);
    expect(state.live).toMatchObject({ kind: "activity", status: "running" });
    expect(state.live?.steps[0]).toMatchObject({ kind: "llm", status: "running" });
  });

  it("queues a user message that arrives mid-turn", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { content: "also, one more thing", origin: "web" },
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

  it("settles queued user messages before the next LLM request starts", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { content: "also, one more thing", origin: "web" },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        payload: {
          llmRequestId: 7,
          provider: "openai-ws",
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
    expect(state.live?.steps[0]).toMatchObject({ kind: "llm", llmRequestId: 12 });
  });

  it("does not append late chunks from an interrupted request into the next turn", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          connectionId: "c1",
          llmRequestId: 7,
          sequence: 0,
          chunk: { type: "response.output_text.delta", delta: "old partial" },
        },
      },
      {
        type: "events.iterate.com/agents/user-message-received",
        payload: { content: "oh this is taking too long", origin: "web" },
      },
      {
        type: "events.iterate.com/agent/llm-request-cancelled",
        payload: {
          phase: "requested",
          llmRequestId: 7,
          reason: "interrupted-by-user-input",
        },
      },
      {
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        payload: {
          connectionId: "c1",
          llmRequestId: 7,
          sequence: 1,
          chunk: { type: "response.output_text.delta", delta: " stale chunk" },
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
      llmRequestId: 7,
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
      llmRequestId: 12,
      responseText: "",
    });
  });

  it("marks an LLM request cancelled when interrupted", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test" },
      },
      {
        type: "events.iterate.com/agent/llm-request-cancelled",
        payload: {
          phase: "requested",
          llmRequestId: 7,
          reason: "interrupted-by-user-input",
        },
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
    });
  });
});
