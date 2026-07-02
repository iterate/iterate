// Implements the "openai-ws" LLM provider processor.
//
// This file is a deliberate sibling of cloudflare-ai-processor-implementation.ts:
// same method names, same control flow — the two differ only in transport (an
// OpenAI Responses WebSocket vs one AI.run call). When you fix something here,
// check whether the sibling needs the same fix.
//
// Connection lifecycle: the WebSocket connection is a lazy instance field on
// the class. The hosting Durable Object instance is the connection scope —
// sequential agent requests reuse the same socket until OpenAI or the runtime
// closes it. Executions are serialized per instance (`#executionChain`) because
// concurrent requests must not interleave reads on the shared socket iterator.

import { z } from "zod";
import type { ResponseInput, ResponsesClientEvent } from "openai/resources/responses/responses";
import type { StreamEvent } from "../../types.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { buildAgentLlmRequestBody, reduceAgentEvents } from "./agent-processor-implementation.ts";
import { OpenAiWsProcessorContract } from "./openai-ws-processor-contract.ts";

type LlmRequestRequestedEvent = Extract<
  ReturnType<typeof OpenAiWsProcessorContract.parseEvent>,
  { type: "events.iterate.com/agent/llm-request-requested" }
>;

export type OpenAiResponsesWebSocket = {
  readonly readyState: number;
  sendResponseCreate(event: ResponsesClientEvent): void;
  messages(): AsyncIterableIterator<unknown>;
  close(props?: { code: number; reason: string }): void;
};

type OpenAiWsConnection = {
  client: OpenAiResponsesWebSocket;
  iterator: AsyncIterableIterator<unknown>;
};

const OpenAiResponsesStreamMessage = z.looseObject({
  type: z.string(),
  response: z
    .looseObject({
      id: z.string().optional(),
      usage: z.unknown().optional(),
    })
    .optional(),
  delta: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

const OpenAiWebSocketReadyState = {
  Open: 1,
} as const;

export class OpenAiWsProcessor extends StreamProcessor<
  typeof OpenAiWsProcessorContract,
  {
    /** Null when the deployment has no OpenAI key; requests then fail politely. */
    apiKey: string | null;
    createResponsesWebSocketClient?: (apiKey: string) => Promise<OpenAiResponsesWebSocket>;
    readStreamEvents(): Promise<StreamEvent[]>;
  }
> {
  readonly contract = OpenAiWsProcessorContract;

  /**
   * Warm-instance transport state, not per-request state. Responses WebSocket
   * mode is a transport that can carry many `response.create` requests.
   * `previousResponseId` is provider continuation data, not agent history.
   */
  #connection: OpenAiWsConnection | null = null;
  #previousResponseId: string | null = null;

  /**
   * Serializes LLM executions on this instance. Only executions queue behind
   * each other — never the batch queue — because two concurrent requests would
   * steal each other's frames off the single Responses WebSocket iterator.
   */
  #executionChain: Promise<unknown> = Promise.resolve();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof OpenAiWsProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/openai-ws/llm-request-started":
        return {
          ...state,
          requests: {
            ...state.requests,
            [String(event.payload.llmRequestId)]: { status: "started" as const },
          },
        };
      case "events.iterate.com/openai-ws/llm-request-completed":
        return {
          ...state,
          requests: {
            ...state.requests,
            [String(event.payload.llmRequestId)]: { status: "completed" as const },
          },
        };
      default:
        return state;
    }
  }

  protected override processEvent({
    event,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<typeof OpenAiWsProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/agent/llm-request-requested") return;
    if (event.payload.provider !== OpenAiWsProcessorContract.slug) return;
    const llmRequestId = event.offset;
    if (state.requests[String(llmRequestId)]?.status === "completed") return;
    const execution = this.#executionChain.then(() => this.#executeRequest({ event }));
    this.#executionChain = execution.catch(() => undefined);
    runInBackground(() => execution);
  }

  async #executeRequest(input: { event: LlmRequestRequestedEvent }): Promise<void> {
    const llmRequestId = input.event.offset;
    const model = input.event.payload.model;
    const startedAt = Date.now();
    await this.stream.append({
      type: "events.iterate.com/openai-ws/llm-request-started",
      idempotencyKey: `openai-ws/llm-request-started@${llmRequestId}`,
      payload: { llmRequestId, model },
    });

    try {
      if (this.deps.apiKey === null || this.deps.apiKey.trim() === "") {
        throw new Error(
          "OpenAI API key is not configured on this deployment (AppConfig openAiApiKey).",
        );
      }
      // Request-by-reference: the requested event carries no body; rebuild the
      // chat request from committed history up to the request's own offset.
      const body = buildAgentLlmRequestBody({
        events: await this.deps.readStreamEvents(),
        llmRequestId,
      });
      const connection = await this.#getConnection();
      const requestMessage = buildResponsesClientEvent({
        messages: body.messages,
        model,
        previousResponseId: this.#previousResponseId,
      });
      try {
        connection.client.sendResponseCreate(requestMessage);
      } catch (error) {
        connection.client.close({ code: 1011, reason: "send-failed" });
        this.#markConnectionClosed(connection);
        throw error;
      }

      const completion = await this.#consumeResponse({ connection, sourceEvent: input.event });
      const durationMs = Date.now() - startedAt;
      const providerResult = {
        status: "success" as const,
        rawResponse: completion.rawResponse,
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      };

      if (await this.#isRequestStillCurrent({ llmRequestId })) {
        await this.stream.append({
          type: "events.iterate.com/agent/output-added",
          idempotencyKey: `openai-ws/agent-output-added@${llmRequestId}`,
          payload: { content: completion.text, llmRequestId },
        });
        if (completion.responseId !== undefined) this.#previousResponseId = completion.responseId;
      }

      await this.stream.append(
        {
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: `openai-ws/provider-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            result: providerResult,
          },
        },
        {
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: `openai-ws/agent-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            provider: "openai-ws",
            result: providerResult,
          },
        },
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const failure = {
        status: "failure" as const,
        error: { message: stringifyError(error) },
      };
      await this.stream.append(
        {
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: `openai-ws/provider-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            result: failure,
          },
        },
        {
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: `openai-ws/agent-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            provider: "openai-ws",
            result: failure,
          },
        },
      );
    }
  }

  /**
   * Reads socket frames until the response terminates. Every frame lands on the
   * stream as an llm-response-chunk so subscribers (e.g. the browser agent UI)
   * can render output and reasoning summaries as they stream.
   */
  async #consumeResponse(input: {
    connection: OpenAiWsConnection;
    sourceEvent: LlmRequestRequestedEvent;
  }): Promise<{ rawResponse: unknown; responseId?: string; text: string; usage?: unknown }> {
    const llmRequestId = input.sourceEvent.offset;
    let sequence = 0;
    let text = "";

    while (true) {
      let chunk: unknown;
      try {
        const result = await input.connection.iterator.next();
        if (result.done === true) throw new Error("OpenAI WebSocket stream ended.");
        chunk = result.value;
      } catch (error) {
        // A dead iterator means a dead socket: drop the cached connection so
        // the next request re-dials instead of reusing a closed transport.
        this.#markConnectionClosed(input.connection);
        throw error;
      }

      await this.stream.append({
        type: "events.iterate.com/openai-ws/llm-response-chunk",
        idempotencyKey: `openai-ws/llm-response-chunk@${llmRequestId}:${sequence}`,
        payload: { chunk, llmRequestId, sequence },
      });
      sequence += 1;

      const parsed = OpenAiResponsesStreamMessage.safeParse(chunk);
      if (!parsed.success) continue;

      if (parsed.data.type === "response.output_text.delta") {
        text += parsed.data.delta ?? "";
        continue;
      }

      if (parsed.data.type === "response.completed") {
        const usage = parsed.data.response?.usage;
        return {
          rawResponse: parsed.data.response ?? chunk,
          ...(parsed.data.response?.id === undefined
            ? {}
            : { responseId: parsed.data.response.id }),
          text,
          ...(usage === undefined ? {} : { usage }),
        };
      }

      if (parsed.data.type === "response.failed" || parsed.data.type === "error") {
        // A failed response invalidates provider-side continuation but not the
        // socket; the connection stays cached for the next request.
        this.#previousResponseId = null;
        throw new Error(parsed.data.error?.message ?? "OpenAI WebSocket request failed.");
      }
    }
  }

  async #getConnection(): Promise<OpenAiWsConnection> {
    if (this.#connection?.client.readyState === OpenAiWebSocketReadyState.Open) {
      return this.#connection;
    }

    const client = await (
      this.deps.createResponsesWebSocketClient ?? createOpenAiResponsesWebSocketClient
    )(this.deps.apiKey!);
    const connection: OpenAiWsConnection = { client, iterator: client.messages() };
    this.#connection = connection;
    return connection;
  }

  #markConnectionClosed(closedConnection: OpenAiWsConnection) {
    if (this.#connection !== closedConnection) return;
    this.#connection = null;
    this.#previousResponseId = null;
  }

  async #isRequestStillCurrent(input: { llmRequestId: number }) {
    const state = reduceAgentEvents(await this.deps.readStreamEvents());
    return (
      state.currentRequest?.phase === "requested" &&
      state.currentRequest.llmRequestId === input.llmRequestId
    );
  }
}

/**
 * Sending `reasoning` options to a non-reasoning model fails the whole
 * request, so only ask for summaries on model families known to reason.
 */
function supportsReasoningSummaries(model: string) {
  return /^(gpt-5|o[1-9]|codex)/.test(model);
}

function buildResponsesClientEvent(args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  previousResponseId: string | null;
}): ResponsesClientEvent {
  const systemMessages = args.messages.filter((message) => message.role === "system");
  const inputMessages = args.messages.filter(isResponsesInputMessage);
  const input =
    args.previousResponseId == null
      ? toResponsesInput(inputMessages)
      : toResponsesInput(newInputMessagesForContinuation(inputMessages));

  return {
    type: "response.create",
    model: args.model as ResponsesClientEvent["model"],
    instructions:
      systemMessages.map((message) => message.content).join("\n\n") ||
      "You are a helpful assistant.",
    input,
    store: false,
    // Reasoning models stream `response.reasoning_summary_text.delta` frames
    // when summaries are requested; those land on the stream like every other
    // frame so the UI can show thinking as it happens.
    ...(supportsReasoningSummaries(args.model) ? { reasoning: { summary: "auto" } } : {}),
    ...(args.previousResponseId == null ? {} : { previous_response_id: args.previousResponseId }),
  };
}

function toResponsesInput(messages: Array<{ role: "user" | "assistant"; content: string }>) {
  return messages.map((message) => ({
    type: "message" as const,
    role: message.role,
    content: message.content,
  })) satisfies ResponseInput;
}

function isResponsesInputMessage(message: {
  role: "system" | "user" | "assistant";
  content: string;
}): message is {
  role: "user" | "assistant";
  content: string;
} {
  return message.role !== "system";
}

function newInputMessagesForContinuation(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  return lastAssistantIndex === -1 ? messages : messages.slice(lastAssistantIndex + 1);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// =============================================================================
// Cloudflare Workers transport for OpenAI Responses WebSocket mode.
//
// Workers dial outbound WebSockets via a fetch upgrade; the accepted socket is
// wrapped in a pull-based async iterator so the processor can read frames one
// at a time. https://developers.openai.com/api/docs/guides/websocket-mode
// =============================================================================

const OpenAiResponsesWebSocketUrl = "wss://api.openai.com/v1/responses";

async function createOpenAiResponsesWebSocketClient(
  apiKey: string,
): Promise<OpenAiResponsesWebSocket> {
  const response = (await fetch(OpenAiResponsesWebSocketUrl.replace("wss://", "https://"), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "responses_websockets=2026-02-06",
      Upgrade: "websocket",
    },
  })) as Response & { webSocket?: WebSocket | null };

  if (response.webSocket == null) {
    throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
  }

  response.webSocket.accept();
  return new CloudflareResponsesWebSocket(response.webSocket);
}

class CloudflareResponsesWebSocket implements OpenAiResponsesWebSocket {
  #done = false;
  #messages: unknown[] = [];
  #terminalError: unknown;
  #waiters: Array<{
    reject(error: unknown): void;
    resolve(result: IteratorResult<unknown>): void;
  }> = [];

  constructor(private readonly socket: WebSocket) {
    this.#bindSocket();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  sendResponseCreate(event: ResponsesClientEvent): void {
    if (this.socket.readyState !== OpenAiWebSocketReadyState.Open) {
      throw new Error("OpenAI WebSocket is not open.");
    }
    this.socket.send(JSON.stringify(event));
  }

  messages(): AsyncIterableIterator<unknown> {
    return this;
  }

  close(props?: { code: number; reason: string }): void {
    this.socket.close(props?.code, props?.reason);
  }

  #bindSocket() {
    this.socket.addEventListener("message", (event) => {
      this.#handleSocketMessage(event.data);
    });
    this.socket.addEventListener("close", (event) => {
      this.#fail(new Error(`OpenAI WebSocket closed: ${event.code} ${event.reason}`));
    });
    this.socket.addEventListener("error", () => {
      this.#fail(new Error("OpenAI WebSocket errored."));
    });
  }

  #handleSocketMessage(data: unknown) {
    if (typeof data !== "string") {
      this.#fail(new Error("OpenAI WebSocket sent a non-text frame."));
      this.close({ code: 1002, reason: "non-text-frame" });
      return;
    }

    try {
      this.#push(JSON.parse(data) as unknown);
    } catch (error) {
      this.#fail(error);
      this.close({ code: 1002, reason: "invalid-json-frame" });
    }
  }

  async next(): Promise<IteratorResult<unknown>> {
    if (this.#messages.length > 0) return { value: this.#messages.shift(), done: false };
    if (this.#terminalError != null) throw this.#terminalError;
    if (this.#done) return { value: undefined, done: true };

    return await new Promise((resolve, reject) => {
      this.#waiters.push({ reject, resolve });
    });
  }

  async return(): Promise<IteratorReturnResult<undefined>> {
    this.#done = true;
    this.close({ code: 1000, reason: "iterator-returned" });
    this.#flushWaiters();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }

  #push(message: unknown) {
    const waiter = this.#waiters.shift();
    if (waiter != null) {
      waiter.resolve({ value: message, done: false });
      return;
    }

    this.#messages.push(message);
  }

  #fail(error: unknown) {
    if (this.#done) return;
    if (this.#terminalError == null) this.#terminalError = error;
    this.#done = true;
    for (let waiter = this.#waiters.shift(); waiter != null; waiter = this.#waiters.shift()) {
      waiter.reject(this.#terminalError);
    }
  }

  #flushWaiters() {
    for (let waiter = this.#waiters.shift(); waiter != null; waiter = this.#waiters.shift()) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}
