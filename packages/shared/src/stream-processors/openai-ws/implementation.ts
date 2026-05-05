import { z } from "zod";
import {
  assertNever,
  buildDerivedIdempotencyKey,
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
  openWebSocket(args: { url: string }): Promise<WebSocket>;
};

export function createOpenAiWsProcessor(deps: OpenAiWsProcessorDeps) {
  let connectionSeq = 0;
  let previousResponseId: string | null = null;

  return implementProcessor(OpenAiWsProcessorContract, {
    async afterAppend({ event, state, streamApi }) {
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
        case "events.iterate.com/agent/llm-request-requested":
          await executeOpenAiWsRequest({
            deps,
            event,
            state,
            streamApi,
            connectionId: `openai_ws_${Date.now()}_${++connectionSeq}`,
            getPreviousResponseId: () => previousResponseId,
            setPreviousResponseId: (responseId) => {
              previousResponseId = responseId;
            },
          });
          return;
        default:
          return assertNever(event);
      }
    },
  });
}

async function executeOpenAiWsRequest(args: {
  deps: OpenAiWsProcessorDeps;
  event: Extract<OpenAiWsConsumedEvent, { type: "events.iterate.com/agent/llm-request-requested" }>;
  state: OpenAiWsState;
  streamApi: OpenAiWsStreamApi;
  connectionId: string;
  getPreviousResponseId(): string | null;
  setPreviousResponseId(responseId: string): void;
}) {
  const llmRequestId = args.event.offset;
  if (args.state.requests[String(llmRequestId)] != null) return;

  const url = "wss://api.openai.com/v1/responses";
  const startedAt = Date.now();
  let receiveSequence = 0;

  let socket: WebSocket;
  let receiver: WebSocketMessageReceiver | undefined;
  try {
    socket = await args.deps.openWebSocket({ url });
    await waitForSocketOpen(socket);
    receiver = createWebSocketMessageReceiver(socket);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const failure = {
      status: "failure" as const,
      error: { message: stringifyError(error) },
    };
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/openai-ws/llm-request-completed",
        idempotencyKey: buildDerivedIdempotencyKey({
          slug: OpenAiWsProcessorContract.slug,
          purpose: "provider-llm-request-completed",
          event: args.event,
        }),
        payload: {
          connectionId: args.connectionId,
          llmRequestId,
          durationMs,
          result: failure,
        },
      },
    });
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: buildDerivedIdempotencyKey({
          slug: OpenAiWsProcessorContract.slug,
          purpose: "agent-llm-request-completed",
          event: args.event,
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
      type: "events.iterate.com/openai-ws/websocket-connected",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: OpenAiWsProcessorContract.slug,
        purpose: "websocket-connected",
        event: args.event,
      }),
      payload: {
        connectionId: args.connectionId,
        url,
      },
    },
  });

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/openai-ws/llm-request-started",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: OpenAiWsProcessorContract.slug,
        purpose: "llm-request-started",
        event: args.event,
      }),
      payload: {
        connectionId: args.connectionId,
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
  const requestMessage = {
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
  };
  socket.send(JSON.stringify(requestMessage));
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/openai-ws/websocket-message-sent",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: OpenAiWsProcessorContract.slug,
        purpose: "websocket-message-sent",
        event: args.event,
      }),
      payload: {
        connectionId: args.connectionId,
        llmRequestId,
        sequence: 0,
        message: requestMessage,
      },
    },
  });

  let outputText = "";
  let finalResponse: JsonValue | undefined;

  while (true) {
    let rawMessage: unknown;
    try {
      rawMessage = await receiver.next();
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const failure = {
        status: "failure" as const,
        error: { message: stringifyError(error) },
      };
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/openai-ws/websocket-disconnected",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "websocket-disconnected",
            event: args.event,
          }),
          payload: {
            connectionId: args.connectionId,
          },
        },
      });
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "provider-llm-request-completed",
            event: args.event,
          }),
          payload: {
            connectionId: args.connectionId,
            llmRequestId,
            durationMs,
            result: failure,
          },
        },
      });
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "agent-llm-request-completed",
            event: args.event,
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

    receiveSequence += 1;
    const message = parseSocketJson(rawMessage);
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/openai-ws/websocket-message-received",
        idempotencyKey: buildDerivedIdempotencyKey({
          slug: OpenAiWsProcessorContract.slug,
          purpose: `websocket-message-received:${receiveSequence}`,
          event: args.event,
        }),
        payload: {
          connectionId: args.connectionId,
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
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "agent-output-added",
            event: args.event,
          }),
          payload: { content: outputText },
        },
      });
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "provider-llm-request-completed",
            event: args.event,
          }),
          payload: {
            connectionId: args.connectionId,
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
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "agent-llm-request-completed",
            event: args.event,
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
      socket.close(1000, "request completed");
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/openai-ws/websocket-disconnected",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "websocket-disconnected",
            event: args.event,
          }),
          payload: {
            connectionId: args.connectionId,
            code: 1000,
            reason: "request completed",
            wasClean: true,
          },
        },
      });
      return;
    }

    if (parsed.data.type === "response.failed" || parsed.data.type === "error") {
      socket.close(1011, "request failed");
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
          type: "events.iterate.com/openai-ws/websocket-disconnected",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "websocket-disconnected",
            event: args.event,
          }),
          payload: {
            connectionId: args.connectionId,
            code: 1011,
            reason: "request failed",
            wasClean: false,
          },
        },
      });
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/openai-ws/llm-request-completed",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "provider-llm-request-completed",
            event: args.event,
          }),
          payload: {
            connectionId: args.connectionId,
            llmRequestId,
            durationMs,
            result: failure,
          },
        },
      });
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: OpenAiWsProcessorContract.slug,
            purpose: "agent-llm-request-completed",
            event: args.event,
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

function waitForSocketOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("OpenAI WebSocket failed to open.")), {
      once: true,
    });
  });
}

type WebSocketMessageReceiver = {
  next(): Promise<unknown>;
};

function createWebSocketMessageReceiver(socket: WebSocket): WebSocketMessageReceiver {
  const messages: unknown[] = [];
  const waiters: Array<{
    resolve(value: unknown): void;
    reject(error: Error): void;
  }> = [];
  let terminalError: Error | undefined;

  const rejectWaiters = (error: Error) => {
    terminalError = error;
    while (waiters.length > 0) {
      waiters.shift()?.reject(error);
    }
  };

  socket.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter == null) {
      messages.push(event.data);
      return;
    }
    waiter.resolve(event.data);
  });
  socket.addEventListener("close", () => rejectWaiters(new Error("OpenAI WebSocket closed.")), {
    once: true,
  });
  socket.addEventListener("error", () => rejectWaiters(new Error("OpenAI WebSocket errored.")), {
    once: true,
  });

  return {
    async next() {
      const message = messages.shift();
      if (message !== undefined) return message;
      if (terminalError != null) throw terminalError;

      return await new Promise<unknown>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

function parseSocketJson(message: unknown): JsonValue {
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
