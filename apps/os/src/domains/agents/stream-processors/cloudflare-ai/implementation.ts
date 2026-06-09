// Implements the "cloudflare-ai" processor as a class-based StreamProcessor.
//
// Migrated from packages/shared/src/stream-processors/cloudflare-ai/implementation.ts.
// All appended events keep their legacy types, payload shapes, and
// idempotency-key derivations (`cloudflare-ai/<key>@<sourceOffset>`).
//
// The LLM request runs under `blockProcessorWhile`: the checkpoint must not
// advance past a request whose terminal events have not been appended, so a
// failed request is re-delivered and retried (the `requests` state map dedupes
// already-started/completed ones).

import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  type ConsumedEvent,
  type StreamEvent,
} from "@iterate-com/streams/shared/stream-processors";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { reduceAgentEvents } from "../agent/contract.ts";
import { CloudflareAiProcessorContract, type CloudflareAiState } from "./contract.ts";

export { CloudflareAiProcessorContract } from "./contract.ts";

export type CloudflareAiProcessorContract = typeof CloudflareAiProcessorContract;

type CloudflareAiConsumedEvent = ConsumedEvent<CloudflareAiProcessorContract>;
type LlmRequestRequestedEvent = Extract<
  CloudflareAiConsumedEvent,
  { type: "events.iterate.com/agent/llm-request-requested" }
>;
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

/**
 * Cloudflare's Workers AI binding accepts `AI.run(model, body, options)`;
 * Gateway metadata such as `gateway.id` travels in the options argument.
 * https://developers.cloudflare.com/ai-gateway/providers/workersai/
 */
export type CloudflareAiBinding = {
  run(model: string, body: unknown, runOpts?: unknown): Promise<unknown>;
  aiGatewayLogId?: string;
};

export type CloudflareAiProcessorDeps = {
  /** Undefined when the worker has no AI binding; requests then fail with a clear error event. */
  ai: CloudflareAiBinding | undefined;
  /**
   * Reads the full committed history of the agent's stream so the processor
   * can confirm the request is still current before appending agent output.
   */
  readStreamEvents(): Promise<StreamEvent[]>;
};

export class CloudflareAiProcessor extends StreamProcessor<
  CloudflareAiProcessorContract,
  CloudflareAiProcessorDeps
> {
  readonly contract = CloudflareAiProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<CloudflareAiProcessorContract>["reduce"]>[0],
  ): CloudflareAiState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/agent/llm-request-requested":
        return state;
      case "events.iterate.com/cloudflare-ai/llm-request-started":
        return {
          ...state,
          requests: {
            ...state.requests,
            [String(event.payload.llmRequestId)]: { status: "started" as const },
          },
        };
      case "events.iterate.com/cloudflare-ai/llm-request-completed":
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
    args: Parameters<StreamProcessor<CloudflareAiProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/cloudflare-ai/llm-request-started":
      case "events.iterate.com/cloudflare-ai/llm-request-completed":
        return;
      case "events.iterate.com/agent/llm-request-requested":
        args.blockProcessorWhile(() => this.#executeCloudflareAiRequest({ event, state }));
        return;
      default:
        return assertNever(event);
    }
  }

  async #executeCloudflareAiRequest(args: {
    event: LlmRequestRequestedEvent;
    state: CloudflareAiState;
  }): Promise<void> {
    const llmRequestId = args.event.offset;
    if (args.state.requests[String(llmRequestId)] != null) return;

    const ai = this.deps.ai;
    if (ai == null) {
      throw new Error("AI binding is required for the Cloudflare AI agent processor.");
    }

    const startedAt = Date.now();

    await this.#append({
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
    });

    let raw: unknown;
    try {
      raw = await ai.run(
        args.event.payload.model,
        args.event.payload.body,
        args.event.payload.runOpts,
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const failure = {
        status: "failure" as const,
        error: { message: stringifyError(error) },
        ...(ai.aiGatewayLogId == null ? {} : { aiGatewayLogId: ai.aiGatewayLogId }),
      };
      await this.#append({
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
      });
      await this.#append({
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
        ...(ai.aiGatewayLogId == null ? {} : { aiGatewayLogId: ai.aiGatewayLogId }),
      };
      await this.#append({
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
      });
      await this.#append({
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
      });
      return;
    }

    const rawResponse = toJsonValue(raw);
    const usage = extractUsage(raw);
    const durationMs = Date.now() - startedAt;

    if (!(await this.#isAgentLlmRequestStillCurrent({ llmRequestId }))) {
      await this.#appendProviderCompleted({
        durationMs,
        llmRequestId,
        result: {
          status: "success",
          rawResponse,
          ...(usage == null ? {} : { usage }),
          ...(ai.aiGatewayLogId == null ? {} : { aiGatewayLogId: ai.aiGatewayLogId }),
        },
        sourceEvent: args.event,
      });
      return;
    }

    await this.#append({
      type: "events.iterate.com/agent/output-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CloudflareAiProcessorContract,
        key: "agent-output-added",
        sourceEvent: args.event,
      }),
      payload: { content: assistantText, llmRequestId },
    });
    await this.#appendProviderCompleted({
      durationMs,
      llmRequestId,
      result: {
        status: "success",
        rawResponse,
        ...(usage == null ? {} : { usage }),
        ...(ai.aiGatewayLogId == null ? {} : { aiGatewayLogId: ai.aiGatewayLogId }),
      },
      sourceEvent: args.event,
    });
    await this.#append({
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
    });
  }

  async #appendProviderCompleted(args: {
    durationMs: number;
    llmRequestId: number;
    result: {
      status: "success";
      rawResponse: JsonValue;
      usage?: JsonValue;
      aiGatewayLogId?: string;
    };
    sourceEvent: LlmRequestRequestedEvent;
  }) {
    await this.#append({
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
