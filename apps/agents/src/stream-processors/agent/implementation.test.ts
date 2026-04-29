import { describe, expect, it } from "vitest";
import {
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "@iterate-com/shared/stream-processors";
import { AgentProcessorContract, type AgentState } from "./contract.ts";
import { createAgentProcessor } from "./implementation.ts";

describe("createAgentProcessor", () => {
  it("renders webchat messages into derived agent input rows", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentProcessor({
      runtime: {
        inflight: () => null,
        scheduleLlmRequest: () => ({ requestId: "req_1" }),
        extendDebounce: () => undefined,
        cancelLlmRequest: () => undefined,
        armCancelDeadline: () => undefined,
      },
    });

    await processor.implementation.afterAppend?.({
      event: committedEvent({
        type: "events.iterate.com/agent/webchat-message-received",
        payload: { content: "hello" },
        offset: 42,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey:
          "stream-processor:agent:event-type-explainer:events.iterate.com/agent/webchat-message-received",
        payload: {
          role: "user",
          content:
            "First `events.iterate.com/agent/webchat-message-received` event. This represents a message received from the webchat user.",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: "stream-processor:agent:derived:render-webchat-message:/agents/test:42",
        payload: {
          role: "user",
          content:
            "```yaml\nevent:\n  offset: 42\n  type: events.iterate.com/agent/webchat-message-received\n  content: |-\n    hello\n```",
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
    subscribe: async function* () {
      return;
    },
  };
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
