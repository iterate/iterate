// Implements the "cloudflare-ai" processor as a class-based StreamProcessor.
//
// Migrated from packages/shared/src/stream-processors/cloudflare-ai/implementation.ts.
// All appended events keep their legacy types, payload shapes, and
// idempotency-key derivations (`cloudflare-ai/<key>@<sourceOffset>`).
//
// The LLM request runs as keep-alive-backed background work
// (`runInBackground`): the serialized batch queue stays free while the
// provider call is in flight, so cancellations, superseding inputs, and config
// changes keep reducing instead of waiting behind the request they should
// affect. The still-current check before agent-visible appends
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

  protected override reduce(
    args: Parameters<StreamProcessor<CloudflareAiProcessorContract>["reduce"]>[0],
  ): CloudflareAiState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/agent/llm-request-requested":
      case "events.iterate.com/stream/subscriber-connected":
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
        this.#startLlmRequest({ event, state, runInBackground: args.runInBackground });
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
   * blocked on a provider call. Failures before the terminal events landed
   * release the id so dangling-started reconciliation can retry on a later
   * batch (the `started` append is idempotency-keyed, so a retry cannot
   * duplicate it).
   */
  #startLlmRequest(args: {
    event: LlmRequestRequestedEvent;
    state: CloudflareAiState;
    runInBackground: (work: () => Promise<unknown>) => void;
  }) {
    const llmRequestId = args.event.offset;
    this.#executedLlmRequestIds.add(llmRequestId);
    args.runInBackground(async () => {
      try {
        await this.#executeCloudflareAiRequest({ event: args.event, state: args.state });
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
    state: CloudflareAiState;
    sourceEvent: { offset: number };
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
      this.#startLlmRequest({
        event: reduction.event,
        state: args.state,
        runInBackground: args.runInBackground,
      });
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
      type: "events.iterate.com/cloudflare-ai/llm-request-attempt-failed",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CloudflareAiProcessorContract,
        key: `llm-request-attempt-failed/${args.llmRequestId}`,
        sourceEvent: args.sourceEvent,
      }),
      payload: { llmRequestId: args.llmRequestId, reason: args.reason },
    });
  }

  async #executeCloudflareAiRequest(args: {
    event: LlmRequestRequestedEvent;
    state: CloudflareAiState;
  }): Promise<void> {
    const llmRequestId = args.event.offset;
    // Skip only finished requests: a "started" entry means a previous
    // incarnation died mid-request, and the request must be retried — whether
    // it arrives here via a checkpoint-not-advanced replay or via
    // dangling-started reconciliation (the started append is
    // idempotency-keyed, so a retry cannot duplicate it). Mirrors the OpenAI
    // WebSocket processor.
    if (args.state.requests[String(llmRequestId)]?.status === "completed") return;

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
