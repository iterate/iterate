import { describe, expect, it } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { AgentProcessorContract, DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-processor-contract.ts";
import { CloudflareAiProcessor } from "./cloudflare-ai-processor-implementation.ts";
import {
  OpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
} from "./openai-ws-processor-implementation.ts";

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    const appended = inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
      };
      this.events.push(event);
      return event;
    });
    return appended;
  }

  at(): Stream {
    return this;
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(): Promise<StreamEvent[]> {
    return [...this.events];
  }

  async waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      for (const event of this.events) {
        if (input.afterOffset !== undefined && event.offset <= input.afterOffset) continue;
        if (input.eventTypes !== undefined && !input.eventTypes.includes(event.type)) continue;
        if (input.predicate !== undefined && !(await input.predicate(event))) continue;
        return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for event");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

type ProcessorLike = {
  ingest(input: { events: StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

async function deliverNewEvents(input: {
  processor: ProcessorLike;
  stream: MemoryStream;
  cursors: Map<object, number>;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  await input.processor.ingest({ events, streamMaxOffset: input.stream.events.length });
}

type FakeResponsesWebSocket = OpenAiResponsesWebSocket & { sent: unknown[] };

/**
 * In-memory OpenAI Responses WebSocket: `sendResponseCreate` computes the
 * response frames for the request and feeds them to the messages iterator.
 */
function fakeResponsesWebSocket(respond: (request: unknown) => unknown[]): FakeResponsesWebSocket {
  const queue: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  const push = (frame: unknown) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value: frame, done: false });
    else queue.push(frame);
  };
  const socket: FakeResponsesWebSocket & { readyState: number } = {
    sent: [],
    readyState: 1,
    sendResponseCreate(event: unknown) {
      socket.sent.push(event);
      for (const frame of respond(event)) push(frame);
    },
    messages(): AsyncIterableIterator<unknown> {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return await new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
        },
      };
    },
    close() {
      socket.readyState = 3;
    },
  };
  return socket;
}

function openAiWsRequestEvents(content: string): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/agent/input-added",
      payload: { content, llmRequestPolicy: { behaviour: "after-current-request" } },
    },
    {
      type: "events.iterate.com/agent/llm-request-scheduled",
      payload: {
        debounceMs: 0,
        model: "gpt-5.5",
        provider: "openai-ws",
        requestId: "llm-request:1",
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-requested",
      payload: { model: "gpt-5.5", provider: "openai-ws", requestId: "llm-request:1" },
    },
  ];
}

function sseStream(...chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("minimal web-chat agent processors", () => {
  it("explains the exact codemode shape expected by the ITX script runner", () => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
      "The code block must contain a single async arrow function: async (itx) => { ... }.",
    );
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("await itx.chat.sendMessage({ message })");
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain("containing an async function");
  });

  it("normalizes web input, requests AI by reference, and turns output into script execution", async () => {
    const stream = new MemoryStream();
    const aiCalls: unknown[] = [];
    const agent = new AgentProcessor({ stream });
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run(_model, body) {
          aiCalls.push(body);
          return {
            response: [
              "```js",
              "async (itx) => {",
              "  await itx.chat.sendMessage({ message: 'hello from ai' });",
              "}",
              "```",
            ].join("\n"),
          };
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();
    const deliver = (processor: ProcessorLike) => deliverNewEvents({ processor, stream, cursors });

    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "hello" },
    });
    await deliver(agent);
    await deliver(agent);
    await deliver(agent);
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(agent);
    await deliver(cloudflareAi);
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(agent);

    expect(stream.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/agents/user-message-received",
        "events.iterate.com/agent/input-added",
        "events.iterate.com/agent/llm-request-scheduled",
        "events.iterate.com/agent/llm-request-requested",
        "events.iterate.com/cloudflare-ai/llm-request-started",
        "events.iterate.com/agent/output-added",
        "events.iterate.com/cloudflare-ai/llm-request-completed",
        "events.iterate.com/agent/llm-request-completed",
        "events.iterate.com/itx/script-execution-requested",
      ]),
    );
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]).toMatchObject({
      stream: true,
      messages: [expect.objectContaining({ role: "system" }), { role: "user", content: "hello" }],
    });
  });

  it("does not fire a second LLM call when a second message arrives during the first request", async () => {
    const stream = new MemoryStream();
    const aiCalls: unknown[] = [];
    let resolveFirstCall!: () => void;
    const firstCallInFlight = new Promise<void>((resolve) => {
      resolveFirstCall = resolve;
    });
    const agent = new AgentProcessor({ stream });
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run(_model, body) {
          aiCalls.push(body);
          resolveFirstCall();
          return { response: "```js\nasync (itx) => {}\n```" };
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });
    const cursors = new Map<object, number>();
    const deliver = (processor: ProcessorLike) => deliverNewEvents({ processor, stream, cursors });

    // First user message — triggers llm-request-scheduled (with debounce)
    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "message one" },
    });
    await deliver(agent);
    await deliver(agent);
    await deliver(agent);

    // Second user message arrives before debounce fires — queued as pending
    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "message two" },
    });
    await deliver(agent);

    // Wait for the LLM call to complete (both messages included in it)
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 2_000,
    });
    await deliver(agent);
    await deliver(cloudflareAi);
    await firstCallInFlight;
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    await deliver(agent);

    // Give the processor time to fire a spurious second request if the bug is present
    await new Promise((resolve) => setTimeout(resolve, 100));
    await deliver(agent);

    expect(aiCalls).toHaveLength(1);
    const firstCall = aiCalls[0] as { messages: Array<{ role: string; content: string }> };
    expect(firstCall.messages.map((m) => m.content)).toEqual(
      expect.arrayContaining(["message one", "message two"]),
    );
  });

  it("recovers a stuck scheduled request after DO restart (lost debounce timer)", async () => {
    const stream = new MemoryStream();
    // Simulate events already committed before restart
    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: { content: "hello", llmRequestPolicy: { behaviour: "after-current-request" } },
      },
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 250,
          model: "@cf/moonshotai/kimi-k2.7-code",
          provider: "cloudflare-ai",
          requestId: "llm-request:1",
        },
      },
    );
    // Simulate a checkpoint written after the scheduled event but before the timer fired
    const stuckState = AgentProcessorContract.stateSchema.parse({
      history: [{ role: "user", content: "hello" }],
      currentRequest: { phase: "scheduled", requestId: "llm-request:1", scheduledOffset: 2 },
      llmProviderConfigured: true,
    });
    const agent = new AgentProcessor({
      stream,
      readState: async () => ({ offset: 2, state: stuckState }),
    });
    // New event arrives after restart — triggers recovery
    await stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { origin: "web", content: "second message" },
    });
    await deliverNewEvents({ processor: agent, stream, cursors: new Map() });
    // Recovery should fire llm-request-requested without waiting for a debounce
    await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 500,
    });
  });

  it("treats Workers AI terminal stream chunks without choices as successful completion", async () => {
    const stream = new MemoryStream();
    const cloudflareAi = new CloudflareAiProcessor({
      stream,
      ai: {
        async run() {
          return sseStream(
            { choices: [{ delta: { content: "```js\n" } }] },
            {
              choices: [
                {
                  delta: {
                    content:
                      "async (itx) => {\n  await itx.chat.sendMessage({ message: 'real-ai-agent-ok' });\n}\n```",
                  },
                },
              ],
            },
            {
              choices: [],
              usage: { completion_tokens: 12, prompt_tokens: 34, total_tokens: 46 },
            },
          );
        },
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append(
      {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: "send real-ai-agent-ok",
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-scheduled",
        payload: {
          debounceMs: 0,
          model: "@cf/moonshotai/kimi-k2.7-code",
          provider: "cloudflare-ai",
          requestId: "llm-request:1",
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          model: "@cf/moonshotai/kimi-k2.7-code",
          provider: "cloudflare-ai",
          requestId: "llm-request:1",
        },
      },
    );

    await deliverNewEvents({
      processor: cloudflareAi,
      stream,
      cursors: new Map<object, number>(),
    });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    const output = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/output-added"],
      timeoutMs: 2_000,
    });

    expect(completed.payload).toMatchObject({
      result: { status: "success" },
    });
    expect(output.payload).toMatchObject({
      content: expect.stringContaining("real-ai-agent-ok"),
    });
  });

  it("executes openai-ws requests over the Responses WebSocket and records every frame", async () => {
    const stream = new MemoryStream();
    const sockets: FakeResponsesWebSocket[] = [];
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        const socket = fakeResponsesWebSocket(() => [
          { type: "response.output_text.delta", delta: "```js\nasync (itx) => {}" },
          { type: "response.output_text.delta", delta: "\n```" },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { total_tokens: 7 } },
          },
        ]);
        sockets.push(socket);
        return socket;
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append(...openAiWsRequestEvents("hello over ws"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });
    const output = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/output-added"],
      timeoutMs: 2_000,
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent[0]).toMatchObject({ type: "response.create", model: "gpt-5.5" });
    expect(stream.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/openai-ws/llm-request-started",
        "events.iterate.com/openai-ws/llm-response-chunk",
        "events.iterate.com/openai-ws/llm-request-completed",
      ]),
    );
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/openai-ws/llm-response-chunk",
      ),
    ).toHaveLength(3);
    expect(completed.payload).toMatchObject({
      provider: "openai-ws",
      result: { status: "success", usage: { total_tokens: 7 } },
    });
    expect(output.payload).toMatchObject({ content: "```js\nasync (itx) => {}\n```" });
  });

  it("does not answer llm requests addressed to cloudflare-ai", async () => {
    const stream = new MemoryStream();
    let dialed = 0;
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        dialed += 1;
        throw new Error("should not dial");
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append({
      type: "events.iterate.com/agent/llm-request-requested",
      payload: {
        model: "@cf/moonshotai/kimi-k2.7-code",
        provider: "cloudflare-ai",
        requestId: "llm-request:1",
      },
    });
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dialed).toBe(0);
    expect(stream.events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["events.iterate.com/openai-ws/llm-request-started"]),
    );
  });

  it("fails openai-ws requests politely when no API key is configured", async () => {
    const stream = new MemoryStream();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: null,
      createResponsesWebSocketClient: async () => {
        throw new Error("should not dial without a key");
      },
      readStreamEvents: () => stream.getEvents(),
    });

    await stream.append(...openAiWsRequestEvents("hello without a key"));
    await deliverNewEvents({ processor: openAiWs, stream, cursors: new Map() });
    const completed = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/agent/llm-request-completed"],
      timeoutMs: 2_000,
    });

    expect(completed.payload).toMatchObject({
      provider: "openai-ws",
      result: {
        status: "failure",
        error: { message: expect.stringContaining("OpenAI API key is not configured") },
      },
    });
    expect(stream.events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["events.iterate.com/agent/output-added"]),
    );
  });
});
