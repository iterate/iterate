// The agent's LLM REQUEST component — one of the three parts composed into
// the agent processor (see agent-processor-implementation.ts): everything
// between "an open request exists" and "the settlement batch committed" —
// prompt assembly from committed history, the transport attempt (Workers AI
// or the injected `callLlm` seam), chunk streaming, the in-flight abort slot,
// and the atomic success/failure appends. It also owns COMPACTION, which is
// just an LLM request with the summarize instruction as its trailing message:
// the token-usage handler here decides when, and `attempt()` carries both
// lanes through the same transport seam. The turn loop (agent-turn-loop.ts)
// decides WHEN a normal request runs and calls `run()`/`abortInFlight()`.

import type { EmittedInput, ProcessEventArgs, StreamEvent } from "iterate/processors";
import * as modelInterception from "../../lib/model-interception.ts";
import { appendUnlessLostIdempotencyRace, stringifyError, type AgentHost } from "./agent-host.ts";
import {
  AgentProcessorContract,
  type AgentFileAttachment,
  type AgentProcessorState,
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
  type WorkersAiMessage,
} from "./workers-ai-transport.ts";

export class AgentLlmRequest {
  readonly #host: AgentHost;

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

  constructor(host: AgentHost) {
    this.#host = host;
  }

  /**
   * COMPACTION TRIGGER: the usage report says how full this turn's context
   * ran. Past the configured fraction of the model's window, STOP THE WORLD
   * and summarize the history prefix into one context item — blocked
   * (per-event: the report is delivered once, and the summary must land
   * before later context piles onto an already-too-big prompt). Blocking
   * work is FIFO per event and settles before the next event reduces, so
   * compactions run one at a time. The stream probe lets a newer committed
   * report supersede this one.
   */
  processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    const { event, state, blockProcessorWhile } = args;
    if (event?.type !== "events.iterate.com/agent/token-usage-reported") return;
    const usage = event.payload;
    const contextTokens = usage.inputTokens + usage.outputTokens;
    const thresholdTokens = Math.floor(
      usage.maxContextTokens * state.config.compactionTriggerFraction,
    );
    if (contextTokens < thresholdTokens) return;
    const triggerFraction = state.config.compactionTriggerFraction;
    // Something summarizable exists: a conversation message that is not a
    // durable system fact (send stamps and section occurrences alone are
    // not a conversation).
    const hasHistory = state.contextItems.some(
      (item) => item.kind === "message" && item.payload.role !== "system",
    );
    blockProcessorWhile(async () => {
      // A later over-threshold report already in the stream supersedes this
      // one: summarizing an older prefix now would be thrown away by the
      // newer request's compaction, so defer to it.
      if (
        await this.#laterOverThresholdReportPending({
          llmRequestOffset: usage.llmRequestOffset,
          triggerFraction,
        })
      ) {
        return;
      }
      await this.#compactHistory({
        contextTokens,
        deadlineMs: state.config.llmRequestExpiryMs,
        hasHistory,
        llmRequestOffset: usage.llmRequestOffset,
        model: usage.model,
        thresholdTokens,
        triggerOffset: event.offset,
      });
    });
  }

  /** True when THIS incarnation is already executing the open request — the
   * adopt branch's "nobody here is running it" check. */
  isExecuting(requestOffset: number): boolean {
    return this.#inFlightLlmCall?.requestOffset === requestOffset;
  }

  /**
   * The expiry path's teardown: a request past its horizon must settle
   * expired even when THIS incarnation believes it is still executing it.
   * The transport attempt self-caps at the horizon, but the run closure has
   * awaits outside that deadline (history reads, file-URL resolution, the
   * settlement appends) — a hang in any of them would otherwise occupy the
   * in-flight slot forever and block the at-head expiry settle (the
   * 2026-08-13 prd wedge). Abort and free the slot; the zombie closure's
   * late settlement loses the shared `settle/<offset>` idempotency race and
   * its own `signal.aborted` guards keep it from journaling anything new.
   */
  abandonExpired(requestOffset: number): void {
    if (this.#inFlightLlmCall?.requestOffset !== requestOffset) return;
    this.#inFlightLlmCall.controller.abort();
    this.#inFlightLlmCall = null;
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

    // COALESCED chunk journaling. Each append awaits a Durable Object commit
    // (~60ms) and the transport drain awaits `onChunk` before reading the
    // next provider frame — journaling every chunk individually therefore
    // capped delivery at one token per commit round-trip (~17 tok/s in prd,
    // measured 2026-08-27, regardless of model). Buffering a window and
    // journaling it as ONE llm-response-chunks event amortizes the commit
    // across the window; the awaited flush keeps provider order trivially.
    // A flush that fails loses only its window's chunks — they are ephemeral
    // UI signals, and the durable truth (settle/context) is untouched.
    let flushSequence = 0;
    let chunkBuffer: unknown[] = [];
    let chunkBufferBytes = 0;
    let lastFlushAtMs = startedAtMs;
    const flushChunkBuffer = async () => {
      if (chunkBuffer.length === 0) return;
      const chunks = chunkBuffer;
      chunkBuffer = [];
      chunkBufferBytes = 0;
      lastFlushAtMs = this.#host.now();
      const sequence = flushSequence;
      flushSequence += 1;
      await args.append({
        type: "events.iterate.com/agent/llm-response-chunks",
        payload: { chunks, llmRequestOffset: requestOffset, sequence },
      });
    };

    args.runInBackground(async () => {
      try {
        const events = await this.readConsumedEvents();
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
            // The partial accrues BEFORE buffering, so an interrupt keeps the
            // full streamed text even when the window never flushed.
            inFlight.partialText += extractChunkText(chunk);
            const compatible = jsonCompatible(chunk);
            chunkBuffer.push(compatible);
            chunkBufferBytes += JSON.stringify(compatible).length;
            // The window is anchored at the request start, so the first chunk
            // (arriving after time-to-first-token) flushes immediately.
            if (
              this.#host.now() - lastFlushAtMs < CHUNK_FLUSH_WINDOW_MS &&
              chunkBufferBytes < CHUNK_FLUSH_MAX_BYTES
            ) {
              return;
            }
            await flushChunkBuffer();
          },
        });
        // A non-streaming transport reports no chunks, so its text exists
        // only in this closure until the success batch commits. Record it as
        // the in-flight partial BEFORE awaiting that append: an interrupt
        // racing the append settles cancelled with whatever partial is
        // recorded, and must not drop a response already delivered whole.
        if (!inFlight.controller.signal.aborted) {
          inFlight.partialText = completion.text;
          await flushChunkBuffer();
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
        // Best-effort tail flush so the failure settle isn't missing the last
        // window of streamed text; a second failure here must not mask the
        // attempt's own error.
        await flushChunkBuffer().catch(() => {});
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
    if (modelInterception.isInterceptedModel(input.model)) {
      const consult = this.#host.deps.consultAiInterceptor;
      if (consult === undefined) throw modelInterception.noAiInterceptorError(input.model);
      const result = await raceAbort(
        input.signal,
        consult({
          source: "agent-turn",
          model: input.model,
          body: { messages: input.messages },
        }),
      );
      const normalized = modelInterception.normalizeInterceptedTurnResult({
        result,
        model: input.model,
        inputCharacters: input.messages.reduce((sum, message) => sum + message.content.length, 0),
      });
      // Word-split delivery keeps journaled chunk events flowing. An
      // abort mid-delivery fails the attempt like the real transport's
      // raceAbort-over-the-drain does — a succeeded completion must never
      // race the interrupt's cancelled settle on the shared idempotency key.
      for (const chunk of normalized.text.split(/\b/)) {
        if (chunk.length === 0) continue;
        if (input.signal.aborted) break;
        await input.onChunk(chunk);
      }
      if (input.signal.aborted) throw new Error("Interception attempt aborted mid-response.");
      return { text: normalized.text, usage: normalized.usage, rawResponse: result };
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

  /**
   * The whole stream's consumed subset, paged from offset 0 — the one read
   * behind prompt building and the compaction guards. Filtering to `consumes`
   * keeps bulk emitted-only types (response chunks) out of the transfer;
   * paging (rather than one capped read) means long histories are never
   * silently truncated.
   */
  async readConsumedEvents(): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    using pager = this.#host.readEvents({
      afterOffset: 0,
      eventTypes: AgentProcessorContract.consumes,
      limit: CONSUMED_EVENTS_PAGE_SIZE,
    });
    for (;;) {
      const page = await pager.next();
      events.push(...page);
      if (page.length < CONSUMED_EVENTS_PAGE_SIZE) return events;
    }
  }

  /**
   * One stop-the-world compaction: replay the exact request whose usage
   * crossed the threshold, ask the agent's model to summarize that prefix,
   * then replace history only through that request's offset. The assistant
   * answer and every message that arrived while it ran are later stream
   * facts and survive behind the summary. Best-effort: every early return
   * leaves the stream untouched, and a later usage report may retry. A later
   * compacting item is the durable redelivery guard.
   */
  async #compactHistory(input: {
    contextTokens: number;
    deadlineMs: number;
    hasHistory: boolean;
    llmRequestOffset: number;
    model: string;
    thresholdTokens: number;
    triggerOffset: number;
  }): Promise<void> {
    const {
      contextTokens,
      deadlineMs,
      hasHistory,
      llmRequestOffset,
      model,
      thresholdTokens,
      triggerOffset,
    } = input;
    if (!hasHistory) return;
    try {
      if (await this.#hasCompactionCovering(llmRequestOffset)) return;
      const events = await this.readConsumedEvents();

      // Same transport seam as normal turns: BYOK carries the per-agent
      // prompt_cache_key, so this request lands on the shard that already
      // holds the conversation's prefix (and the cache discount lands on our
      // bill — the unified lane meters cached tokens at the uncached price).
      // The usage report names the model that saw the exact measured request;
      // a later configuration event may already have selected another model,
      // but switching here would forfeit that cache.
      const summary = await this.attempt({
        model,
        messages: await prepareAgentLlmMessages(
          buildAgentCompactionRequestBody({ events, llmRequestOffset }).messages,
          this.#host.deps.resolveModelFileUrl,
        ),
        signal: new AbortController().signal,
        deadlineMs,
        onChunk: async () => {},
      });

      await this.#host.append({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: this.#host.idempotencyKey(`compact-context@${triggerOffset}`),
        payload: {
          role: "developer",
          content:
            `[Earlier conversation history was compacted through @${llmRequestOffset} ` +
            `(~${contextTokens} tokens > ${thresholdTokens}). Summary:]\n\n${summary.text}`,
          compaction: {
            replacesHistoryThrough: llmRequestOffset,
            ...(summary.usage === undefined ? {} : { usage: summary.usage }),
          },
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      });
    } catch (error) {
      // A throw here would fail the whole batch into redelivery and stall the
      // agent behind delivery backoff — for a best-effort lane, releasing the
      // world and letting the next over-threshold report retry is strictly
      // better than blocking everything on a flaky summary.
      console.error("[agent] context compaction failed", {
        error: stringifyError(error),
        llmRequestOffset,
        triggerOffset,
      });
    }
  }

  /** Targeted durable guard for compaction redelivery. Long streams are
   * exactly where this runs, so never reread their entire consumed history
   * merely to discover a later summary. */
  async #hasCompactionCovering(offset: number): Promise<boolean> {
    const payloadSchema =
      AgentProcessorContract.events["events.iterate.com/agents/context-added"].payloadSchema;
    using pager = this.#host.readEvents({
      afterOffset: offset,
      eventTypes: ["events.iterate.com/agents/context-added"],
      limit: CONSUMED_EVENTS_PAGE_SIZE,
    });
    for (;;) {
      const page = await pager.next();
      if (
        page.some((candidate) => {
          const parsed = payloadSchema.safeParse(candidate.payload);
          return (
            parsed.success &&
            parsed.data.role === "developer" &&
            parsed.data.compaction !== undefined &&
            parsed.data.compaction.replacesHistoryThrough >= offset &&
            parsed.data.compaction.replacesHistoryThrough < candidate.offset
          );
        })
      ) {
        return true;
      }
      if (page.length < CONSUMED_EVENTS_PAGE_SIZE) return false;
    }
  }

  /**
   * True when the stream already holds a usage report for a LATER request
   * (higher llmRequestOffset) that is itself over its own threshold. Such a
   * report will compact a superset prefix with a newer model, so summarizing
   * this older request first would just be discarded.
   */
  async #laterOverThresholdReportPending(input: {
    llmRequestOffset: number;
    triggerFraction: number;
  }): Promise<boolean> {
    using pager = this.#host.readEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/agent/token-usage-reported"],
      limit: CONSUMED_EVENTS_PAGE_SIZE,
    });
    for (;;) {
      const page = await pager.next();
      if (
        page.some((candidate) => {
          const payload = candidate.payload as {
            llmRequestOffset?: number;
            maxContextTokens?: number;
            inputTokens?: number;
            outputTokens?: number;
          };
          if (
            typeof payload.llmRequestOffset !== "number" ||
            payload.llmRequestOffset <= input.llmRequestOffset ||
            typeof payload.maxContextTokens !== "number" ||
            typeof payload.inputTokens !== "number" ||
            typeof payload.outputTokens !== "number"
          ) {
            return false;
          }
          const thresholdTokens = Math.floor(payload.maxContextTokens * input.triggerFraction);
          return payload.inputTokens + payload.outputTokens >= thresholdTokens;
        })
      ) {
        return true;
      }
      if (page.length < CONSUMED_EVENTS_PAGE_SIZE) return false;
    }
  }
}

/** Page size for full-stream reads (prompt building, compaction guards). */
const CONSUMED_EVENTS_PAGE_SIZE = 500;

/**
 * Chunk-coalescing window: how much streamed provider output rides one
 * llm-response-chunks append. 150ms ≈ 7 UI updates/sec, and amortizes the
 * ~60ms Durable Object commit far below provider token cadence (the ceiling
 * becomes ~window/(window+commit) of provider rate instead of ~17 tok/s).
 */
const CHUNK_FLUSH_WINDOW_MS = 150;

/** Safety cap: a pathological burst flushes early rather than growing one
 * oversized append. */
const CHUNK_FLUSH_MAX_BYTES = 64_000;

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
