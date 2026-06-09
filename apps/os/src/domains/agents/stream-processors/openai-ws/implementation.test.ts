// Ported from packages/shared/src/stream-processors/openai-ws/implementation.test.ts
// onto the class-based StreamProcessor model. The WebSocket connection is an
// instance field on the processor class (the hosting DO is the connection
// scope), so connection-reuse and wake semantics are exercised by reusing or
// recreating processor instances.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getInitialProcessorState } from "@iterate-com/streams/shared/stream-processors";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import type {
  StreamProcessorIterateContext,
  StreamProcessorSnapshot,
} from "@iterate-com/streams/stream-processor";
import { OpenAiWsProcessorContract, type OpenAiWsState } from "./contract.ts";
import {
  OpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "./implementation.ts";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

describe("OpenAiWsProcessor", () => {
  it("keeps the Responses WebSocket open across sequential requests", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
    });

    const firstRequest = processor.ingest({
      events: [llmRequestRequestedEvent({ content: "first", offset: 11 })],
      streamMaxOffset: 11,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "FIRST", responseId: "resp_first" });
    await firstRequest;

    const secondRequest = processor.ingest({
      events: [llmRequestRequestedEvent({ content: "second", offset: 22 })],
      streamMaxOffset: 22,
    });
    await waitFor(() => sockets[0]?.sent.length === 2);
    completeResponse(sockets[0], { delta: "SECOND", responseId: "resp_second" });
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
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/output-added");
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/llm-request-completed");
  });

  it("does not append agent output for a cancelled request", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
      // The stream's reduced agent state points at a NEWER request (offset 18),
      // so request 17's output must be dropped.
      readStreamEvents: async () => [
        llmRequestRequestedEvent({ content: "replacement", offset: 18 }),
      ],
    });

    const request = processor.ingest({
      events: [llmRequestRequestedEvent({ content: "cancelled", offset: 17 })],
      streamMaxOffset: 17,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "STALE", responseId: "resp_cancelled" });
    await request;

    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/llm-request-completed");
    expect(eventTypes(appended)).not.toContain("events.iterate.com/agent/output-added");
    expect(eventTypes(appended)).not.toContain("events.iterate.com/agent/llm-request-completed");
  });

  it("opens a fresh Responses WebSocket after the host instance wakes without warm state", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];

    const firstProcessor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
    });
    const firstRequest = firstProcessor.ingest({
      events: [llmRequestRequestedEvent({ content: "first", offset: 11 })],
      streamMaxOffset: 11,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "FIRST", responseId: "resp_first" });
    await firstRequest;

    const processorAfterWake = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: {
        offset: 11,
        state: { ...testState(), requests: { "11": { status: "completed" } } },
      },
    });
    const secondRequest = processorAfterWake.ingest({
      events: [llmRequestRequestedEvent({ content: "second", offset: 22 })],
      streamMaxOffset: 22,
    });
    await waitFor(() => sockets.length === 2);
    sockets[1]?.open();
    await waitFor(() => sockets[1]?.sent.length === 1);
    completeResponse(sockets[1], { delta: "SECOND", responseId: "resp_second" });
    await secondRequest;

    const connectedEvents = appended.filter(
      (event) => event.type === "events.iterate.com/openai-ws/websocket-connected",
    );
    expect(sockets).toHaveLength(2);
    expect(connectedEvents).toHaveLength(2);
    expect(new Set(connectionIds(connectedEvents)).size).toBe(2);
  });

  it("retries a started request after wake and emits a distinct physical connection event", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processorAfterWake = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: {
        offset: 0,
        state: { ...testState(), requests: { "33": { status: "started" } } },
      },
    });

    const request = processorAfterWake.ingest({
      events: [llmRequestRequestedEvent({ content: "retry me", offset: 33 })],
      streamMaxOffset: 33,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "RETRIED", responseId: "resp_retried" });
    await request;

    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/websocket-connected");
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/llm-request-started");
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/llm-request-completed");
  });

  it("skips a request its reduced state already marks completed", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: {
        offset: 0,
        state: { ...testState(), requests: { "17": { status: "completed" } } },
      },
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ content: "already done", offset: 17 })],
      streamMaxOffset: 17,
    });

    expect(sockets).toHaveLength(0);
    expect(appended).toEqual([]);
  });
});

function testState(): OpenAiWsState {
  return {
    ...getInitialProcessorState(OpenAiWsProcessorContract),
    model: "gpt-test",
  };
}

function newProcessor(args: {
  stream: StreamProcessorIterateContext["stream"];
  appended: StreamEventInput[];
  sockets: FakeOpenAiResponsesWebSocket[];
  snapshot?: StreamProcessorSnapshot<OpenAiWsState>;
  readStreamEvents?: () => Promise<StreamEvent[]>;
}) {
  return new OpenAiWsProcessor({
    iterateContext: { stream: args.stream },
    readState: () => args.snapshot,
    openResponsesWebSocket: async () => {
      const socket = new FakeOpenAiResponsesWebSocket();
      args.sockets.push(socket);
      return socket;
    },
    readStreamEvents:
      args.readStreamEvents ?? (async () => currentAgentRequestEvents(args.appended)),
  });
}

/** The agent's reduced state points at the latest request this processor started. */
function currentAgentRequestEvents(appended: readonly StreamEventInput[]): StreamEvent[] {
  const llmRequestId = appended
    .map((event) => (event.payload as { llmRequestId?: unknown }).llmRequestId)
    .findLast((value): value is number => typeof value === "number");
  if (llmRequestId == null) return [];
  return [llmRequestRequestedEvent({ content: "current", offset: llmRequestId })];
}

function llmRequestRequestedEvent(args: { content: string; offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: {
      model: "ignored-provider-owned-model",
      body: {
        messages: [
          { role: "system" as const, content: "You are terse." },
          { role: "user" as const, content: args.content },
        ],
      },
      runOpts: {},
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function memoryStream() {
  let nextOffset = 100;
  const appended: StreamEventInput[] = [];
  const stream: StreamProcessorIterateContext["stream"] = {
    append: (args) => {
      appended.push(args.event);
      const committed: StreamEvent = {
        ...args.event,
        offset: nextOffset++,
        createdAt: new Date(0).toISOString(),
      };
      return committed;
    },
    appendBatch: (args) =>
      args.events.map((input) => {
        appended.push(input);
        const committed: StreamEvent = {
          ...input,
          offset: nextOffset++,
          createdAt: new Date(0).toISOString(),
        };
        return committed;
      }),
  };
  return { stream, appended };
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
