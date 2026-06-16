// Implements the "cloudflare-ai" processor.
//
// This file is a deliberate SIBLING of ../openai-ws/implementation.ts: same
// method names, same control flow, same comments where the logic matches —
// the two differ only in transport (one AI.run call vs a Responses WebSocket).
// Stateless logic they share lives in ../llm-request-helpers.ts. When you fix
// something here, check whether the sibling needs the same fix.
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
} from "@iterate-com/shared/streams/stream-processors";
import {
  buildAgentLlmRequestBody,
  findDanglingLlmRequestIds,
  isAgentLlmRequestStillCurrent,
  parseLlmRequestRequestedEventAt,
} from "../llm-request-helpers.ts";
import { CloudflareAiProcessorContract, type CloudflareAiState } from "./contract.ts";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";

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

export type CloudflareAiBinding = {
  run(model: string, body: unknown): Promise<unknown>;
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
   * recognize requests a previous incarnation abandoned. Entries are removed
   * when execution fails before the terminal appends landed (so a later
   * connected event can retry) and once the request's completed fact has been
   * reduced back (re-execution is impossible then — the completed-skip is
   * durable), which keeps the set bounded on long-lived instances.
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
        return;
      case "events.iterate.com/cloudflare-ai/llm-request-completed":
        // The completed fact is durable; this instance can never need to
        // (re-)execute this request again, so drop the claim — this is what
        // keeps the executed set bounded.
        this.#executedLlmRequestIds.delete(event.payload.llmRequestId);
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
    if (args.event.payload.provider !== CloudflareAiProcessorContract.slug) return;
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
      },
    });

    // Request-by-reference: the requested event carries no body; rebuild the
    // chat request from committed history up to the request's own offset.
    const body = buildAgentLlmRequestBody({
      events: await this.deps.readStreamEvents(),
      llmRequestId,
    });

    // Streaming on: every chunk lands on the stream as it arrives so
    // subscribers (e.g. the browser agent UI) can render text and thinking
    // deltas live. Models that ignore `stream: true` return a plain object
    // and fall through to the non-streaming extraction below.
    let raw: unknown;
    let streamed: StreamedCloudflareAiResponse | null = null;
    try {
      raw = await ai.run(args.event.payload.model, { ...body, stream: true });
      if (raw instanceof ReadableStream) {
        streamed = await this.#consumeCloudflareAiStream({
          body: raw,
          llmRequestId,
          sourceEvent: args.event,
        });
      }
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
      if (streamed == null) {
        assistantText = extractCloudflareAssistantText(raw);
      } else {
        // A stream that carried no text deltas (usage-only, or a model that
        // produced no content) is an empty completion, not a failure.
        assistantText = streamed.text;
      }
    } catch (error) {
      const rawResponse = streamed == null ? toJsonValue(raw) : streamedRawResponse(streamed);
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

    const rawResponse = streamed == null ? toJsonValue(raw) : streamedRawResponse(streamed);
    const usage = streamed == null ? extractUsage(raw) : streamed.usage;
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
    return isAgentLlmRequestStillCurrent({
      events: await this.deps.readStreamEvents(),
      llmRequestId: args.llmRequestId,
    });
  }

  /**
   * Drains a streaming AI.run response, appending every parsed SSE data
   * payload verbatim as an llm-response-chunk event while accumulating the
   * assistant text and trailing usage for the terminal events.
   */
  async #consumeCloudflareAiStream(args: {
    body: ReadableStream<Uint8Array>;
    llmRequestId: number;
    sourceEvent: LlmRequestRequestedEvent;
  }): Promise<StreamedCloudflareAiResponse> {
    const decoder = new TextDecoder();
    const reader = args.body.getReader();
    let buffered = "";
    let sequence = 0;
    let text = "";
    let usage: JsonValue | null = null;

    const handleFrame = async (frame: string) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (data === "" || data === "[DONE]") return;
      let chunk: JsonValue;
      try {
        chunk = toJsonValue(JSON.parse(data));
      } catch {
        chunk = data;
      }
      text += extractChunkDeltaText(chunk);
      const chunkUsage = extractUsage(chunk);
      if (chunkUsage != null) usage = chunkUsage;
      await this.#append({
        type: "events.iterate.com/cloudflare-ai/llm-response-chunk",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: CloudflareAiProcessorContract,
          key: `llm-response-chunk/${sequence}`,
          sourceEvent: args.sourceEvent,
        }),
        payload: { llmRequestId: args.llmRequestId, sequence, chunk },
      });
      sequence += 1;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // SSE frames are blank-line separated; the last split piece may be a
      // partial frame, so it stays buffered for the next read.
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) await handleFrame(frame);
    }
    buffered += decoder.decode();
    await handleFrame(buffered);

    return { text, usage, chunkCount: sequence };
  }

  async #append(event: { type: string; idempotencyKey: string; payload: unknown }) {
    await this.ctx.stream.append({ event });
  }
}

type StreamedCloudflareAiResponse = {
  text: string;
  usage: JsonValue | null;
  chunkCount: number;
};

/**
 * Stand-in rawResponse for streamed runs: the chunk events are the verbatim
 * record, so the terminal event carries the reassembled text instead of a
 * provider response object.
 */
function streamedRawResponse(streamed: StreamedCloudflareAiResponse): JsonValue {
  return {
    streamed: true,
    response: streamed.text,
    chunkCount: streamed.chunkCount,
    ...(streamed.usage == null ? {} : { usage: streamed.usage }),
  };
}

const OpenAiChatCompletionChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullable().optional() }).nullable().optional(),
      }),
    )
    .min(1),
});

const AnthropicStreamDelta = z.object({
  delta: z.object({ text: z.string().optional() }),
});

const WorkersAiChunk = z.object({ response: z.string() });

/**
 * Pulls the assistant-text delta out of one provider-shaped streaming chunk.
 * Reasoning/thinking deltas are deliberately not folded into the assistant
 * text — they stay visible in the verbatim chunk events.
 */
function extractChunkDeltaText(chunk: JsonValue): string {
  const workersAi = WorkersAiChunk.safeParse(chunk);
  if (workersAi.success) return workersAi.data.response;

  const openAi = OpenAiChatCompletionChunk.safeParse(chunk);
  if (openAi.success) return openAi.data.choices[0].delta?.content ?? "";

  const anthropic = AnthropicStreamDelta.safeParse(chunk);
  if (anthropic.success) return anthropic.data.delta.text ?? "";

  return "";
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
