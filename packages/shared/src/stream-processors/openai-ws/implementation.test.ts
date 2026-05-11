import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ConsumedEvent,
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { OpenAiWsProcessorContract, type OpenAiWsState } from "./contract.ts";
import {
  createOpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "./implementation.ts";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

describe("createOpenAiWsProcessor", () => {
  it("continues WebSocket request work through waitUntil when a runner provides it", async () => {
    const appended: StreamEventInput[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    let resolveSocket: ((socket: FakeOpenAiResponsesWebSocket) => void) | undefined;
    const socketPromise = new Promise<FakeOpenAiResponsesWebSocket>((resolve) => {
      resolveSocket = resolve;
    });
    const processor = createOpenAiWsProcessor({
      openResponsesWebSocket: async () => await socketPromise,
    });

    const afterAppend = processor.implementation.afterAppend?.({
      event: consumedOpenAiEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: llmRequestPayload("background"),
        offset: 7,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
      waitUntil: (promise) => {
        waitUntilPromises.push(promise);
      },
    });

    await afterAppend;
    expect(waitUntilPromises).toHaveLength(1);
    expect(appended).toEqual([]);

    const socket = new FakeOpenAiResponsesWebSocket();
    resolveSocket?.(socket);
    await waitFor(() => socket.sent.length === 0);
    socket.open();
    await waitFor(() => socket.sent.length === 1);
    completeResponse(socket, {
      delta: "BACKGROUND",
      responseId: "resp_background",
    });
    await Promise.all(waitUntilPromises);

    expect(eventTypes(appended)).toContain("events.iterate.com/agent/output-added");
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/llm-request-completed");
  });

  it("keeps the official Responses WebSocket client open across sequential requests", async () => {
    const appended: StreamEventInput[] = [];
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = createOpenAiWsProcessor({
      openResponsesWebSocket: async () => {
        const socket = new FakeOpenAiResponsesWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const firstRequest = processor.implementation.afterAppend?.({
      event: consumedOpenAiEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: llmRequestPayload("first"),
        offset: 11,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    sockets[0]?.receive({
      type: "response.output_text.delta",
      delta: "FIRST",
    });
    sockets[0]?.receive({
      type: "response.completed",
      response: { id: "resp_first", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    await firstRequest;

    const secondRequest = processor.implementation.afterAppend?.({
      event: consumedOpenAiEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: llmRequestPayload("second"),
        offset: 22,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    await waitFor(() => sockets[0]?.sent.length === 2);
    sockets[0]?.receive({
      type: "response.output_text.delta",
      delta: "SECOND",
    });
    sockets[0]?.receive({
      type: "response.completed",
      response: { id: "resp_second", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    await secondRequest;

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/websocket-connected");
    expect(eventTypes(appended)).not.toContain(
      "events.iterate.com/openai-ws/websocket-disconnected",
    );
    expect(
      appended.filter((event) => event.type === "events.iterate.com/openai-ws/websocket-connected"),
    ).toHaveLength(1);
    expect(
      appended.filter(
        (event) => event.type === "events.iterate.com/openai-ws/websocket-message-sent",
      ),
    ).toHaveLength(2);
    expect(sockets[0]?.sent[1]).toMatchObject({
      previous_response_id: "resp_first",
    });
  });

  it("opens a fresh Responses WebSocket after the runner instance wakes without closure state", async () => {
    const appended: StreamEventInput[] = [];
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const deps = {
      openResponsesWebSocket: async () => {
        const socket = new FakeOpenAiResponsesWebSocket();
        sockets.push(socket);
        return socket;
      },
    };

    const firstProcessor = createOpenAiWsProcessor(deps);
    const firstRequest = firstProcessor.implementation.afterAppend?.({
      event: consumedOpenAiEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: llmRequestPayload("first"),
        offset: 11,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], {
      delta: "FIRST",
      responseId: "resp_first",
    });
    await firstRequest;

    const secondProcessorAfterWake = createOpenAiWsProcessor(deps);
    const secondRequest = secondProcessorAfterWake.implementation.afterAppend?.({
      event: consumedOpenAiEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: llmRequestPayload("second"),
        offset: 22,
      }),
      previousState: stateWithRequest({ llmRequestId: 11, status: "completed" }),
      state: stateWithRequest({ llmRequestId: 11, status: "completed" }),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    await waitFor(() => sockets.length === 2);
    sockets[1]?.open();
    await waitFor(() => sockets[1]?.sent.length === 1);
    completeResponse(sockets[1], {
      delta: "SECOND",
      responseId: "resp_second",
    });
    await secondRequest;

    const connectedEvents = appended.filter(
      (event) => event.type === "events.iterate.com/openai-ws/websocket-connected",
    );
    expect(sockets).toHaveLength(2);
    expect(connectedEvents).toHaveLength(2);
    expect(connectionIds(connectedEvents)).toHaveLength(2);
    expect(new Set(connectionIds(connectedEvents)).size).toBe(2);
  });

  it("retries a started request after wake and emits a distinct physical connection event", async () => {
    const appended: StreamEventInput[] = [];
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processorAfterWake = createOpenAiWsProcessor({
      openResponsesWebSocket: async () => {
        const socket = new FakeOpenAiResponsesWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const request = processorAfterWake.implementation.afterAppend?.({
      event: consumedOpenAiEvent({
        type: "events.iterate.com/agent/llm-request-requested",
        payload: llmRequestPayload("retry me"),
        offset: 33,
      }),
      previousState: stateWithRequest({ llmRequestId: 33, status: "started" }),
      state: stateWithRequest({ llmRequestId: 33, status: "started" }),
      streamApi: testStreamApi({ appended }),
      signal: new AbortController().signal,
    });

    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], {
      delta: "RETRIED",
      responseId: "resp_retried",
    });
    await request;

    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/websocket-connected");
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/llm-request-started");
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/llm-request-completed");
  });
});

function registeredState(): OpenAiWsState {
  return {
    ...getInitialProcessorState(OpenAiWsProcessorContract),
    hasRegisteredCurrentVersion: true,
    model: "gpt-test",
  };
}

function stateWithRequest(args: {
  llmRequestId: number;
  status: "started" | "completed";
}): OpenAiWsState {
  return {
    ...registeredState(),
    requests: {
      [String(args.llmRequestId)]: { status: args.status },
    },
  };
}

function llmRequestPayload(content: string) {
  return {
    model: "ignored-provider-owned-model",
    body: {
      messages: [
        { role: "system" as const, content: "You are terse." },
        { role: "user" as const, content },
      ],
    },
    runOpts: {},
  };
}

function testStreamApi(args: {
  appended: StreamEventInput[];
}): ProcessorStreamApi<typeof OpenAiWsProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent(event);
    },
    appendBatch: async ({ events }) => {
      const appendedEvents: StreamEvent[] = [];
      for (const event of events) {
        args.appended.push(event);
        appendedEvents.push(committedEvent(event));
      }
      return appendedEvents;
    },
    read: async () => [],
    subscribe: async function* () {},
  };
}

function consumedOpenAiEvent<T extends ConsumedEvent<typeof OpenAiWsProcessorContract>>(args: {
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

function eventTypes(events: StreamEventInput[]): string[] {
  return events.map((event) => event.type);
}

function connectionIds(events: StreamEventInput[]) {
  return events.map((event) => {
    const payload = event.payload as { connectionId: string };
    return payload.connectionId;
  });
}

function completeResponse(
  socket: FakeOpenAiResponsesWebSocket | undefined,
  args: { delta: string; responseId: string },
) {
  socket?.receive({
    type: "response.output_text.delta",
    delta: args.delta,
  });
  socket?.receive({
    type: "response.completed",
    response: { id: args.responseId, usage: { input_tokens: 1, output_tokens: 1 } },
  });
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for condition.");
}

class FakeOpenAiResponsesWebSocket implements OpenAiResponsesWebSocket {
  readonly url = new URL("wss://api.openai.test/v1/responses");
  readonly socket = { readyState: 0 };
  readonly sent: JsonValue[] = [];
  closed = false;
  #messages: OpenAiResponsesWebSocketStreamMessage[] = [{ type: "connecting" }];
  #waiters: Array<(result: IteratorResult<OpenAiResponsesWebSocketStreamMessage>) => void> = [];

  send(event: JsonValue): void {
    this.sent.push(event);
  }

  stream(): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
    return this;
  }

  close(): void {
    this.closed = true;
    this.socket.readyState = 3;
    this.#push({ type: "close", code: 1000, reason: "closed by test" });
  }

  open(): void {
    this.socket.readyState = 1;
    this.#push({ type: "open" });
  }

  receive(message: JsonValue): void {
    this.#push({ type: "message", message });
  }

  async next(): Promise<IteratorResult<OpenAiResponsesWebSocketStreamMessage>> {
    const message = this.#messages.shift();
    if (message != null) return { value: message, done: false };

    return await new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async return(): Promise<IteratorReturnResult<undefined>> {
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
    return this;
  }

  #push(message: OpenAiResponsesWebSocketStreamMessage) {
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter({ value: message, done: false });
      return;
    }

    this.#messages.push(message);
  }
}
