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
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  buildAgentLlmRequestBody,
  flattenMessageToText,
  reduceAgentEvents,
  renderFileHintLine,
  type AgentChatMessage,
} from "./agent-processor-implementation.ts";
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

/** Hard wall-clock cap per response (see #withRequestDeadline). Generous —
 * long reasoning turns are minutes, not tens of minutes. */
const OPENAI_WS_REQUEST_DEADLINE_MS = 10 * 60_000;

export class OpenAiWsProcessor extends StreamProcessor<
  OpenAiWsProcessorContract,
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
   * How many compaction boundaries the request body that produced
   * `#previousResponseId` had folded in. Server-side continuation holds the
   * FULL pre-compaction context, so once the agent compacts (compactionCount
   * changes) the stored id is useless — reusing it would keep the uncompacted
   * history (and its token bill) alive on the server and re-trigger
   * compaction forever. Mismatch ⇒ full resend.
   */
  #previousResponseIdCompactionCount = 0;

  /**
   * Serializes LLM executions on this instance. Only executions queue behind
   * each other — never the batch queue — because two concurrent requests would
   * steal each other's frames off the single Responses WebSocket iterator.
   */
  #executionChain: Promise<unknown> = Promise.resolve();

  /**
   * llmRequestIds with an execution alive in THIS incarnation. A request the
   * durable fold shows incomplete but that no live execution owns was
   * orphaned — the incarnation running it was evicted (deploy, hibernation)
   * or its socket wedged past the deadline — and must be failed, or it
   * occupies the agent's currentRequest forever and every later input queues
   * behind it (the 2026-07-07 prd email-thread wedge).
   */
  readonly #liveExecutions = new Set<number>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<OpenAiWsProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/agent/llm-request-requested": {
        if (event.payload.provider !== OpenAiWsProcessorContract.slug) return state;
        const key = String(event.offset);
        if (state.requests[key]?.status === "completed") return state;
        return {
          ...state,
          requests: { ...state.requests, [key]: { status: "requested" as const } },
        };
      }
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
  }: Parameters<StreamProcessor<OpenAiWsProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/agent/llm-request-requested") return;
    if (event.payload.provider !== OpenAiWsProcessorContract.slug) return;
    const llmRequestId = event.offset;
    if (state.requests[String(llmRequestId)]?.status === "completed") return;
    // Registered synchronously, before any await: the same batch's orphan
    // sweep must see this request as live.
    this.#liveExecutions.add(llmRequestId);
    const execution = this.#executionChain.then(() => this.#executeRequest({ event }));
    this.#executionChain = execution.catch(() => undefined);
    runInBackground(() => execution);
  }

  /**
   * After every batch: fail requests the durable fold shows incomplete but
   * that no execution in THIS incarnation owns. Such a request's executing
   * incarnation is gone (eviction mid-request advances the checkpoint —
   * executions are runInBackground — so the requested event never redelivers)
   * and nothing else will ever complete it; without this sweep it occupies
   * the agent's currentRequest forever and every later input queues behind
   * it. The failure completions use the exact idempotency keys of the normal
   * completion path, so any race resolves to one durable outcome.
   */
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<typeof OpenAiWsProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    const orphaned = Object.entries(args.state.requests)
      .filter(
        ([id, request]) => request.status !== "completed" && !this.#liveExecutions.has(Number(id)),
      )
      .map(([id]) => Number(id));
    if (orphaned.length === 0) return;
    args.blockProcessorWhile(async () => {
      for (const llmRequestId of orphaned) {
        console.error("[openai-ws] failing orphaned llm request", { llmRequestId });
        await this.#appendCompletion({
          llmRequestId,
          durationMs: 0,
          result: {
            status: "failure" as const,
            error: {
              message:
                "LLM request orphaned: the incarnation executing it went away before completing (eviction or wedged socket). Failed by the recovery sweep; the agent's next trigger reschedules.",
            },
          },
        });
      }
    });
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
      // Continuation only carries a CHAT conversation forward: a compaction
      // request is a separate one-shot conversation, and a stored id from
      // before a compaction boundary must not resurrect the uncompacted
      // server-side context (see #previousResponseIdCompactionCount).
      const attemptedPreviousResponseId =
        body.purpose === "compaction" ||
        this.#previousResponseIdCompactionCount !== body.compactionCount
          ? null
          : this.#previousResponseId;
      let completion;
      try {
        completion = await this.#withRequestDeadline(
          this.#createAndConsumeResponse({
            messages: body.messages,
            model,
            previousResponseId: attemptedPreviousResponseId,
            sourceEvent: input.event,
          }),
        );
      } catch (error) {
        if (attemptedPreviousResponseId === null || !isPreviousResponseNotFoundError(error)) {
          throw error;
        }
        this.#previousResponseId = null;
        completion = await this.#withRequestDeadline(
          this.#createAndConsumeResponse({
            idempotencyScope: `retry-without-previous-response:${attemptedPreviousResponseId}`,
            messages: body.messages,
            model,
            previousResponseId: null,
            sourceEvent: input.event,
          }),
        );
      }
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
        // A compaction response's id is never stored: it continues the
        // summarization conversation, not the chat.
        if (completion.responseId !== undefined && body.purpose !== "compaction") {
          this.#previousResponseId = completion.responseId;
          this.#previousResponseIdCompactionCount = body.compactionCount;
        }
      }

      await this.#appendCompletion({ durationMs, llmRequestId, result: providerResult });
    } catch (error) {
      await this.#appendCompletion({
        durationMs: Date.now() - startedAt,
        llmRequestId,
        result: {
          status: "failure" as const,
          error: { message: stringifyError(error) },
        },
      });
    } finally {
      this.#liveExecutions.delete(llmRequestId);
    }
  }

  /** The one durable outcome of a request — provider + agent completion pair.
   * Success, in-execution failure, and the orphan sweep all land here with
   * identical idempotency keys, so races collapse at the append dedup layer. */
  async #appendCompletion(input: {
    durationMs: number;
    llmRequestId: number;
    result:
      | { status: "success"; rawResponse?: unknown; usage?: unknown }
      | { status: "failure"; error: { message: string }; rawResponse?: unknown };
  }): Promise<void> {
    await this.stream.append(
      {
        type: "events.iterate.com/openai-ws/llm-request-completed",
        idempotencyKey: `openai-ws/provider-completed@${input.llmRequestId}`,
        payload: {
          durationMs: input.durationMs,
          llmRequestId: input.llmRequestId,
          result: input.result,
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `openai-ws/agent-completed@${input.llmRequestId}`,
        payload: {
          durationMs: input.durationMs,
          llmRequestId: input.llmRequestId,
          provider: "openai-ws",
          result: input.result,
        },
      },
    );
  }

  /**
   * Hard cap on one response's wall clock. A Responses WebSocket that stops
   * yielding frames would otherwise hang the execution forever (the DO stays
   * alive on keepAlive, nothing completes, the agent wedges). On timeout the
   * connection is dropped so the next request opens a fresh socket instead of
   * inheriting the wedged one.
   */
  async #withRequestDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#connection = null;
        reject(
          new Error(
            `OpenAI request exceeded the ${OPENAI_WS_REQUEST_DEADLINE_MS / 1000}s deadline; dropping the socket.`,
          ),
        );
      }, OPENAI_WS_REQUEST_DEADLINE_MS);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #createAndConsumeResponse(input: {
    idempotencyScope?: string;
    messages: ReturnType<typeof buildAgentLlmRequestBody>["messages"];
    model: string;
    previousResponseId: string | null;
    sourceEvent: LlmRequestRequestedEvent;
  }): Promise<{ rawResponse: unknown; responseId?: string; text: string; usage?: unknown }> {
    const connection = await this.#getConnection();
    const requestMessage = buildResponsesClientEvent({
      messages: input.messages,
      model: input.model,
      previousResponseId: input.previousResponseId,
    });
    try {
      connection.client.sendResponseCreate(requestMessage);
    } catch (error) {
      connection.client.close({ code: 1011, reason: "send-failed" });
      this.#markConnectionClosed(connection);
      throw error;
    }

    return await this.#consumeResponse({
      connection,
      idempotencyScope: input.idempotencyScope,
      sourceEvent: input.sourceEvent,
    });
  }

  /**
   * Reads socket frames until the response terminates. Every frame lands on the
   * stream as an llm-response-chunk so subscribers (e.g. the browser agent UI)
   * can render output and reasoning summaries as they stream.
   */
  async #consumeResponse(input: {
    connection: OpenAiWsConnection;
    idempotencyScope?: string;
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
        idempotencyKey:
          input.idempotencyScope === undefined
            ? `openai-ws/llm-response-chunk@${llmRequestId}:${sequence}`
            : `openai-ws/llm-response-chunk@${llmRequestId}:${input.idempotencyScope}:${sequence}`,
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
  messages: AgentChatMessage[];
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

type ResponsesInputMessage = AgentChatMessage & { role: "user" | "assistant" };

/**
 * The image formats OpenAI's Responses API accepts as `input_image`. Anything
 * else (e.g. image/heic straight off an iPhone) fails the WHOLE request with a
 * 400 when OpenAI fetches the URL, so it must ride as a hint line instead.
 */
const OPENAI_INPUT_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function toResponsesInput(messages: ResponsesInputMessage[]) {
  return messages.map((message) => {
    // OpenAI-ingestible image attachments become real vision inputs (fetched
    // by OpenAI via the signed URL); everything else flattens to a hint line
    // the agent can act on. Image parts are only valid on user-role messages —
    // all attachment inputs are user-role, so that is the only case built
    // here. Loopback (local-dev http) URLs are unreachable from OpenAI's
    // fetcher and fail the whole request, so only https URLs ride as image
    // parts.
    const images = (message.files ?? []).filter(
      (file) =>
        OPENAI_INPUT_IMAGE_CONTENT_TYPES.has(file.contentType) && file.url.startsWith("https://"),
    );
    if (message.role !== "user" || images.length === 0) {
      return {
        type: "message" as const,
        role: message.role,
        content: flattenMessageToText(message),
      };
    }
    const otherFiles = (message.files ?? []).filter((file) => !images.includes(file));
    return {
      type: "message" as const,
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: [message.content, ...otherFiles.map(renderFileHintLine)].join("\n"),
        },
        ...images.map((file) => ({
          type: "input_image" as const,
          detail: "auto" as const,
          image_url: file.url,
        })),
      ],
    };
  }) satisfies ResponseInput;
}

function isResponsesInputMessage(message: AgentChatMessage): message is ResponsesInputMessage {
  return message.role !== "system";
}

function newInputMessagesForContinuation(messages: ResponsesInputMessage[]) {
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

function isPreviousResponseNotFoundError(error: unknown): boolean {
  const message = stringifyError(error);
  return message.includes("Previous response") && message.includes("not found");
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
