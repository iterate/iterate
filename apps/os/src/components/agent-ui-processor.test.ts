// Reducer coverage for the browser-side agent UI processor: a full simulated
// turn — user message, LLM request with streamed thinking + response deltas,
// code execution, completion, assistant reply — must reduce into the clean
// chat shape the agent feed renders (items + live tail).

import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import {
  AgentUiProcessorContract,
  reduceAgentUiEvent,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-processor/contract";
import { getInitialProcessorState } from "@iterate-com/streams/shared/stream-processors";

function reduceAll(events: Array<Partial<Event> & { type: string; payload?: unknown }>) {
  let state = getInitialProcessorState(AgentUiProcessorContract) as AgentUiState;
  let offset = 0;
  for (const partial of events) {
    offset += 1;
    const event = {
      offset: partial.offset ?? offset,
      createdAt: partial.createdAt ?? `2026-06-11T00:00:${String(offset).padStart(2, "0")}.000Z`,
      streamPath: "/agents/test",
      payload: partial.payload ?? {},
      ...partial,
    } as unknown as Event;
    state = reduceAgentUiEvent(state, event);
  }
  return state;
}

describe("agent-ui reducer", () => {
  it("streams thinking and response deltas into the live llm step", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: { channel: "web", content: "count the inputs" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 10,
        payload: { model: "gpt-test", runOpts: {} },
      },
      {
        type: "events.iterate.com/openai-ws/websocket-message-received",
        payload: {
          connectionId: "c1",
          llmRequestId: 10,
          sequence: 0,
          message: { type: "response.reasoning_summary_text.delta", delta: "Reading the stream" },
        },
      },
      {
        type: "events.iterate.com/openai-ws/websocket-message-received",
        payload: {
          connectionId: "c1",
          llmRequestId: 10,
          sequence: 1,
          message: { type: "response.output_text.delta", delta: "const n = await " },
        },
      },
      {
        type: "events.iterate.com/openai-ws/websocket-message-received",
        payload: {
          connectionId: "c1",
          llmRequestId: 10,
          sequence: 2,
          message: { type: "response.output_text.delta", delta: "stream.count();" },
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

  it("settles the activity into items when the assistant responds", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: { channel: "web", content: "hi" },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 5,
        payload: { model: "gpt-test", runOpts: {} },
      },
      {
        type: "events.iterate.com/itx/script-execution-requested",
        payload: { executionId: "x1", code: "await stream.read()" },
      },
      {
        type: "events.iterate.com/itx/script-execution-completed",
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
        type: "events.iterate.com/agent-chat/assistant-response-added",
        payload: { channel: "web", message: "There are 12 inputs." },
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

  it("accumulates cloudflare-ai chunk deltas", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 3,
        payload: { model: "test-model", runOpts: {} },
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
          subscriptionKey: "agent-host:agent",
          direction: "outbound",
          subscriber: {
            incarnationId: "i1",
            processor: {
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
      subscriptionKey: "agent-host:agent",
      connected: true,
      processor: { slug: "agent", version: "0.1.0" },
    });
    expect(state.presence[1]).toMatchObject({ subscriptionKey: "browser:tab-1", connected: false });
  });

  it("settles a running activity when the agent goes idle", () => {
    const state = reduceAll([
      {
        type: "events.iterate.com/agent/llm-request-requested",
        offset: 7,
        payload: { model: "gpt-test", runOpts: {} },
      },
      {
        type: "events.iterate.com/agent/status-updated",
        payload: { status: "idle", reason: "request complete" },
      },
    ]);

    expect(state.live).toBeNull();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "activity", status: "done" });
  });
});
