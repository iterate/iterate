import { describe, expect, it } from "vitest";
import {
  type ConsumedEvent,
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { AgentProcessorContract, type AgentState } from "./contract.ts";
import { createAgentProcessor } from "./implementation.ts";

describe("createAgentProcessor", () => {
  it("does not schedule LLM work for explicitly non-triggering agent input", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentProcessor({
      waitUntil: () => undefined,
    });

    await processor.implementation.afterAppend?.({
      event: consumedAgentEvent({
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "hello",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
        offset: 42,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([]);
  });

  it("marks requested LLM work as a working status update", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentProcessor({
      waitUntil: () => undefined,
    });

    await processor.implementation.afterAppend?.({
      event: consumedAgentEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          requestId: "req_1",
          model: "test-model",
          body: { messages: [{ role: "user", content: "hello" }] },
          runOpts: {},
        },
        offset: 43,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/agent/status-updated",
        idempotencyKey:
          "stream-processor:agent:derived:status-updated:working:llm-request-requested:/agents/test:43",
        payload: {
          status: "working",
          reason: "llm-request-requested",
          requestId: "req_1",
          llmRequestId: 43,
        },
      },
    ]);
  });
});

function registeredState(): AgentState {
  return {
    ...getInitialProcessorState(AgentProcessorContract),
    hasRegisteredCurrentVersion: true,
  };
}

function testStreamApi(args: {
  appended: StreamEventInput[];
}): ProcessorStreamApi<typeof AgentProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent(event);
    },
    read: async () => [],
    subscribe: async function* () {},
  };
}

function consumedAgentEvent<T extends ConsumedEvent<typeof AgentProcessorContract>>(args: {
  type: T["type"];
  payload: T["payload"];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: number;
}): T {
  return committedEvent(args) as T;
}

function committedEvent(args: {
  type: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: number;
}): StreamEvent {
  return {
    streamPath: "/agents/test",
    type: args.type,
    payload: args.payload,
    metadata: args.metadata,
    idempotencyKey: args.idempotencyKey,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
