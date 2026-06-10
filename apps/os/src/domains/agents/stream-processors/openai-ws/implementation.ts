// Implements the "openai-ws" processor as a class-based StreamProcessor.
//
// Migrated from packages/shared/src/stream-processors/openai-ws/implementation.ts.
// All appended events keep their legacy types, payload shapes, and
// idempotency-key derivations (`openai-ws/<key>@<sourceOffset>`).
//
// Connection lifecycle: the WebSocket connection is a lazy instance field on
// the class. The hosting Durable Object instance is the connection scope —
// sequential agent requests reuse the same socket until OpenAI or the runtime
// closes it, exactly like the old runner DO's closure state.
//
// The LLM request itself runs as keep-alive-backed background work
// (`runInBackground`): the serialized batch queue stays free while the request
// is in flight, so cancellations, superseding inputs, and config changes keep
// reducing instead of waiting behind the request they should affect. Executions
// themselves are serialized per instance (`#executionChain`) because concurrent
// requests must not interleave reads on the shared Responses WebSocket
// iterator. The still-current check before agent-visible appends
// (`#isAgentLlmRequestStillCurrent`) absorbs the resulting raciness. Crash
// recovery no longer rides on checkpoint-held redelivery; see
// `#reconcileDanglingStartedRequests`.

import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  type ConsumedEvent,
  type StreamEvent,
} from "@iterate-com/streams/shared/stream-processors";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { reduceAgentEvents } from "../agent/contract.ts";
import { OpenAiWsProcessorContract, type OpenAiWsState } from "./contract.ts";

export { OpenAiWsProcessorContract } from "./contract.ts";

export type OpenAiWsProcessorContract = typeof OpenAiWsProcessorContract;

type OpenAiWsConsumedEvent = ConsumedEvent<OpenAiWsProcessorContract>;
type LlmRequestRequestedEvent = Extract<
  OpenAiWsConsumedEvent,
  { type: "events.iterate.com/agent/llm-request-requested" }
>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

const OpenAiResponsesStreamMessage = z.looseObject({
  type: z.string(),
  response: z
    .object({
      id: z.string().optional(),
      usage: z.json().optional(),
    })
    .passthrough()
    .optional(),
  item_id: z.string().optional(),
  output_index: z.number().int().optional(),
  content_index: z.number().int().optional(),
  delta: z.string().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
});

export type OpenAiWsProcessorDeps = {
  openResponsesWebSocket(): Promise<OpenAiResponsesWebSocket>;
  /**
   * Reads the full committed history of the agent's stream so the processor
   * can confirm the request is still current before appending agent output.
   */
  readStreamEvents(): Promise<StreamEvent[]>;
};

export type OpenAiResponsesWebSocket = {
  readonly url: URL | string;
  readonly socket: { readonly readyState: number };
  send(event: JsonValue): void;
  stream(): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage>;
  close(props?: { code: number; reason: string }): void;
};

export type OpenAiResponsesWebSocketStreamMessage =
  | { type: "connecting" | "open" | "closing" | "reconnected" }
  | { type: "close"; code: number; reason: string }
  | { type: "reconnecting"; reconnect: JsonValue }
  | { type: "message"; message: JsonValue }
  | { type: "raw"; data: unknown }
  | { type: "error"; error: unknown };

type OpenAiWsConnection = {
  id: string;
  url: string;
  client: OpenAiResponsesWebSocket;
  iterator: AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage>;
  receiveSequence: number;
  sendSequence: number;
};

const OpenAiWebSocketReadyState = {
  Open: 1,
} as const;

export class OpenAiWsProcessor extends StreamProcessor<
  OpenAiWsProcessorContract,
  OpenAiWsProcessorDeps
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
   * Requests this instance has taken responsibility for executing. The DO
   * instance is the execution scope: a fresh instance after a crash/wake
   * starts empty, which is what lets `#reconcileDanglingStartedRequests`
   * recognize requests a previous incarnation abandoned. Ids stay in the set
   * after a request reaches its terminal appends (re-execution is never
   * needed then, even while the completed event is still being delivered
   * back); they are removed only when execution fails before the terminal
   * appends landed, so a later batch's reconciliation can retry.
   */
  #executedLlmRequestIds = new Set<number>();

  /**
   * Serializes LLM executions on this instance. Only executions queue behind
   * each other — never the batch queue — because two concurrent requests would
   * steal each other's frames off the single Responses WebSocket iterator.
   */
  #executionChain: Promise<unknown> = Promise.resolve();

  protected override reduce(
    args: Parameters<StreamProcessor<OpenAiWsProcessorContract>["reduce"]>[0],
  ): OpenAiWsState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/agent/llm-request-requested":
        return state;
      case "events.iterate.com/openai-ws/config-updated":
        return { ...state, model: event.payload.model };
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
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<OpenAiWsProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/openai-ws/config-updated":
      case "events.iterate.com/openai-ws/llm-request-started":
      case "events.iterate.com/openai-ws/llm-request-completed":
        return;
      case "events.iterate.com/agent/llm-request-requested":
        this.#startLlmRequest({ event, state, runInBackground: args.runInBackground });
        return;
      default:
        return assertNever(event);
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<OpenAiWsProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    await this.#reconcileDanglingStartedRequests({
      state: args.state,
      runInBackground: args.runInBackground,
    });
  }

  /**
   * Kicks off LLM execution as background work so the batch queue is never
   * blocked on a provider call; the execution itself queues on
   * `#executionChain` (see field doc). Failures before the terminal events
   * landed release the id so dangling-started reconciliation can retry on a
   * later batch (the `started` append is idempotency-keyed, so a retry cannot
   * duplicate it).
   */
  #startLlmRequest(args: {
    event: LlmRequestRequestedEvent;
    state: OpenAiWsState;
    runInBackground: (work: () => Promise<unknown>) => void;
  }) {
    const llmRequestId = args.event.offset;
    this.#executedLlmRequestIds.add(llmRequestId);
    const execution = this.#executionChain.then(() =>
      this.#executeOpenAiWsRequest({ event: args.event, state: args.state }),
    );
    this.#executionChain = execution.catch(() => undefined);
    args.runInBackground(async () => {
      try {
        await execution;
      } catch (error) {
        this.#executedLlmRequestIds.delete(llmRequestId);
        throw error;
      }
    });
  }

  /**
   * Crash recovery for background LLM execution. With `runInBackground` the
   * checkpoint advances past `agent/llm-request-requested` immediately, so a
   * crash mid-request is no longer healed by redelivery. A `started` entry
   * whose id this instance never executed can only come from a previous
   * incarnation, so re-execute it from the original requested event in stream
   * history (its offset is the llmRequestId). Stale recoveries finish
   * gracefully: the still-current check skips agent-visible output and the
   * terminal completed event flips the entry out of `started`. History is only
   * read when a dangling entry exists, keeping the common path cheap.
   */
  async #reconcileDanglingStartedRequests(args: {
    state: OpenAiWsState;
    runInBackground: (work: () => Promise<unknown>) => void;
  }) {
    const danglingIds = Object.entries(args.state.requests)
      .filter(
        ([id, request]) =>
          request.status === "started" && !this.#executedLlmRequestIds.has(Number(id)),
      )
      .map(([id]) => Number(id));
    if (danglingIds.length === 0) return;

    const events = await this.deps.readStreamEvents();
    for (const llmRequestId of danglingIds) {
      const requestedEvent = events.find(
        (event) =>
          event.offset === llmRequestId &&
          event.type === "events.iterate.com/agent/llm-request-requested",
      );
      const reduction =
        requestedEvent === undefined
          ? undefined
          : this.reduceRawEvent({ event: requestedEvent, state: args.state });
      if (reduction?.event.type !== "events.iterate.com/agent/llm-request-requested") {
        // The entry cannot be tied back to a requested event, so it is
        // unrecoverable; claim it so it stops triggering history reads.
        this.#executedLlmRequestIds.add(llmRequestId);
        console.warn(
          `openai-ws: no agent/llm-request-requested event found at offset ${llmRequestId} for dangling started request`,
        );
        continue;
      }
      this.#startLlmRequest({
        event: reduction.event,
        state: args.state,
        runInBackground: args.runInBackground,
      });
    }
  }

  async #getConnection(sourceEvent: LlmRequestRequestedEvent): Promise<OpenAiWsConnection> {
    if (this.#connection?.client.socket.readyState === OpenAiWebSocketReadyState.Open) {
      return this.#connection;
    }

    const connectionId = createConnectionId({ llmRequestId: sourceEvent.offset });
    const client = await this.deps.openResponsesWebSocket();
    const iterator = client.stream();
    await waitForOpenAiResponsesSocketOpen(iterator);

    const connection: OpenAiWsConnection = {
      id: connectionId,
      url: String(client.url),
      client,
      iterator,
      receiveSequence: 0,
      sendSequence: 0,
    };
    this.#connection = connection;

    await this.#append({
      type: "events.iterate.com/openai-ws/websocket-connected",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: OpenAiWsProcessorContract,
        key: `websocket-connected/${connection.id}`,
        sourceEvent,
      }),
      payload: {
        connectionId: connection.id,
        url: connection.url,
      },
    });

    return connection;
  }

  #markConnectionClosed(closedConnection: OpenAiWsConnection) {
    if (this.#connection?.id === closedConnection.id) this.#connection = null;
  }

  async #executeOpenAiWsRequest(args: {
    event: LlmRequestRequestedEvent;
    state: OpenAiWsState;
  }): Promise<void> {
    const llmRequestId = args.event.offset;
    if (args.state.requests[String(llmRequestId)]?.status === "completed") return;

    const startedAt = Date.now();

    let connection: OpenAiWsConnection;
    try {
      connection = await this.#getConnection(args.event);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const failure = {
        status: "failure" as const,
        error: { message: stringifyError(error) },
      };
      await this.#append({
        type: "events.iterate.com/openai-ws/llm-request-completed",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: OpenAiWsProcessorContract,
          key: "provider-llm-request-completed",
          sourceEvent: args.event,
        }),
        payload: {
          llmRequestId,
          durationMs,
          result: failure,
        },
      });
      await this.#append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: OpenAiWsProcessorContract,
          key: "agent-llm-request-completed",
          sourceEvent: args.event,
        }),
        payload: {
          llmRequestId,
          provider: OpenAiWsProcessorContract.slug,
          durationMs,
          result: failure,
        },
      });
      return;
    }

    await this.#append({
      type: "events.iterate.com/openai-ws/llm-request-started",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: OpenAiWsProcessorContract,
        key: "llm-request-started",
        sourceEvent: args.event,
      }),
      payload: {
        connectionId: connection.id,
        llmRequestId,
        model: args.state.model,
      },
    });

    const systemMessages = args.event.payload.body.messages.filter(
      (message) => message.role === "system",
    );
    const inputMessages = args.event.payload.body.messages.filter(
      (message) => message.role !== "system",
    );
    const previousResponseId = this.#previousResponseId;
    /**
     * `store: false` keeps this out of OpenAI's stored response retention, but
     * WebSocket mode can still chain the immediate conversation by carrying
     * `previous_response_id` from the prior completed response. The agent
     * request body remains the source of truth for what we explicitly send.
     */
    const requestMessage = toJsonValue({
      type: "response.create",
      model: args.state.model,
      instructions:
        systemMessages.map((message) => message.content).join("\n\n") ||
        "You are a helpful assistant.",
      input: inputMessages.map((message) => ({
        type: "message",
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ],
      })),
      store: false,
      ...(previousResponseId == null ? {} : { previous_response_id: previousResponseId }),
    });
    const sendSequence = connection.sendSequence++;
    connection.client.send(requestMessage);
    await this.#append({
      type: "events.iterate.com/openai-ws/websocket-message-sent",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: OpenAiWsProcessorContract,
        key: `websocket-message-sent/${connection.id}/${sendSequence}`,
        sourceEvent: args.event,
      }),
      payload: {
        connectionId: connection.id,
        llmRequestId,
        sequence: sendSequence,
        message: requestMessage,
      },
    });

    let outputText = "";
    let finalResponse: JsonValue | undefined;

    while (true) {
      let rawMessage: unknown;
      try {
        rawMessage = await nextOpenAiResponsesMessage(connection);
      } catch (error) {
        this.#markConnectionClosed(connection);
        const durationMs = Date.now() - startedAt;
        const failure = {
          status: "failure" as const,
          error: { message: stringifyError(error) },
        };
        await this.#append({
          type: "events.iterate.com/openai-ws/websocket-disconnected",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: `websocket-disconnected/${connection.id}`,
            sourceEvent: args.event,
          }),
          payload: {
            connectionId: connection.id,
          },
        });
        await this.#append({
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "provider-llm-request-completed",
            sourceEvent: args.event,
          }),
          payload: {
            connectionId: connection.id,
            llmRequestId,
            durationMs,
            result: failure,
          },
        });
        await this.#append({
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "agent-llm-request-completed",
            sourceEvent: args.event,
          }),
          payload: {
            llmRequestId,
            provider: OpenAiWsProcessorContract.slug,
            durationMs,
            result: failure,
          },
        });
        return;
      }

      const message = toJsonValue(rawMessage);
      const parsed = OpenAiResponsesStreamMessage.safeParse(message);
      if (parsed.success && parsed.data.type === "response.output_text.delta") {
        // IMPORTANT TEMPORARY SKIP: eventually we DO want these raw output_text
        // delta frames in the stream again. For now, dropping them keeps
        // circuit breaker tuning and stream subscription latency easier to
        // reason about while these deltas are still very high volume.
        outputText += parsed.data.delta ?? "";
        continue;
      }

      const receiveSequence = connection.receiveSequence++;
      await this.#append({
        type: "events.iterate.com/openai-ws/websocket-message-received",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: OpenAiWsProcessorContract,
          key: `websocket-message-received/${connection.id}/${receiveSequence}`,
          sourceEvent: args.event,
        }),
        payload: {
          connectionId: connection.id,
          llmRequestId,
          sequence: receiveSequence,
          message,
        },
      });

      if (!parsed.success) continue;

      if (parsed.data.type === "response.completed") {
        finalResponse = toJsonValue(parsed.data.response ?? message);
        const responseId = parsed.data.response?.id;
        if (responseId != null) this.#previousResponseId = responseId;
        const durationMs = Date.now() - startedAt;
        const usage = parsed.data.response?.usage;
        if (!(await this.#isAgentLlmRequestStillCurrent({ llmRequestId }))) {
          await this.#appendProviderCompleted({
            connectionId: connection.id,
            durationMs,
            llmRequestId,
            responseId,
            result: {
              status: "success",
              rawResponse: finalResponse,
              ...(usage == null ? {} : { usage }),
            },
            sourceEvent: args.event,
          });
          return;
        }
        await this.#append({
          type: "events.iterate.com/agent/output-added",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "agent-output-added",
            sourceEvent: args.event,
          }),
          payload: { content: outputText, llmRequestId },
        });
        await this.#appendProviderCompleted({
          connectionId: connection.id,
          durationMs,
          llmRequestId,
          responseId,
          result: {
            status: "success",
            rawResponse: finalResponse,
            ...(usage == null ? {} : { usage }),
          },
          sourceEvent: args.event,
        });
        await this.#append({
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "agent-llm-request-completed",
            sourceEvent: args.event,
          }),
          payload: {
            llmRequestId,
            provider: OpenAiWsProcessorContract.slug,
            durationMs,
            result: {
              status: "success",
              rawResponse: finalResponse,
              ...(usage == null ? {} : { usage }),
              ...(responseId == null ? {} : { providerResponseId: responseId }),
            },
          },
        });
        return;
      }

      if (parsed.data.type === "response.failed" || parsed.data.type === "error") {
        const rawResponse = toJsonValue(message);
        const durationMs = Date.now() - startedAt;
        const failure = {
          status: "failure" as const,
          error: {
            message: parsed.data.error?.message ?? "OpenAI WebSocket request failed.",
          },
          rawResponse,
        };
        await this.#append({
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "provider-llm-request-completed",
            sourceEvent: args.event,
          }),
          payload: {
            connectionId: connection.id,
            llmRequestId,
            durationMs,
            result: failure,
          },
        });
        await this.#append({
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "agent-llm-request-completed",
            sourceEvent: args.event,
          }),
          payload: {
            llmRequestId,
            provider: OpenAiWsProcessorContract.slug,
            durationMs,
            result: failure,
          },
        });
        return;
      }
    }
  }

  async #appendProviderCompleted(args: {
    connectionId: string;
    durationMs: number;
    llmRequestId: number;
    responseId: string | undefined;
    result: {
      status: "success";
      rawResponse: JsonValue | undefined;
      usage?: JsonValue;
    };
    sourceEvent: LlmRequestRequestedEvent;
  }) {
    await this.#append({
      type: "events.iterate.com/openai-ws/llm-request-completed",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: OpenAiWsProcessorContract,
        key: "provider-llm-request-completed",
        sourceEvent: args.sourceEvent,
      }),
      payload: {
        connectionId: args.connectionId,
        llmRequestId: args.llmRequestId,
        durationMs: args.durationMs,
        ...(args.responseId == null ? {} : { responseId: args.responseId }),
        result: args.result,
      },
    });
  }

  async #isAgentLlmRequestStillCurrent(args: { llmRequestId: number }) {
    const events = await this.deps.readStreamEvents();
    const state = reduceAgentEvents({ events });
    return (
      state.currentRequest?.phase === "requested" &&
      state.currentRequest.llmRequestId === args.llmRequestId
    );
  }

  async #append(event: { type: string; idempotencyKey: string; payload: unknown }) {
    await this.ctx.stream.append({ event });
  }
}

function createConnectionId(args: { llmRequestId: number }) {
  return `openai_ws_${args.llmRequestId}_${crypto.randomUUID()}`;
}

async function waitForOpenAiResponsesSocketOpen(
  iterator: AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage>,
) {
  while (true) {
    const result = await iterator.next();
    if (result.done === true) throw new Error("OpenAI WebSocket stream ended before opening.");

    switch (result.value.type) {
      case "connecting":
        continue;
      case "open":
        return;
      case "close":
        throw new Error(
          `OpenAI WebSocket closed before opening: ${result.value.code} ${result.value.reason}`,
        );
      case "error":
        throw result.value.error;
      case "message":
      case "raw":
      case "closing":
      case "reconnecting":
      case "reconnected":
        continue;
      default:
        return assertNever(result.value);
    }
  }
}

async function nextOpenAiResponsesMessage(connection: OpenAiWsConnection): Promise<JsonValue> {
  while (true) {
    const result = await connection.iterator.next();
    if (result.done === true) throw new Error("OpenAI WebSocket stream ended.");

    switch (result.value.type) {
      case "message":
        return toJsonValue(result.value.message);
      case "raw":
        return parseRawSocketMessage(result.value.data);
      case "close":
        throw new Error(`OpenAI WebSocket closed: ${result.value.code} ${result.value.reason}`);
      case "error":
        throw result.value.error;
      case "connecting":
      case "open":
      case "closing":
      case "reconnecting":
      case "reconnected":
        continue;
      default:
        return assertNever(result.value);
    }
  }
}

function parseRawSocketMessage(message: unknown): JsonValue {
  const text =
    typeof message === "string"
      ? message
      : message instanceof ArrayBuffer
        ? new TextDecoder().decode(message)
        : String(message);
  return toJsonValue(JSON.parse(text));
}

function toJsonValue(value: unknown): JsonValue {
  return z.json().parse(value);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
