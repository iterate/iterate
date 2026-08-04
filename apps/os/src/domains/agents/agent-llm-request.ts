// The agent's LLM REQUEST component, split out of
// agent-processor-implementation.ts: everything between "an open request
// exists" and "the settlement batch committed" — prompt assembly from
// committed history, the transport attempt (Workers AI or the injected
// `callLlm` seam), chunk streaming, the in-flight abort slot, and the atomic
// success/failure appends. Orchestration (when to request a turn, interrupts,
// compaction policy) stays in the processor; compaction reuses `attempt()` so
// both lanes travel the same transport seam.

import { isIdempotencyConflict } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, StreamEvent } from "iterate/processors";
import type {
  AgentFileAttachment,
  AgentProcessorContract,
  AgentProcessorState,
} from "./agent-processor-contract.ts";
import {
  AGENT_COMPACTION_PROMPT,
  buildAgentLlmRequestBody,
  flattenMessageToText,
  type AgentChatMessage,
} from "./agent-prompt-fold.ts";
import {
  extractChunkText,
  jsonCompatible,
  normalizeLlmUsage,
  runWorkersAiAttempt,
  type CloudflareAiGatewayTransport,
  type WorkersAiBinding,
  type WorkersAiMessage,
} from "./workers-ai-transport.ts";

/** The test/custom-host LLM seam: when provided it REPLACES the Workers AI
 * path entirely, so suites drive turns with a scripted transport and the
 * component never knows. `onChunk` receives text deltas. Usage comes back
 * already normalized. */
export type AgentLlmTransport = (args: {
  model: string;
  messages: WorkersAiMessage[];
  signal: AbortSignal;
  /** The transport awaits each result before delivering the next chunk. */
  onChunk?: (text: string) => Promise<void>;
}) => Promise<{
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  };
  rawResponse?: unknown;
}>;

/**
 * The transport-facing subset of the processor's deps (see
 * AgentProcessorDeps in agent-processor-implementation.ts for the full
 * documented set — the processor's deps type extends this one).
 */
export type AgentLlmDeps = {
  ai?: WorkersAiBinding;
  cloudflareAiGatewayTransport?: () => CloudflareAiGatewayTransport;
  resolveModelFileUrl?: (file: AgentFileAttachment) => Promise<string>;
  callLlm?: AgentLlmTransport;
};

/** What the component borrows from its owning processor: deps, the
 * processor-scoped idempotency-key mint, the one full-stream read behind
 * prompt building, and the injectable clock. */
type AgentLlmRequestHost = {
  deps: AgentLlmDeps;
  idempotencyKey: (suffix: string) => string;
  readConsumedEvents: () => Promise<StreamEvent[]>;
  now: () => number;
};

export class AgentLlmRequest {
  readonly #host: AgentLlmRequestHost;

  /**
   * RUNTIME state: in-memory, dies with the isolate, never persisted. The one
   * LLM call THIS incarnation is executing (mirroring the single
   * `state.openRequest` slot), with its abort handle and the text streamed so
   * far (preserved into the cancelled settlement when an interrupt aborts
   * mid-response). The stream never knows about incarnations — a fresh one
   * reduces the stream, finds the open request absent here, and runs it again
   * (adopt-based recovery).
   */
  #inFlightLlmCall: {
    requestOffset: number;
    controller: AbortController;
    partialText: string;
  } | null = null;

  constructor(host: AgentLlmRequestHost) {
    this.#host = host;
  }

  /** True when THIS incarnation is already executing the open request — the
   * adopt branch's "nobody here is running it" check. */
  isExecuting(requestOffset: number): boolean {
    return this.#inFlightLlmCall?.requestOffset === requestOffset;
  }

  /**
   * The interrupt path's teardown: abort whatever this incarnation is
   * running, and hand back the streamed partial text when it belongs to the
   * given request (an in-flight call for another offset is still aborted, but
   * its partial is not this request's story).
   */
  abortInFlight(requestOffset: number): string | undefined {
    this.#inFlightLlmCall?.controller.abort();
    return this.#inFlightLlmCall?.requestOffset === requestOffset &&
      this.#inFlightLlmCall.partialText !== ""
      ? this.#inFlightLlmCall.partialText
      : undefined;
  }

  /**
   * Execute the LLM call for a recorded intent — background work: it can run
   * for minutes, and the stream (not this closure) is what survives an
   * eviction. The prompt is rebuilt from committed history pinned to the
   * request's offset, so an adopting incarnation reproduces the covered
   * context exactly. Success lands as ONE atomic append: the assistant
   * context item, the settlement, and the normalized token-usage report, all
   * idempotency-keyed on the request's offset, so a zombie racing a fresh
   * incarnation collapses to one stream story.
   */
  run(
    args: ProcessEventArgs<AgentProcessorContract>,
    open: NonNullable<AgentProcessorState["openRequest"]>,
  ) {
    const requestOffset = open.requestedAtOffset;
    const inFlight = { requestOffset, controller: new AbortController(), partialText: "" };
    this.#inFlightLlmCall = inFlight;
    const startedAtMs = this.#host.now();
    let chunkSequence = 0;
    args.runInBackground(async () => {
      try {
        const events = await this.#host.readConsumedEvents();
        const body = buildAgentLlmRequestBody({ events, llmRequestOffset: requestOffset });
        const completion = await this.attempt({
          model: open.model,
          messages: await prepareAgentLlmMessages(
            body.messages,
            this.#host.deps.resolveModelFileUrl,
          ),
          signal: inFlight.controller.signal,
          // The attempt can never outlive its intent: dial + stream drain
          // self-cap at whatever validity the request has left.
          deadlineMs: Math.max(1, open.expiresAt - this.#host.now()),
          onChunk: async (chunk) => {
            if (inFlight.controller.signal.aborted) return;
            inFlight.partialText += extractChunkText(chunk);
            const sequence = chunkSequence;
            chunkSequence += 1;
            // Each append obtains a fresh Durable Object stub, so await the
            // commit to preserve provider order across those RPCs.
            await args.append({
              type: "events.iterate.com/agent/llm-response-chunk",
              payload: {
                chunk: jsonCompatible(chunk),
                llmRequestOffset: requestOffset,
                sequence,
              },
            });
          },
        });
        // A non-streaming transport reports no chunks, so its text exists
        // only in this closure until the success batch commits. Record it as
        // the in-flight partial BEFORE awaiting that append: an interrupt
        // racing the append settles cancelled with whatever partial is
        // recorded, and must not drop a response already delivered whole.
        if (!inFlight.controller.signal.aborted) {
          inFlight.partialText = completion.text;
        }
        const usage = completion.usage;
        await appendUnlessLostIdempotencyRace(args.append, [
          {
            type: "events.iterate.com/agents/context-added",
            payload: {
              role: "assistant",
              content: completion.text,
              llmRequestOffset: requestOffset,
            },
            idempotencyKey: this.#host.idempotencyKey(`assistant-context@${requestOffset}`),
          },
          {
            type: "events.iterate.com/agent/llm-request-settled",
            payload: {
              requestOffset,
              durationMs: Math.max(0, this.#host.now() - startedAtMs),
              result: {
                status: "succeeded",
                text: completion.text,
                ...(usage === undefined ? {} : { usage }),
                ...(completion.rawResponse === undefined
                  ? {}
                  : { rawResponse: completion.rawResponse }),
              },
            },
            idempotencyKey: this.#host.idempotencyKey(`settle/${requestOffset}`),
          },
          // The normalized token report rides the same atomic append: same
          // information, one commit. Skipped (not failed) when the vendor
          // reported no parseable usage.
          ...(usage === undefined
            ? []
            : ([
                {
                  type: "events.iterate.com/agent/token-usage-reported",
                  payload: {
                    llmRequestOffset: requestOffset,
                    model: open.model,
                    maxContextTokens: contextWindowTokens(open.model),
                    ...usage,
                  },
                  idempotencyKey: this.#host.idempotencyKey(`token-usage@${requestOffset}`),
                },
              ] satisfies EmittedInput<AgentProcessorContract>[])),
        ]);
      } catch (error) {
        // An aborted call is the interrupt path's story — it already settled
        // the request as cancelled.
        if (inFlight.controller.signal.aborted) return;
        const errorMessage = stringifyError(error);
        // Attempt arithmetic from the dispatch-time reduced state: this failure is
        // attempt (consecutiveLlmFailures + 1). The settled event's reduce
        // schedules the retry; the error-occurred event gets transcribed into
        // context so the next turn sees what happened.
        const attempt = args.state.consecutiveLlmFailures + 1;
        const { maxAttempts } = args.state.config.llmRequestRetryPolicy;
        await appendUnlessLostIdempotencyRace(args.append, [
          {
            type: "events.iterate.com/agent/llm-request-settled",
            payload: {
              requestOffset,
              durationMs: Math.max(0, this.#host.now() - startedAtMs),
              result: { status: "failed", errorMessage },
            },
            idempotencyKey: this.#host.idempotencyKey(`settle/${requestOffset}`),
          },
          {
            type: "events.iterate.com/stream/error-occurred",
            payload: {
              message:
                attempt < maxAttempts
                  ? `LLM request @${requestOffset} failed (attempt ${attempt} of ${maxAttempts}): ${errorMessage}. Retrying.`
                  : `LLM request @${requestOffset} failed (attempt ${attempt} of ${maxAttempts}): ${errorMessage}. Giving up; a new user message starts fresh.`,
            },
            idempotencyKey: this.#host.idempotencyKey(`failure-error/${requestOffset}`),
          },
        ]);
      } finally {
        if (this.#inFlightLlmCall?.requestOffset === requestOffset) {
          this.#inFlightLlmCall = null;
        }
      }
    });
  }

  /**
   * One LLM attempt through the vendor seam. `deps.callLlm` (tests, custom
   * hosts) takes the whole attempt when provided; otherwise the attempt dials
   * Workers AI (unified billing or the BYOK gateway lane) via
   * workers-ai-transport. Returns normalized usage either way, and raw chunk
   * objects flow through `onChunk` (the scripted test transport hands text
   * chunks — `extractChunkText` treats a bare string as its own text).
   *
   * `runWorkersAiAttempt` has no abort signal (an interrupt's outcome is
   * decided by the settle key, not by tearing down the socket), so the abort
   * is raced OUTSIDE it: the attempt promise loses to the abort, the caller's
   * catch sees `signal.aborted`, and the orphaned drain finishes into the
   * void with `onChunk` gated on the same signal.
   */
  async attempt(input: {
    model: string;
    messages: WorkersAiMessage[];
    signal: AbortSignal;
    deadlineMs: number;
    onChunk: (chunk: unknown) => Promise<void>;
  }): Promise<{
    text: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
    };
    rawResponse?: unknown;
  }> {
    if (this.#host.deps.callLlm !== undefined) {
      return await this.#host.deps.callLlm({
        model: input.model,
        messages: input.messages,
        signal: input.signal,
        onChunk: (text) => input.onChunk(text),
      });
    }
    const ai = this.#host.deps.ai;
    if (ai === undefined) {
      throw new Error("Agent processor has no AI binding configured.");
    }
    const completion = await raceAbort(
      input.signal,
      runWorkersAiAttempt({
        ai,
        transport: this.#host.deps.cloudflareAiGatewayTransport?.(),
        deadlineMs: input.deadlineMs,
        // This chat-completions transport is text-only: file attachments use
        // just-in-time signed hint URLs, not OpenAI Files or provider file IDs.
        messages: input.messages,
        model: input.model,
        onChunk: async (chunk) => input.onChunk(chunk),
      }),
    );
    const usage = normalizeLlmUsage(completion.usage);
    return {
      text: completion.text,
      ...(usage === undefined ? {} : { usage }),
      rawResponse: completion.rawResponse,
    };
  }
}

/**
 * Append a batch whose idempotency keys may race concurrent writers: every
 * writer of `settle/<offset>` (success, failure, interrupt, expiry) races
 * every other, and two debounce schedulings of one trigger race on
 * `request/<offset>` when config changed between them. The stream rejects
 * a same-key append with a different body; the FIRST writer's story stands
 * and losing the race is success — the obligation is settled/recorded, and
 * the reduce sorts out whose fact counts.
 */
export async function appendUnlessLostIdempotencyRace(
  append: ProcessEventArgs<AgentProcessorContract>["append"],
  events: EmittedInput<AgentProcessorContract>[],
): Promise<void> {
  try {
    await append(...events);
  } catch (error) {
    if (!isIdempotencyConflict(error)) throw error;
  }
}

/** Race an un-abortable attempt promise against its abort signal: the caller
 * regains control immediately on interrupt while the orphaned work finishes
 * into the void (its settle append loses the shared idempotency key). */
function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Resolve attachment URLs immediately before provider dispatch. The URLs in
 * recorded events remain deterministic UI/share links; model requests get a
 * separate short-lived capability bound to the current object version. */
export async function prepareAgentLlmMessages(
  messages: AgentChatMessage[],
  resolveModelFileUrl?: (file: AgentFileAttachment) => Promise<string>,
): Promise<WorkersAiMessage[]> {
  return await Promise.all(
    messages.map(async (message) => {
      const files = message.files ?? [];
      if (files.length === 0) return { role: message.role, content: message.content };
      const resolvedFiles =
        resolveModelFileUrl === undefined
          ? files
          : await Promise.all(
              files.map(async (file) => ({ ...file, url: await resolveModelFileUrl(file) })),
            );
      return {
        role: message.role,
        content: flattenMessageToText({ ...message, files: resolvedFiles }),
        containsFiles: true,
      };
    }),
  );
}

/**
 * The compaction request: the conversation EXACTLY as `buildAgentLlmRequestBody`
 * sends it — same system prompt, same history messages — with the summarize
 * instruction appended as the trailing message. Byte-identity with the normal
 * turn's prefix is the point (guarded by a test): the provider's prompt cache
 * matches on exact prefixes, so any re-rendering of the transcript would turn
 * the most expensive request in an agent's life into a full cache miss.
 */
export function buildAgentCompactionRequestBody(input: {
  events: readonly StreamEvent[];
  llmRequestOffset: number;
}): {
  messages: AgentChatMessage[];
} {
  return {
    messages: [
      ...buildAgentLlmRequestBody(input).messages,
      { role: "developer" as const, content: AGENT_COMPACTION_PROMPT },
    ],
  };
}

// -----------------------------------------------------------------------------
// Context windows: model → the window the token-usage-reported payload claims.
// -----------------------------------------------------------------------------

/**
 * Context windows per model family, longest-prefix matched so dated variants
 * inherit their family's window. The OpenAI figures are our OPERATING window,
 * not the documented one: GPT-5.6 Sol and GPT-5.5 have 1.05M-token windows,
 * but 272k is where OpenAI's pricing doubles, so compaction should treat that
 * as full. Model facts, not tuning — the tunable half of the trigger is
 * `config.compactionTriggerFraction`.
 */
const MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "openai/gpt-5.6": 272_000,
  "openai/gpt-5.5": 272_000,
  "openai/gpt-5": 272_000,
};

/** Conservative floor for models not in the map. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export function contextWindowTokens(model: string): number {
  let best: { prefixLength: number; tokens: number } | undefined;
  for (const [prefix, tokens] of Object.entries(MODEL_CONTEXT_WINDOW_TOKENS)) {
    if (!model.startsWith(prefix)) continue;
    if (best === undefined || prefix.length > best.prefixLength) {
      best = { prefixLength: prefix.length, tokens };
    }
  }
  return best?.tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
