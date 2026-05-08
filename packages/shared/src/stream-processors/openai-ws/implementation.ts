import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { OpenAiWsProcessorContract, type OpenAiWsState } from "./contract.ts";

type OpenAiWsStreamApi = ProcessorStreamApi<typeof OpenAiWsProcessorContract>;
type OpenAiWsConsumedEvent = ConsumedEvent<typeof OpenAiWsProcessorContract>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

const OpenAiResponsesStreamMessage = z
  .object({
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
  })
  .passthrough();

export type OpenAiWsProcessorDeps = {
  openResponsesWebSocket(): Promise<OpenAiResponsesWebSocket>;
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

export function createOpenAiWsProcessor(deps: OpenAiWsProcessorDeps) {
  /**
   * This is intentionally processor-runner instance state, not per-request
   * state. Responses WebSocket mode is a transport that can carry many
   * `response.create` requests. The previous proof opened the socket inside
   * request execution and closed it after `response.completed`, which confused
   * the lifetime of one LLM request with the lifetime of the WebSocket
   * connection. Keeping this connection here means sequential agent requests
   * reuse the same socket until OpenAI or the runtime actually closes it.
   */
  let connection: OpenAiWsConnection | null = null;
  let previousResponseId: string | null = null;

  return implementProcessor(OpenAiWsProcessorContract, {
    async afterAppend({ event, state, streamApi, waitUntil }) {
      await standardProcessorBehavior.afterAppend({
        contract: OpenAiWsProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/openai-ws/config-updated":
        case "events.iterate.com/openai-ws/llm-request-started":
        case "events.iterate.com/openai-ws/llm-request-completed":
          return;
        case "events.iterate.com/agent/llm-request-requested": {
          const request = executeOpenAiWsRequest({
            event,
            state,
            streamApi,
            getConnection: async () => {
              if (connection?.client.socket.readyState === OpenAiWebSocketReadyState.Open) {
                return connection;
              }

              connection = await openOpenAiWsConnection({
                deps,
                streamApi,
                sourceEvent: event,
                connectionId: createConnectionId({ llmRequestId: event.offset }),
              });
              return connection;
            },
            markConnectionClosed: (closedConnection) => {
              if (connection?.id === closedConnection.id) connection = null;
            },
            getPreviousResponseId: () => previousResponseId,
            setPreviousResponseId: (responseId) => {
              previousResponseId = responseId;
            },
          });
          if (waitUntil == null) {
            await request;
          } else {
            waitUntil(request);
          }
          return;
        }
        default:
          return assertNever(event);
      }
    },
  });
}

async function executeOpenAiWsRequest(args: {
  event: Extract<OpenAiWsConsumedEvent, { type: "events.iterate.com/agent/llm-request-requested" }>;
  state: OpenAiWsState;
  streamApi: OpenAiWsStreamApi;
  getConnection(): Promise<OpenAiWsConnection>;
  markConnectionClosed(connection: OpenAiWsConnection): void;
  getPreviousResponseId(): string | null;
  setPreviousResponseId(responseId: string): void;
}) {
  const llmRequestId = args.event.offset;
  if (args.state.requests[String(llmRequestId)]?.status === "completed") return;

  const startedAt = Date.now();

  let connection: OpenAiWsConnection;
  try {
    connection = await args.getConnection();
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const failure = {
      status: "failure" as const,
      error: { message: stringifyError(error) },
    };
    await args.streamApi.append({
      event: {
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
      },
    });
    await args.streamApi.append({
      event: {
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
      },
    });
    return;
  }

  await args.streamApi.append({
    event: {
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
    },
  });

  const systemMessages = args.event.payload.body.messages.filter(
    (message) => message.role === "system",
  );
  const inputMessages = args.event.payload.body.messages.filter(
    (message) => message.role !== "system",
  );
  const previousResponseId = args.getPreviousResponseId();
  /**
   * `store: false` keeps this proof out of OpenAI's stored response retention,
   * but WebSocket mode can still chain the immediate conversation by carrying
   * `previous_response_id` from the prior completed response. That is why this
   * processor keeps `previousResponseId` separately from the stream state: it is
   * transport/provider continuation data, not agent history. The agent request
   * body remains the source of truth for what we explicitly send this turn.
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
  await args.streamApi.append({
    event: {
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
    },
  });

  let outputText = "";
  let finalResponse: JsonValue | undefined;

  while (true) {
    let rawMessage: unknown;
    try {
      rawMessage = await nextOpenAiResponsesMessage(connection);
    } catch (error) {
      args.markConnectionClosed(connection);
      const durationMs = Date.now() - startedAt;
      const failure = {
        status: "failure" as const,
        error: { message: stringifyError(error) },
      };
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/openai-ws/websocket-disconnected",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: `websocket-disconnected/${connection.id}`,
            sourceEvent: args.event,
          }),
          payload: {
            connectionId: connection.id,
          },
        },
      });
      await args.streamApi.append({
        event: {
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
        },
      });
      await args.streamApi.append({
        event: {
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
        },
      });
      return;
    }

    const receiveSequence = connection.receiveSequence++;
    const message = toJsonValue(rawMessage);
    await args.streamApi.append({
      event: {
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
      },
    });

    const parsed = OpenAiResponsesStreamMessage.safeParse(message);
    if (!parsed.success) continue;

    if (parsed.data.type === "response.output_text.delta") {
      outputText += parsed.data.delta ?? "";
      continue;
    }

    if (parsed.data.type === "response.completed") {
      finalResponse = toJsonValue(parsed.data.response ?? message);
      const responseId = parsed.data.response?.id;
      if (responseId != null) args.setPreviousResponseId(responseId);
      const durationMs = Date.now() - startedAt;
      const usage = parsed.data.response?.usage;
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/agent/output-added",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: OpenAiWsProcessorContract,
            key: "agent-output-added",
            sourceEvent: args.event,
          }),
          payload: { content: outputText },
        },
      });
      await args.streamApi.append({
        event: {
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
            ...(responseId == null ? {} : { responseId }),
            result: {
              status: "success",
              rawResponse: finalResponse,
              ...(usage == null ? {} : { usage }),
            },
          },
        },
      });
      await args.streamApi.append({
        event: {
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
      await args.streamApi.append({
        event: {
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
        },
      });
      await args.streamApi.append({
        event: {
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
        },
      });
      return;
    }
  }
}

async function openOpenAiWsConnection(args: {
  deps: OpenAiWsProcessorDeps;
  streamApi: OpenAiWsStreamApi;
  sourceEvent: Extract<
    OpenAiWsConsumedEvent,
    { type: "events.iterate.com/agent/llm-request-requested" }
  >;
  connectionId: string;
}): Promise<OpenAiWsConnection> {
  const client = await args.deps.openResponsesWebSocket();
  const iterator = client.stream();
  await waitForOpenAiResponsesSocketOpen(iterator);

  const connection = {
    id: args.connectionId,
    url: String(client.url),
    client,
    iterator,
    receiveSequence: 0,
    sendSequence: 0,
  };

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/openai-ws/websocket-connected",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: OpenAiWsProcessorContract,
        key: `websocket-connected/${connection.id}`,
        sourceEvent: args.sourceEvent,
      }),
      payload: {
        connectionId: connection.id,
        url: connection.url,
      },
    },
  });

  return connection;
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
