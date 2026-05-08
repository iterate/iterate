import { describe, expect, it } from "vitest";
import {
  type ConsumedEvent,
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { AgentChatProcessorContract, type AgentChatState } from "./contract.ts";
import { createAgentChatProcessor } from "./implementation.ts";

describe("createAgentChatProcessor", () => {
  it("renders chat messages into derived agent input rows", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentChatProcessor();

    await processor.implementation.afterAppend?.({
      event: consumedAgentChatEvent({
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: { channel: "tui", content: "woah" },
        offset: 74,
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
          "agent-chat/event-type-explainer/events.iterate.com/agent-chat/user-message-added",
        payload: {
          content:
            "First `events.iterate.com/agent-chat/user-message-added` event. This represents a message received from a chat user.",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: "agent-chat/render-message@74",
        payload: {
          content:
            "```yaml\nevent:\n  offset: 74\n  type: events.iterate.com/agent-chat/user-message-added\n  channel: tui\n  content: |-\n    woah\n```",
        },
      },
    ]);
  });

  it("renders chat responses without triggering another LLM request", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentChatProcessor();

    await processor.implementation.afterAppend?.({
      event: consumedAgentChatEvent({
        type: "events.iterate.com/agent-chat/assistant-response-added",
        payload: { channel: "web", message: "hello back" },
        offset: 43,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended.at(-1)).toEqual({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent-chat/render-response@43",
      payload: {
        content:
          "```yaml\nevent:\n  offset: 43\n  type: events.iterate.com/agent-chat/assistant-response-added\n  channel: web\n  message: |-\n    hello back\n```",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    });
  });

  it("does not repeatedly append event-type explanations after the event type was reduced", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentChatProcessor();

    await processor.implementation.afterAppend?.({
      event: consumedAgentChatEvent({
        type: "events.iterate.com/agent-chat/assistant-response-added",
        payload: { channel: "web", message: "hello back" },
        offset: 43,
      }),
      previousState: {
        ...registeredState(),
        explainedEventTypes: ["events.iterate.com/agent-chat/assistant-response-added"],
      },
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: "agent-chat/render-response@43",
        payload: {
          content:
            "```yaml\nevent:\n  offset: 43\n  type: events.iterate.com/agent-chat/assistant-response-added\n  channel: web\n  message: |-\n    hello back\n```",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      },
    ]);
  });
});

function registeredState(): AgentChatState {
  return {
    ...getInitialProcessorState(AgentChatProcessorContract),
    hasRegisteredCurrentVersion: true,
  };
}

function testStreamApi(args: {
  appended: StreamEventInput[];
}): ProcessorStreamApi<typeof AgentChatProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent(event);
    },
    appendBatch: async ({ events }) => {
      args.appended.push(...events);
      return events.map((event) => committedEvent(event));
    },
    read: async () => [],
    subscribe: async function* () {},
  };
}

function consumedAgentChatEvent<T extends ConsumedEvent<typeof AgentChatProcessorContract>>(args: {
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
