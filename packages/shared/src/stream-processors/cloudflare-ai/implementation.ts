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
import { reduceAgentEvents } from "../agent/contract.ts";
import { CloudflareAiProcessorContract, type CloudflareAiState } from "./contract.ts";

type CloudflareAiStreamApi = ProcessorStreamApi<typeof CloudflareAiProcessorContract>;
type CloudflareAiConsumedEvent = ConsumedEvent<typeof CloudflareAiProcessorContract>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

const OpenAiChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.json().optional(),
  id: z.string().optional(),
});

const AnthropicAssistantMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
  usage: z.json().optional(),
  id: z.string().optional(),
});

const WorkersAiChatResponse = z.object({
  response: z.string(),
});

export type CloudflareAiProcessorDeps = {
  ai: {
    /**
     * Cloudflare's Workers AI binding accepts `AI.run(model, body, options)`;
     * Gateway metadata such as `gateway.id` travels in the options argument.
     *
     * https://developers.cloudflare.com/ai-gateway/providers/workersai/
     */
    run(model: string, body: unknown, runOpts?: unknown): Promise<unknown>;
    aiGatewayLogId?: string;
  };
};

export function createCloudflareAiProcessor(deps: CloudflareAiProcessorDeps) {
  return implementProcessor(CloudflareAiProcessorContract, {
    async afterAppend({ event, state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: CloudflareAiProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/cloudflare-ai/llm-request-started":
        case "events.iterate.com/cloudflare-ai/llm-request-completed":
          return;
        case "events.iterate.com/agent/llm-request-requested":
          await executeCloudflareAiRequest({
            deps,
            event,
            state,
            streamApi,
          });
          return;
        default:
          return assertNever(event);
      }
    },
  });
}

async function executeCloudflareAiRequest(args: {
  deps: CloudflareAiProcessorDeps;
  event: Extract<
    CloudflareAiConsumedEvent,
    { type: "events.iterate.com/agent/llm-request-requested" }
  >;
  state: CloudflareAiState;
  streamApi: CloudflareAiStreamApi;
}) {
  const llmRequestId = args.event.offset;
  if (args.state.requests[String(llmRequestId)] != null) return;

  const startedAt = Date.now();

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/cloudflare-ai/llm-request-started",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CloudflareAiProcessorContract,
        key: "llm-request-started",
        sourceEvent: args.event,
      }),
      payload: {
        llmRequestId,
        model: args.event.payload.model,
        body: args.event.payload.body,
        runOpts: args.event.payload.runOpts,
      },
    },
  });

  let raw: unknown;
  try {
    raw = await args.deps.ai.run(
      args.event.payload.model,
      args.event.payload.body,
      args.event.payload.runOpts,
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const failure = {
      status: "failure" as const,
      error: { message: stringifyError(error) },
      ...(args.deps.ai.aiGatewayLogId == null
        ? {}
        : { aiGatewayLogId: args.deps.ai.aiGatewayLogId }),
    };
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/cloudflare-ai/llm-request-completed",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: CloudflareAiProcessorContract,
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
          processor: CloudflareAiProcessorContract,
          key: "agent-llm-request-completed",
          sourceEvent: args.event,
        }),
        payload: {
          llmRequestId,
          provider: CloudflareAiProcessorContract.slug,
          durationMs,
          result: {
            status: "failure",
            error: failure.error,
          },
        },
      },
    });
    return;
  }

  let assistantText: string;
  try {
    assistantText = extractCloudflareAssistantText(raw);
  } catch (error) {
    const rawResponse = toJsonValue(raw);
    const durationMs = Date.now() - startedAt;
    const failure = {
      status: "failure" as const,
      error: { message: stringifyError(error) },
      rawResponse,
      ...(args.deps.ai.aiGatewayLogId == null
        ? {}
        : { aiGatewayLogId: args.deps.ai.aiGatewayLogId }),
    };
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/cloudflare-ai/llm-request-completed",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: CloudflareAiProcessorContract,
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
          processor: CloudflareAiProcessorContract,
          key: "agent-llm-request-completed",
          sourceEvent: args.event,
        }),
        payload: {
          llmRequestId,
          provider: CloudflareAiProcessorContract.slug,
          durationMs,
          result: {
            status: "failure",
            error: failure.error,
            rawResponse,
          },
        },
      },
    });
    return;
  }

  const rawResponse = toJsonValue(raw);
  const usage = extractUsage(raw);
  const durationMs = Date.now() - startedAt;

  if (
    !(await isAgentLlmRequestStillCurrent({
      llmRequestId,
      streamApi: args.streamApi,
    }))
  ) {
    await appendProviderCompleted({
      durationMs,
      llmRequestId,
      result: {
        status: "success",
        rawResponse,
        ...(usage == null ? {} : { usage }),
        ...(args.deps.ai.aiGatewayLogId == null
          ? {}
          : { aiGatewayLogId: args.deps.ai.aiGatewayLogId }),
      },
      sourceEvent: args.event,
      streamApi: args.streamApi,
    });
    return;
  }

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/output-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CloudflareAiProcessorContract,
        key: "agent-output-added",
        sourceEvent: args.event,
      }),
      payload: { content: assistantText, llmRequestId },
    },
  });
  await appendProviderCompleted({
    durationMs,
    llmRequestId,
    result: {
      status: "success",
      rawResponse,
      ...(usage == null ? {} : { usage }),
      ...(args.deps.ai.aiGatewayLogId == null
        ? {}
        : { aiGatewayLogId: args.deps.ai.aiGatewayLogId }),
    },
    sourceEvent: args.event,
    streamApi: args.streamApi,
  });
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/llm-request-completed",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CloudflareAiProcessorContract,
        key: "agent-llm-request-completed",
        sourceEvent: args.event,
      }),
      payload: {
        llmRequestId,
        provider: CloudflareAiProcessorContract.slug,
        durationMs,
        result: {
          status: "success",
          rawResponse,
          ...(usage == null ? {} : { usage }),
        },
      },
    },
  });
}

async function appendProviderCompleted(args: {
  durationMs: number;
  llmRequestId: number;
  result: {
    status: "success";
    rawResponse: JsonValue;
    usage?: JsonValue;
    aiGatewayLogId?: string;
  };
  sourceEvent: Extract<
    CloudflareAiConsumedEvent,
    { type: "events.iterate.com/agent/llm-request-requested" }
  >;
  streamApi: CloudflareAiStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/cloudflare-ai/llm-request-completed",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CloudflareAiProcessorContract,
        key: "provider-llm-request-completed",
        sourceEvent: args.sourceEvent,
      }),
      payload: {
        llmRequestId: args.llmRequestId,
        durationMs: args.durationMs,
        result: args.result,
      },
    },
  });
}

async function isAgentLlmRequestStillCurrent(args: {
  llmRequestId: number;
  streamApi: CloudflareAiStreamApi;
}) {
  const events = await args.streamApi.read({
    afterOffset: "start",
    beforeOffset: "end",
  });
  const state = reduceAgentEvents({ events });
  return (
    state.currentRequest?.phase === "requested" &&
    state.currentRequest.llmRequestId === args.llmRequestId
  );
}

function extractCloudflareAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;

  const openAI = OpenAiChatCompletionResponse.safeParse(raw);
  if (openAI.success) return openAI.data.choices[0].message.content;

  const anthropic = AnthropicAssistantMessage.safeParse(raw);
  if (anthropic.success) {
    return anthropic.data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }

  const workersAI = WorkersAiChatResponse.safeParse(raw);
  if (workersAI.success) return workersAI.data.response;

  throw new Error("Cloudflare AI response did not contain assistant text.");
}

function extractUsage(raw: unknown): JsonValue | null {
  const parsed = z.object({ usage: z.json() }).safeParse(raw);
  return parsed.success ? parsed.data.usage : null;
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
