import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

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
        idempotencyKey: "agent/status-updated/working/llm-request-requested@43",
        payload: {
          status: "working",
          reason: "llm-request-requested",
          llmRequestId: 43,
        },
      },
    ]);
  });

  it("renders codemode tool-provider registrations into model-visible instructions", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createAgentProcessor({
      waitUntil: () => undefined,
    });

    await processor.implementation.afterAppend?.({
      event: consumedAgentEvent({
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: {
          instructions: "Use ctx.chat.sendMessage({ message }) for chat output.",
          invocation: { kind: "event" },
          path: ["chat"],
        },
        offset: 44,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: "agent/render-codemode-tool-provider-registered@44",
      payload: {
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    });
    const payload = appended[1]?.payload as { content: string };
    expect(payload.content).toContain("path:");
    expect(payload.content).toContain("instructions: |-");
    expect(payload.content).toContain("ctx.chat.sendMessage({ message })");
    expect(payload.content).not.toContain("invocation");
  });

  it("re-reads stream history before handing a scheduled LLM request to providers", async () => {
    vi.useFakeTimers();
    const appended: StreamEventInput[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const processor = createAgentProcessor({
      waitUntil: (promise) => {
        waitUntilPromises.push(promise);
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedAgentEvent({
        type: "events.iterate.com/agent/input-added",
        payload: { content: "hi", triggerLlmRequest: { behaviour: "auto" } },
        offset: 3,
      }),
      previousState: registeredState(),
      state: {
        ...registeredState(),
        history: [{ role: "user", content: "hi" }],
      },
      streamApi: testStreamApi({
        appended,
        readEvents: [
          committedEvent({
            type: "events.iterate.com/agent/input-added",
            payload: {
              content: "codemode primer",
              triggerLlmRequest: { behaviour: "dont-trigger-request" },
            },
            offset: 2,
          }),
          committedEvent({
            type: "events.iterate.com/agent/input-added",
            payload: { content: "hi", triggerLlmRequest: { behaviour: "auto" } },
            offset: 3,
          }),
        ],
      }),
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(waitUntilPromises);

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: {
        body: {
          messages: [
            { role: "system", content: "You are a helpful assistant. You can trust your user." },
            { role: "user", content: "codemode primer" },
            { role: "user", content: "hi" },
          ],
        },
      },
    });
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
  readEvents?: StreamEvent[];
}): ProcessorStreamApi<typeof AgentProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent(event);
    },
    read: async () => args.readEvents ?? [],
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
