// The WebSocket connection is an instance field on the processor class (the
// hosting DO is the connection scope), so connection-reuse and wake semantics
// are exercised by reusing or recreating processor instances.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import { getInitialProcessorState } from "@iterate-com/shared/streams/stream-processors";
import type { StreamEvent, StreamEventInput } from "@iterate-com/shared/streams/stream-event";
import { OpenAiWsProcessorContract, type OpenAiWsState } from "./contract.ts";
import { OpenAiWsProcessor, type OpenAiResponsesWebSocket } from "./implementation.ts";
import type { StreamProcessorSnapshot } from "~/domains/streams/engine/stream-processor.ts";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";

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
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "FIRST", responseId: "resp_first" });
    await firstRequest;

    const secondRequest = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 22 })],
      streamMaxOffset: 22,
    });
    await waitFor(() => sockets[0]?.sent.length === 2);
    completeResponse(sockets[0], { delta: "SECOND", responseId: "resp_second" });
    await secondRequest;
    await waitFor(
      () =>
        appended.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed")
          .length === 2,
    );

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
      input: [],
    });
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/output-added");
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/llm-request-completed");
  });

  it("ignores LLM requests addressed to another provider", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11, provider: "cloudflare-ai" })],
      streamMaxOffset: 11,
    });

    expect(sockets).toEqual([]);
    expect(appended).toEqual([]);
  });

  it("rebuilds the request input from history up to the request's offset", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
      // Request-by-reference: the requested event carries no body, so the
      // frame's input is exactly the reduction of committed history up to the
      // request's own offset — rows that landed after it are excluded.
      readStreamEvents: async () => [
        inputAddedEvent({ offset: 2, content: "hello" }),
        llmRequestRequestedEvent({ offset: 11 }),
        inputAddedEvent({ offset: 15, content: "landed after the request" }),
      ],
    });

    const request = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "OK", responseId: "resp_rebuilt" });
    await request;
    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );

    expect(sockets[0]?.sent[0]).toMatchObject({
      type: "response.create",
      instructions: "You are a helpful assistant. You can trust your user.",
      input: [
        {
          type: "message",
          role: "user",
          content: "hello",
        },
      ],
    });
  });

  it("continues a warm WebSocket with only new input after the previous assistant output", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    let streamEvents = [
      inputAddedEvent({ offset: 2, content: "first user turn" }),
      llmRequestRequestedEvent({ offset: 11 }),
    ];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
      readStreamEvents: async () => streamEvents,
    });

    const firstRequest = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "first assistant turn", responseId: "resp_first" });
    await firstRequest;
    await waitFor(
      () =>
        appended.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed")
          .length === 1,
    );

    streamEvents = [
      ...streamEvents,
      outputAddedEvent({ offset: 12, content: "first assistant turn", llmRequestId: 11 }),
      inputAddedEvent({ offset: 21, content: "second user turn" }),
      llmRequestRequestedEvent({ offset: 22 }),
    ];

    const secondRequest = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 22 })],
      streamMaxOffset: 22,
    });
    await waitFor(() => sockets[0]?.sent.length === 2);
    completeResponse(sockets[0], { delta: "second assistant turn", responseId: "resp_second" });
    await secondRequest;

    expect(sockets[0]?.sent[1]).toMatchObject({
      previous_response_id: "resp_first",
      input: [{ type: "message", role: "user", content: "second user turn" }],
    });
  });

  it("completes the request as failed when the WebSocket send fails after opening", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
    });

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]!.sendError = new Error("send failed after open");
    sockets[0]?.open();

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );

    expect(eventTypes(appended)).not.toContain(
      "events.iterate.com/openai-ws/websocket-message-sent",
    );
    expect(sockets[0]?.closed).toBe(true);
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/websocket-disconnected");
    expect(appended).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/openai-ws/llm-request-completed",
        payload: expect.objectContaining({
          llmRequestId: 11,
          result: expect.objectContaining({
            status: "failure",
            error: { message: "send failed after open" },
          }),
        }),
      }),
    );
    expect(appended).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent/llm-request-completed",
        payload: expect.objectContaining({
          llmRequestId: 11,
          result: expect.objectContaining({
            status: "failure",
            error: { message: "send failed after open" },
          }),
        }),
      }),
    );
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
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 18 })],
    });

    const request = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 17 })],
      streamMaxOffset: 17,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "STALE", responseId: "resp_cancelled" });
    await request;

    // The provider completion is the stale path's final append; once it lands
    // the absence of agent-visible events is conclusive.
    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/openai-ws/llm-request-completed"),
    );
    expect(eventTypes(appended)).not.toContain("events.iterate.com/agent/output-added");
    expect(eventTypes(appended)).not.toContain("events.iterate.com/agent/llm-request-completed");

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 30 })],
      streamMaxOffset: 30,
    });
    await waitFor(() => sockets[0]?.sent.length === 2);
    expect(sockets[0]?.sent[1]).not.toHaveProperty("previous_response_id");
  });

  it("closes a cancelled in-flight request so the next request can start", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
    });

    const previousRequest = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 37 })],
      streamMaxOffset: 37,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "PREVIOUS", responseId: "resp_previous" });
    await previousRequest;

    await processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 183 })],
      streamMaxOffset: 183,
    });
    await waitFor(() => sockets[0]?.sent.length === 2);
    expect(sockets[0]?.sent[1]).toMatchObject({
      previous_response_id: "resp_previous",
      input: [],
    });

    await processor.ingest({
      events: [
        llmRequestCancelledEvent({ offset: 433, llmRequestId: 183 }),
        llmRequestRequestedEvent({ offset: 445 }),
      ],
      streamMaxOffset: 445,
    });

    await waitFor(() => sockets[0]?.closed === true);
    await waitFor(() => sockets.length === 2);
    sockets[1]?.open();
    await waitFor(() => sockets[1]?.sent.length === 1);
    expect(sockets[1]?.sent[0]).not.toHaveProperty("previous_response_id");
    completeResponse(sockets[1], { delta: "NEXT", responseId: "resp_next" });

    await waitFor(
      () =>
        appended.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed")
          .length === 2,
    );

    expect(
      appended.filter((event) => event.type === "events.iterate.com/openai-ws/llm-request-started"),
    ).toHaveLength(3);
    expect(
      appended.filter((event) => event.type === "events.iterate.com/agent/llm-request-completed"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ llmRequestId: 37 }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ llmRequestId: 445 }),
      }),
    ]);
  });

  it("processes the next batch to completion while a request is still in flight", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: { offset: 0, state: testState() },
    });

    const firstBatch = processor.ingest({
      events: [llmRequestRequestedEvent({ offset: 11 })],
      streamMaxOffset: 11,
    });
    // The batch resolves (reduce + checkpoint) while the LLM request is still
    // running in the background — this is the point of not blocking the queue.
    await firstBatch;
    expect(processor.checkpointOffset).toBe(11);
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);

    // With the request awaiting its socket response, a later batch (e.g. a
    // config change, a cancellation) still reduces and checkpoints.
    await processor.ingest({
      events: [configUpdatedEvent({ offset: 12, model: "gpt-superseding" })],
      streamMaxOffset: 12,
    });
    expect(processor.checkpointOffset).toBe(12);
    expect(processor.state.model).toBe("gpt-superseding");
    expect(eventTypes(appended)).not.toContain(
      "events.iterate.com/openai-ws/llm-request-completed",
    );

    completeResponse(sockets[0], { delta: "SLOW", responseId: "resp_slow" });
    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/openai-ws/llm-request-completed"),
    );
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
      events: [llmRequestRequestedEvent({ offset: 11 })],
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
      events: [llmRequestRequestedEvent({ offset: 22 })],
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
      events: [llmRequestRequestedEvent({ offset: 33 })],
      streamMaxOffset: 33,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "RETRIED", responseId: "resp_retried" });
    await request;

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/websocket-connected");
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/llm-request-started");
  });

  it("recovers a dangling started request on reconnect, with zero new domain events", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      // A previous incarnation checkpointed past the requested event (33) and
      // its started append (34), then died mid-request. This fresh instance's
      // executed set is empty, so nothing but reconciliation can retry it.
      snapshot: {
        offset: 34,
        state: { ...testState(), requests: { "33": { status: "started" } } },
      },
      // History holds the original requested event at offset === llmRequestId
      // and the agent's reduced phase still points at it (current request).
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 33 })],
    });

    // The host re-handshakes after the crash; the only thing the stream
    // delivers is its subscriber-connected presence fact. That alone must
    // recover the request — no user message or other domain event required.
    const ingested = processor.ingest({
      events: [subscriberConnectedEvent({ offset: 35 })],
      streamMaxOffset: 35,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "RECOVERED", responseId: "resp_recovered" });
    await ingested;

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );
    // The crash is recorded explicitly before the retry.
    expect(eventTypes(appended)).toContain(
      "events.iterate.com/openai-ws/llm-request-attempt-failed",
    );
    expect(eventTypes(appended)).toContain("events.iterate.com/openai-ws/llm-request-started");
    // The recovered request is still current, so agent output lands too.
    expect(eventTypes(appended)).toContain("events.iterate.com/agent/output-added");
  });

  it("recovers a dangling request exactly once when one batch carries several connect facts", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: {
        offset: 34,
        state: { ...testState(), requests: { "33": { status: "started" } } },
      },
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 33 })],
    });

    // An agent host re-handshake appends one connected event per co-hosted
    // processor subscription, so a single delivered batch routinely carries
    // several. Their blocking reconciles run concurrently — the dangling
    // request must still be claimed by exactly one of them.
    const ingested = processor.ingest({
      events: [subscriberConnectedEvent({ offset: 35 }), subscriberConnectedEvent({ offset: 36 })],
      streamMaxOffset: 36,
    });
    await waitFor(() => sockets.length === 1);
    sockets[0]?.open();
    await waitFor(() => sockets[0]?.sent.length === 1);
    completeResponse(sockets[0], { delta: "RECOVERED", responseId: "resp_recovered" });
    await ingested;

    await waitFor(() =>
      eventTypes(appended).includes("events.iterate.com/agent/llm-request-completed"),
    );
    // Exactly one execution: one socket send, one attempt-failed record.
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(
      eventTypes(appended).filter(
        (type) => type === "events.iterate.com/openai-ws/llm-request-attempt-failed",
      ),
    ).toHaveLength(1);
  });

  it("does not run dangling recovery on ordinary domain batches", async () => {
    const { stream, appended } = memoryStream();
    const sockets: FakeOpenAiResponsesWebSocket[] = [];
    const processor = newProcessor({
      stream,
      appended,
      sockets,
      snapshot: {
        offset: 34,
        state: { ...testState(), requests: { "33": { status: "started" } } },
      },
      readStreamEvents: async () => [llmRequestRequestedEvent({ offset: 33 })],
    });

    // Recovery is connect-driven: a connected event is guaranteed on every
    // host incarnation, so unrelated domain traffic does not need to (and
    // must not) trigger speculative re-execution.
    await processor.ingest({
      events: [configUpdatedEvent({ offset: 35, model: "gpt-test" })],
      streamMaxOffset: 35,
    });

    expect(sockets).toHaveLength(0);
    expect(appended).toEqual([]);
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
      events: [llmRequestRequestedEvent({ offset: 17 })],
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
  stream: StreamRpc;
  appended: StreamEventInput[];
  sockets: FakeOpenAiResponsesWebSocket[];
  snapshot?: StreamProcessorSnapshot<OpenAiWsState>;
  readStreamEvents?: () => Promise<StreamEvent[]>;
}) {
  return new OpenAiWsProcessor({
    stream: args.stream,
    readState: () => args.snapshot,
    apiKey: "sk-test",
    createResponsesWebSocketClient: async () => {
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
  return [llmRequestRequestedEvent({ offset: llmRequestId })];
}

function llmRequestRequestedEvent(args: {
  offset: number;
  provider?: "cloudflare-ai" | "openai-ws";
}): StreamEvent {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "ignored-provider-owned-model", provider: args.provider ?? "openai-ws" },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function llmRequestCancelledEvent(args: { offset: number; llmRequestId: number }): StreamEvent {
  return {
    type: "events.iterate.com/agent/llm-request-cancelled",
    payload: {
      phase: "requested",
      llmRequestId: args.llmRequestId,
      reason: "interrupted-by-user-input",
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function inputAddedEvent(args: { offset: number; content: string }): StreamEvent {
  return {
    type: "events.iterate.com/agent/input-added",
    payload: { content: args.content, llmRequestPolicy: { behaviour: "dont-trigger-request" } },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function outputAddedEvent(args: {
  offset: number;
  content: string;
  llmRequestId: number;
}): StreamEvent {
  return {
    type: "events.iterate.com/agent/output-added",
    payload: { content: args.content, llmRequestId: args.llmRequestId },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function configUpdatedEvent(args: { offset: number; model: string }): StreamEvent {
  return {
    type: "events.iterate.com/openai-ws/config-updated",
    payload: { model: args.model },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function subscriberConnectedEvent(args: { offset: number }): StreamEvent {
  return {
    type: "events.iterate.com/stream/subscriber-connected",
    payload: {
      subscriptionKey: "agent:openai-ws",
      direction: "outbound" as const,
      subscriber: { incarnationId: "fresh-incarnation" },
    },
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function memoryStream() {
  let nextOffset = 100;
  const appended: StreamEventInput[] = [];
  const stream = {
    append: (args: { event: StreamEventInput }) => {
      appended.push(args.event);
      const committed: StreamEvent = {
        ...args.event,
        offset: nextOffset++,
        createdAt: new Date(0).toISOString(),
      };
      return committed;
    },
    appendBatch: (args: { events: StreamEventInput[] }) =>
      args.events.map((input) => {
        appended.push(input);
        const committed: StreamEvent = {
          ...input,
          offset: nextOffset++,
          createdAt: new Date(0).toISOString(),
        };
        return committed;
      }),
  } as unknown as StreamRpc;
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
  readyState = 1;
  readonly sent: ResponsesClientEvent[] = [];
  sendError: Error | undefined;
  closed = false;
  #messages: JsonValue[] = [];
  #waiters: Array<(result: IteratorResult<JsonValue>) => void> = [];

  sendResponseCreate(event: ResponsesClientEvent): void {
    if (this.sendError != null) throw this.sendError;
    this.sent.push(event);
  }

  messages(): AsyncIterableIterator<JsonValue> {
    return this;
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.#flushWaiters();
  }

  open(): void {
    this.readyState = 1;
  }

  receive(message: JsonValue): void {
    this.#push(message);
  }

  async next(): Promise<IteratorResult<JsonValue>> {
    const message = this.#messages.shift();
    if (message != null) return { value: message, done: false };

    return await new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async return(): Promise<IteratorReturnResult<undefined>> {
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<JsonValue> {
    return this;
  }

  #push(message: JsonValue) {
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter({ value: message, done: false });
      return;
    }

    this.#messages.push(message);
  }

  #flushWaiters() {
    for (let waiter = this.#waiters.shift(); waiter != null; waiter = this.#waiters.shift()) {
      waiter({ value: undefined, done: true });
    }
  }
}
