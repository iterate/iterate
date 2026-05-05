import { describe, expect, it } from "vitest";
import {
  type ConsumedEvent,
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { WebchatProcessorContract, type WebchatState } from "./contract.ts";
import { createWebchatProcessor } from "./implementation.ts";

describe("createWebchatProcessor", () => {
  it("renders webchat messages into derived agent input rows", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createWebchatProcessor();

    await processor.implementation.afterAppend?.({
      event: consumedWebchatEvent({
        type: "events.iterate.com/webchat/user-message-added",
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
          "stream-processor:webchat:event-type-explainer:events.iterate.com/webchat/user-message-added",
        payload: {
          content:
            "First `events.iterate.com/webchat/user-message-added` event. This represents a message received from the webchat user.",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: "stream-processor:webchat:derived:render-message:/agents/test:42",
        payload: {
          content:
            "```yaml\nevent:\n  offset: 42\n  type: events.iterate.com/webchat/user-message-added\n  content: |-\n    hello\n```",
        },
      },
    ]);
  });

  it("renders webchat responses without triggering another LLM request", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createWebchatProcessor();

    await processor.implementation.afterAppend?.({
      event: consumedWebchatEvent({
        type: "events.iterate.com/webchat/agent-response-added",
        payload: { message: "hello back" },
        offset: 43,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended.at(-1)).toEqual({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "stream-processor:webchat:derived:render-response:/agents/test:43",
      payload: {
        content:
          "```yaml\nevent:\n  offset: 43\n  type: events.iterate.com/webchat/agent-response-added\n  message: |-\n    hello back\n```",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    });
  });
});

function registeredState(): WebchatState {
  return {
    ...getInitialProcessorState(WebchatProcessorContract),
    hasRegisteredCurrentVersion: true,
  };
}

function testStreamApi(args: {
  appended: StreamEventInput[];
}): ProcessorStreamApi<typeof WebchatProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent(event);
    },
    read: async () => [],
    subscribe: async function* () {},
  };
}

function consumedWebchatEvent<T extends ConsumedEvent<typeof WebchatProcessorContract>>(args: {
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
