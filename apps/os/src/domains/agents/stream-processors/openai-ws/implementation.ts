// Implements the "openai-ws" processor.
//
// This file is a deliberate SIBLING of ../cloudflare-ai/implementation.ts:
// same method names, same control flow, same comments where the logic matches
// — the two differ only in transport (a Responses WebSocket vs one AI.run
// call). Stateless logic they share lives in ../llm-request-helpers.ts. When
// you fix something here, check whether the sibling needs the same fix.
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
} from "@iterate-com/shared/streams/stream-processors";
import {
  buildAgentLlmRequestBody,
  findDanglingLlmRequestIds,
  isAgentLlmRequestStillCurrent,
  parseLlmRequestRequestedEventAt,
} from "../llm-request-helpers.ts";
import { OpenAiWsProcessorContract, type OpenAiWsState } from "./contract.ts";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";

export { OpenAiWsProcessorContract } from "./contract.ts";

export type OpenAiWsProcessorContract = typeof OpenAiWsProcessorContract;

type OpenAiWsConsumedEvent = ConsumedEvent<OpenAiWsProcessorContract>;
type LlmRequestRequestedEvent = Extract<
  OpenAiWsConsumedEvent,
  { type: "events.iterate.com/agent/llm-request-requested" }
>;
type LlmRequestCancelledEvent = Extract<
  OpenAiWsConsumedEvent,
  { type: "events.iterate.com/agent/llm-request-cancelled" }
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
  #activeRequest: {
    llmRequestId: number;
    connection: OpenAiWsConnection | null;
  } | null = null;
  #cancelledLlmRequestIds = new Set<number>();

  /**
   * Requests this instance has taken responsibility for executing. The DO
   * instance is the execution scope: a fresh instance after a crash/wake
   * starts empty, which is what lets `#reconcileDanglingStartedRequests`
   * recognize requests a previous incarnation abandoned. Entries are removed
   * when execution fails before the terminal appends landed (so a later
   * connected event can retry) and once the request's completed fact has been
   * reduced back (re-execution is impossible then — the completed-skip is
   * durable), which keeps the set bounded on long-lived instances.
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
      case "events.iterate.com/stream/subscriber-connected":
      case "events.iterate.com/agent/llm-request-cancelled":
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
  ): undefined {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/openai-ws/config-updated":
      case "events.iterate.com/openai-ws/llm-request-started":
        return;
      case "events.iterate.com/openai-ws/llm-request-completed":
        // The completed fact is durable; this instance can never need to
        // (re-)execute this request again, so drop the claim — this is what
        // keeps the executed set bounded.
        this.#executedLlmRequestIds.delete(event.payload.llmRequestId);
        return;
      case "events.iterate.com/agent/llm-request-requested":
        this.#startLlmRequest({ event, state, runInBackground: args.runInBackground });
        return;
      case "events.iterate.com/agent/llm-request-cancelled":
        this.#handleLlmRequestCancelled(event);
        return;
      case "events.iterate.com/stream/subscriber-connected":
        // The reconcile trigger: a fresh connection means some host's runtime
        // state was reset. The connected event is always the tail of any batch
        // it shares (appended after the handshake fixes the replay offset), so
        // `state` here already reflects every replayed started/completed
        // event. Blocking holds the checkpoint until the history read and
        // re-execution scheduling land, so a failure redelivers this event.
        args.blockProcessorWhile(() =>
          this.#reconcileDanglingStartedRequests({
            state,
            sourceEvent: event,
            runInBackground: args.runInBackground,
          }),
        );
        return;
      default:
        return assertNever(event);
    }
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
    if (args.event.payload.provider !== OpenAiWsProcessorContract.slug) return;
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
   * incarnation, so record the dead attempt with an explicit attempt-failed
   * event and re-execute from the original requested event in stream history
   * (its offset is the llmRequestId). Stale recoveries finish gracefully: the
   * still-current check skips agent-visible output and the terminal completed
   * event flips the entry out of `started`. History is only read when a
   * dangling entry exists, keeping the common path cheap.
   */
  async #reconcileDanglingStartedRequests(args: {
    state: OpenAiWsState;
    sourceEvent: { offset: number };
    runInBackground: (work: () => Promise<unknown>) => void;
  }) {
    const danglingIds = findDanglingLlmRequestIds({
      requests: args.state.requests,
      executedLlmRequestIds: this.#executedLlmRequestIds,
    });
    if (danglingIds.length === 0) return;

    // Claim synchronously, before the first await: one batch routinely
    // carries several subscriber-connected events (a processor host
    // re-handshake appends one per co-hosted processor subscription) and
    // their blocking reconciles run concurrently — without the eager claim
    // each would observe the same dangling entries and start duplicate LLM
    // executions. Claims still held by this pass are released on failure so
    // a later connected event can retry.
    const heldClaims = new Set(danglingIds);
    for (const llmRequestId of heldClaims) this.#executedLlmRequestIds.add(llmRequestId);

    try {
      const events = await this.deps.readStreamEvents();
      for (const llmRequestId of danglingIds) {
        const requestedEvent = parseLlmRequestRequestedEventAt({ events, llmRequestId });
        if (requestedEvent === null) {
          // The entry cannot be tied back to a requested event, so it is
          // unrecoverable; the claim stays so it stops triggering history reads.
          heldClaims.delete(llmRequestId);
          await this.#appendAttemptFailed({
            llmRequestId,
            reason: "unrecoverable",
            sourceEvent: args.sourceEvent,
          });
          continue;
        }
        await this.#appendAttemptFailed({
          llmRequestId,
          reason: "host-restarted",
          sourceEvent: args.sourceEvent,
        });
        // Handed to the executor: its own failure handling owns the claim now.
        heldClaims.delete(llmRequestId);
        this.#startLlmRequest({
          event: requestedEvent,
          state: args.state,
          runInBackground: args.runInBackground,
        });
      }
    } catch (error) {
      for (const llmRequestId of heldClaims) this.#executedLlmRequestIds.delete(llmRequestId);
      throw error;
    }
  }

  /**
   * Records that a previous execution attempt died before its terminal events
   * landed. Keyed off the triggering connected event, so a redelivered batch
   * cannot double-record while each new incarnation's recovery still does.
   */
  async #appendAttemptFailed(args: {
    llmRequestId: number;
    reason: "host-restarted" | "unrecoverable";
    sourceEvent: { offset: number };
  }) {
    await this.#append({
      type: "events.iterate.com/openai-ws/llm-request-attempt-failed",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: OpenAiWsProcessorContract,
        key: `llm-request-attempt-failed/${args.llmRequestId}`,
        sourceEvent: args.sourceEvent,
      }),
      payload: { llmRequestId: args.llmRequestId, reason: args.reason },
    });
  }

  async #getConnection(sourceEvent: LlmRequestRequestedEvent): Promise<OpenAiWsConnection> {
    if (this.#connection?.client.socket.readyState === OpenAiWebSocketReadyState.Open) {
      return this.#connection;
    }

    const connectionId = `openai_ws_${sourceEvent.offset}_${crypto.randomUUID()}`;
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
    if (this.#connection?.id !== closedConnection.id) return;
    this.#connection = null;
    this.#previousResponseId = null;
  }

  #handleLlmRequestCancelled(event: LlmRequestCancelledEvent) {
    if (event.payload.phase !== "requested") return;
    const llmRequestId = event.payload.llmRequestId;
    this.#cancelledLlmRequestIds.add(llmRequestId);
    if (this.#activeRequest?.llmRequestId !== llmRequestId) return;
    this.#previousResponseId = null;
    this.#activeRequest.connection?.client.close({
      code: 1000,
      reason: "llm-request-cancelled",
    });
  }

  #clearActiveRequest(llmRequestId: number) {
    if (this.#activeRequest?.llmRequestId === llmRequestId) this.#activeRequest = null;
  }

  async #executeOpenAiWsRequest(args: {
    event: LlmRequestRequestedEvent;
    state: OpenAiWsState;
  }): Promise<void> {
    const llmRequestId = args.event.offset;
    if (args.state.requests[String(llmRequestId)]?.status === "completed") return;
    if (this.#cancelledLlmRequestIds.has(llmRequestId)) {
      await this.#appendProviderFailed({
        durationMs: 0,
        llmRequestId,
        message: "LLM request was cancelled before provider execution started.",
        sourceEvent: args.event,
      });
      this.#cancelledLlmRequestIds.delete(llmRequestId);
      return;
    }

    const startedAt = Date.now();
    this.#activeRequest = { llmRequestId, connection: null };

    let connection: OpenAiWsConnection;
    try {
      connection = await this.#getConnection(args.event);
      if (this.#activeRequest?.llmRequestId === llmRequestId) {
        this.#activeRequest = { llmRequestId, connection };
      }
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
      this.#clearActiveRequest(llmRequestId);
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

    // Request-by-reference: the requested event carries no body; rebuild the
    // chat request from committed history up to the request's own offset.
    const body = buildAgentLlmRequestBody({
      events: await this.deps.readStreamEvents(),
      llmRequestId,
    });
    const systemMessages = body.messages.filter((message) => message.role === "system");
    const inputMessages = body.messages.filter((message) => message.role !== "system");
    const previousResponseId = this.#previousResponseId;
    /**
     * `store: false` keeps this out of OpenAI's stored response retention, but
     * WebSocket mode can still chain the immediate conversation by carrying
     * `previous_response_id` from the prior completed response. The rebuilt
     * chat request remains the source of truth for what we explicitly send.
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
      // Reasoning models stream `response.reasoning_summary_text.delta`
      // frames when summaries are requested; those land on the stream like
      // every other frame so the UI can show thinking as it happens.
      ...(supportsReasoningSummaries(args.state.model) ? { reasoning: { summary: "auto" } } : {}),
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
        if (this.#cancelledLlmRequestIds.has(llmRequestId)) {
          await this.#append({
            type: "events.iterate.com/openai-ws/websocket-disconnected",
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: OpenAiWsProcessorContract,
              key: `websocket-disconnected/${connection.id}`,
              sourceEvent: args.event,
            }),
            payload: {
              connectionId: connection.id,
              code: 1000,
              reason: "llm-request-cancelled",
              wasClean: true,
            },
          });
          await this.#appendProviderFailed({
            connectionId: connection.id,
            durationMs,
            llmRequestId,
            message: "LLM request was cancelled.",
            sourceEvent: args.event,
          });
          this.#cancelledLlmRequestIds.delete(llmRequestId);
          this.#clearActiveRequest(llmRequestId);
          return;
        }
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
        this.#clearActiveRequest(llmRequestId);
        return;
      }

      const message = toJsonValue(rawMessage);
      const parsed = OpenAiResponsesStreamMessage.safeParse(message);
      if (parsed.success && parsed.data.type === "response.output_text.delta") {
        outputText += parsed.data.delta ?? "";
      }

      // Every frame — including output_text and reasoning summary deltas —
      // lands on the stream verbatim, so subscribers (e.g. the browser agent
      // UI) can render responses and thinking as they stream.
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
          this.#clearActiveRequest(llmRequestId);
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
        this.#clearActiveRequest(llmRequestId);
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
        this.#clearActiveRequest(llmRequestId);
        return;
      }
    }
  }

  async #appendProviderFailed(args: {
    connectionId?: string;
    durationMs: number;
    llmRequestId: number;
    message: string;
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
        ...(args.connectionId == null ? {} : { connectionId: args.connectionId }),
        llmRequestId: args.llmRequestId,
        durationMs: args.durationMs,
        result: {
          status: "failure",
          error: { message: args.message },
        },
      },
    });
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
    return isAgentLlmRequestStillCurrent({
      events: await this.deps.readStreamEvents(),
      llmRequestId: args.llmRequestId,
    });
  }

  async #append(event: { type: string; idempotencyKey: string; payload: unknown }) {
    await this.ctx.stream.append({ event });
  }
}

/**
 * Sending `reasoning` options to a non-reasoning model fails the whole
 * request, so only ask for summaries on model families known to reason.
 */
function supportsReasoningSummaries(model: string) {
  return /^(gpt-5|o[1-9]|codex)/.test(model);
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
