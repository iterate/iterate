// =============================================================================
// The agent processor. One class, three lanes:
//
//   reduce       — pure fold: journal → AgentState. One switch, in
//                  `reduceAgentEvent` below, shared with off-runtime refolds.
//   processEvent — per-event side effects. One switch, nothing else.
//   reconcile    — at-head only (base-gated): drive or settle open LLM
//                  obligations, then derive the next scheduling decision.
//
// Everything below the class is a pure helper one of the lanes calls: the
// fold switch, chat-request building, and codemode script-result rendering.
// The Workers AI wire format (SSE, response shapes, attempt deadline) lives
// in workers-ai-transport.ts.
// =============================================================================

import { z } from "zod";
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { cachedEventSchema, getConsumedEventDefinition } from "../streams/processor-contracts.ts";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import {
  AGENT_COMPACTION_TRIGGER_FRACTION,
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AGENT_LLM_RETRY_BACKOFF_BASE_MS,
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
  DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  type AgentFileAttachment,
} from "./agent-processor-contract.ts";
import {
  extractChunkText,
  jsonCompatible,
  normalizeLlmUsage,
  runWorkersAiAttempt,
  type CloudflareAiGatewayTransport,
  type WorkersAiBinding,
} from "./workers-ai-transport.ts";

type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
type AgentConsumedEvent = ReturnType<typeof AgentProcessorContract.parseEvent>;

/**
 * Host-provided deps beyond the stream plumbing.
 *
 * - `ai` is the Workers AI binding (`env.AI`) used for every LLM turn.
 *   Optional so a host without one fails requests with a journaled error
 *   instead of crashing at construction.
 * - `writeWorkspaceFile` writes one file into THIS agent's own workspace (the
 *   same checkout `itx.workspace` resolves to) so oversized script results can
 *   spill to a file the model pages through with plain JavaScript. Optional:
 *   without it (bare test hosts), oversized results fall back to inline
 *   truncation.
 * - `now` is the injected clock (expiry stamps, durations, backstop deadline);
 *   defaults to Date.now.
 * - `llmRetryBackoffBaseMs` scales the failure-retry backoff (default
 *   AGENT_LLM_RETRY_BACKOFF_BASE_MS); tests shrink it so retry loops run in
 *   milliseconds.
 * - `cloudflareAiGatewayTransport` resolves how attempts travel through the
 *   gateway (unified billing vs the BYOK lane — see
 *   CloudflareAiGatewayTransport). A function, not a value:
 *   it reads deployment config and the host's secrets, and a bad config must
 *   fail the ATTEMPT (journaled, retried) rather than DO construction.
 *   Defaults to unified billing.
 */
type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  writeWorkspaceFile?: (input: { content: string; path: string }) => Promise<void>;
  now?: () => number;
  llmRetryBackoffBaseMs?: number;
  cloudflareAiGatewayTransport?: () => CloudflareAiGatewayTransport;
};

/** Page size for full-journal reads (prompt building, currency checks). */
const CONSUMED_EVENTS_PAGE_SIZE = 500;

export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;

  // Incarnation-local bookkeeping. Dies with every eviction, and that is fine:
  // it is the "actual" half of reconciliation, never the source of truth.
  /** Armed debounce timers by requestId; `cancel()` disarms without firing. */
  readonly #scheduledRequestTimers = new Map<string, { cancel: () => void }>();
  /** llmRequestOffsets with an execution alive in THIS incarnation. */
  readonly #liveLlmExecutions = new Set<number>();
  /** Streamed assistant text so far by llmRequestOffset — what an interrupt
   * hands back to the model as its "response so far". Incarnation-local best
   * effort: an eviction loses it, and the crash-cancel path never had it. */
  readonly #partialLlmResponseTexts = new Map<number, string>();

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Retry spacing after n consecutive LLM failures: 0 for a fresh turn, then
   * base × 2^(n-1) capped at 6× base (10s, 20s, 60s at the default base) — see
   * AGENT_LLM_RETRY_BACKOFF_BASE_MS for why instant retries are worse than
   * none. A REPEATED rate-limited failure jumps straight to the cap: the
   * vendor's quota refills on a time window (Workers AI 3021 is per-minute),
   * so once one cheap retry has confirmed the window is still hot, the
   * ladder's middle rung would burn the last attempt inside the same minute.
   * The first retry stays at the ladder (the failure may have been the tail
   * of a window), so attempts land at ~t0/t10/t70 — the third in a fresh
   * minute, still inside every 120s wait budget. Pure in the fold's terms,
   * so re-derived schedules agree. */
  #llmRetryBackoffMs(state: AgentState): number {
    if (state.consecutiveLlmFailures <= 0) return 0;
    const base = this.deps.llmRetryBackoffBaseMs ?? AGENT_LLM_RETRY_BACKOFF_BASE_MS;
    if (state.lastLlmFailureRateLimited && state.consecutiveLlmFailures >= 2) return base * 6;
    return Math.min(base * 2 ** (state.consecutiveLlmFailures - 1), base * 6);
  }

  // ---------------------------------------------------------------------------
  // Lane 1: the fold. The switch lives in `reduceAgentEvent` (module level)
  // so off-runtime refolds — prompt building, request-currency checks — run
  // the exact same projection.
  // ---------------------------------------------------------------------------

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<AgentProcessorContract>["reduce"]>[0]) {
    return reduceAgentEvent({ event, state });
  }

  // ---------------------------------------------------------------------------
  // Lane 2: per-event side effects. One switch; every arm is a short append
  // (blockProcessorWhile) or a droppable attempt whose outcome the reconcile
  // lane recovers (runInBackground).
  // ---------------------------------------------------------------------------

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<AgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/agent/config-updated": {
        if (event.payload.systemPrompt === undefined) return;
        const { systemPrompt } = event.payload;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/system-prompt-updated",
            idempotencyKey: this.idempotencyKey("system-prompt-updated", event),
            payload: { systemPrompt },
          }),
        );
        return;
      }
      case "events.iterate.com/agents/message-received": {
        // The reducer folds the message straight into history (no input-added
        // reflection hop); the only per-event side effect is honoring an
        // interrupt policy, exactly like input-added below.
        if (event.payload.llmRequestPolicy.behaviour !== "interrupt-current-request") return;
        const interruptedRequest = previousState.currentRequest;
        if (interruptedRequest === null) return;
        blockProcessorWhile(() =>
          append(...this.#cancelEventsForCurrentRequest(interruptedRequest)),
        );
        return;
      }
      case "events.iterate.com/agents/web-message-sent": {
        // Files the agent attached to its own message ride the reflection too,
        // so the model SEES what it sent (vision) on later turns.
        const files = event.payload.files;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey("render-web-response", event),
            payload: {
              content: `The assistant sent this visible web-chat message: ${event.payload.message}`,
              ...(files === undefined || files.length === 0 ? {} : { files }),
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      }
      case "events.iterate.com/agent/input-added": {
        // Scheduling the next LLM request is derived from reduced state in the
        // reconcile lane (#reconcileLlmScheduling); the only per-event side
        // effect is interrupting a request already underway.
        if (event.payload.llmRequestPolicy.behaviour !== "interrupt-current-request") return;
        const interrupted = previousState.currentRequest;
        if (interrupted === null) return;
        blockProcessorWhile(() => append(...this.#cancelEventsForCurrentRequest(interrupted)));
        return;
      }
      case "events.iterate.com/agent/llm-request-scheduled":
        // The debounce timer is a droppable ATTEMPT: the scheduled event is
        // the durable evidence, and #reconcileLlmScheduling re-derives a lost
        // timer from the fold. Losing this closure costs latency, never the
        // request. A scheduled-phase cancel disarms it (see the cancelled
        // case below) so an interrupted turn can never fire its request.
        runInBackground(async () => {
          const requestId = event.payload.requestId;
          const fired = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), event.payload.debounceMs);
            this.#scheduledRequestTimers.set(requestId, {
              cancel: () => {
                clearTimeout(timer);
                resolve(false);
              },
            });
          });
          try {
            if (!fired) return;
            await append(
              this.#buildLlmRequestRequested({
                model: event.payload.model,
                requestId,
                scheduledOffset: event.offset,
              }),
            );
          } finally {
            this.#scheduledRequestTimers.delete(requestId);
          }
        });
        return;
      // The LLM starts in the reconcile lane (#reconcileLlmObligations), not
      // here — so a mid-refold never dials env.AI for a long-settled request.
      case "events.iterate.com/agent/llm-request-requested":
        return;
      case "events.iterate.com/agent/llm-request-cancelled":
        // A cancel during the debounce window disarms the armed timer, so the
        // interrupted request never fires its llm-request-requested. Safe on
        // refold: replayed cancels find no armed timer and no-op.
        if (event.payload.phase !== "scheduled") return;
        this.#scheduledRequestTimers.get(event.payload.requestId)?.cancel();
        return;
      case "events.iterate.com/agent/output-added":
        blockProcessorWhile(async () => {
          const extraction = extractAsyncJsSnippet(event.payload.content);
          if (extraction.kind === "none") return;
          if (extraction.kind === "malformed") {
            // Same corrective lane as multi-block: the model believes its
            // script ran; silence would read as the platform hanging.
            await append({
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: this.idempotencyKey("malformed-snippet-rejected", event),
              payload: {
                content:
                  "Your code block did NOT run. Only a ```js fence whose content STARTS with `async` executes — a single `async (itx) => { ... }`, JavaScript only, no comments or statements before the function. Resend it as one such block (move any leading comments inside the function body).",
                llmRequestPolicy: { behaviour: "after-current-request" },
              },
            });
            return;
          }
          if (extraction.kind === "multiple") {
            // Corrective feedback, same lane as a thrown script: the model
            // reads why nothing ran and resends. after-current-request so the
            // retry turn fires without a user nudge.
            await append({
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: this.idempotencyKey("multi-snippet-rejected", event),
              payload: {
                content: `Your response contained ${extraction.count} fenced code blocks, so NOTHING was executed. Respond with exactly ONE fenced code block per turn. Do not queue future steps as extra blocks — your script's return value arrives as your next input and you write the next step then. Resend just the FIRST step as a single \`\`\`js block.`,
                llmRequestPolicy: { behaviour: "after-current-request" },
              },
            });
            return;
          }
          await append({
            type: "events.iterate.com/capability-host/script-execution-requested",
            idempotencyKey: this.idempotencyKey("script-execution-requested", event),
            payload: {
              code: extraction.code,
              executionId: `${AGENT_SCRIPT_EXECUTION_ID_PREFIX}${event.offset}`,
              expiresAt: this.#now() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
            },
          });
        });
        return;
      case "events.iterate.com/capability-host/script-execution-completed": {
        // Rendering may spill an oversized result into the agent's workspace
        // first (a durable write that can wait on the checkout's first-use
        // clone), so the whole render-then-append runs inside the blocking
        // section — the input must not land before the file it references.
        blockProcessorWhile(async () => {
          const content = await scriptResultAgentInput(event, this.deps.writeWorkspaceFile);
          if (content === null) return;
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey("render-script-result", event),
            payload: {
              content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          });
        });
        return;
      }
      // A failed request must never brick the stream: the error becomes a
      // model-visible input, exactly like a thrown script. Below the
      // consecutive-failure cap the input triggers a retry so the model can
      // react (fix its request, tell the user what happened); at the cap it
      // sits in context untriggered so a persistent failure (bad model name,
      // vendor outage) cannot retry-loop — the next user message resumes
      // normally.
      case "events.iterate.com/agent/llm-request-completed": {
        const result = event.payload.result;
        if (result.status !== "failure") return;
        if (
          previousState.currentRequest?.phase !== "requested" ||
          previousState.currentRequest.llmRequestOffset !== event.payload.llmRequestOffset
        ) {
          // Stale completion (e.g. the request was already cancelled) — the
          // reducer ignored it, so don't render an error input for it either.
          return;
        }
        const retry =
          state.consecutiveLlmFailures <
          (isRateLimitErrorMessage(result.error.message)
            ? MAX_CONSECUTIVE_RATE_LIMITED_LLM_FAILURES
            : MAX_CONSECUTIVE_LLM_FAILURES);
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey("render-llm-failure", event),
            payload: {
              content:
                `Your LLM request failed:\n\`\`\`\n${result.error.message}\n\`\`\`` +
                (retry
                  ? ""
                  : `\nConsecutive failure ${state.consecutiveLlmFailures} — automatic retries stopped; this stays in your context for the next turn.`),
              llmRequestPolicy: {
                behaviour: retry ? "after-current-request" : "dont-trigger-request",
              },
            },
          }),
        );
        return;
      }
      // Compaction: a turn's usage report says how full the context ran. Past
      // the threshold, STOP THE WORLD and summarize the conversation into a
      // history-reset: blockProcessorWhile holds the checkpoint and every
      // later delivery until the reset lands, so no turn can start against
      // the history being replaced. A slow summary just means the agent
      // pauses — the same trade every stop-the-world compactor makes.
      case "events.iterate.com/agent/token-usage-reported": {
        const usage = event.payload;
        const contextTokens = usage.inputTokens + usage.outputTokens;
        const thresholdTokens = Math.floor(
          usage.maxContextTokens * AGENT_COMPACTION_TRIGGER_FRACTION,
        );
        if (contextTokens < thresholdTokens) return;
        blockProcessorWhile(() =>
          this.#compactHistory({
            contextTokens,
            llmRequestOffset: usage.llmRequestOffset,
            state,
            thresholdTokens,
            triggerOffset: event.offset,
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  /** True while this incarnation has a summary in flight. Blocking work
   * registered by one batch runs concurrently (the base gathers it in a
   * Promise.all), so a batch carrying two over-threshold reports would
   * otherwise summarize twice; one compaction per batch is plenty. */
  #compactionInFlight = false;

  /**
   * One stop-the-world compaction: summarize the model-visible conversation
   * (the fold at the triggering report) with the agent's own model, then
   * replace history with the summary. Messages that landed while the summary
   * ran are carried forward verbatim behind it — queued input, processed
   * after compaction. Best-effort: every early return (and the catch) leaves
   * the journal untouched and releases the world; the next over-threshold
   * report retries. The one durable guard handles redelivery and recovery: a
   * reset anywhere after the measured prompt means this trigger describes a
   * history that is already gone.
   */
  async #compactHistory(input: {
    contextTokens: number;
    llmRequestOffset: number;
    state: AgentState;
    thresholdTokens: number;
    triggerOffset: number;
  }): Promise<void> {
    const { contextTokens, llmRequestOffset, state, thresholdTokens, triggerOffset } = input;
    const ai = this.deps.ai;
    if (ai === undefined || state.history.length === 0) return;
    if (this.#compactionInFlight) return;
    this.#compactionInFlight = true;
    try {
      const resetsSinceMeasurement = await this.stream.getEvents({
        afterOffset: llmRequestOffset,
        eventTypes: ["events.iterate.com/agent/history-reset"],
        limit: 1,
      });
      if (resetsSinceMeasurement.length > 0) return;

      // Same transport as normal turns: BYOK carries the per-agent
      // prompt_cache_key, so this request lands on the shard that already
      // holds the conversation's prefix (and the cache discount lands on our
      // bill — the unified lane meters cached tokens at the uncached price).
      const summary = await runWorkersAiAttempt({
        ai,
        transport: this.deps.cloudflareAiGatewayTransport?.(),
        deadlineMs: DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
        messages: buildAgentCompactionRequestBody(state).messages.map((message) => ({
          role: message.role,
          content: flattenMessageToText(message),
        })),
        model: state.llmConfig.model,
        onChunk: async () => {},
      });

      const stateNow = reduceAgentEvents(await this.#readConsumedEvents());
      const carriedForward = stateNow.history.slice(state.history.length);
      // The summary turn's own usage rides the reason string: compaction has
      // no llm-request-requested offset, so a token-usage-reported event (its
      // reducer keys on one, and its processEvent arm is this very trigger)
      // does not fit — but the cached/input split is the whole evidence that
      // the prefix-reuse above worked, so it must land in the journal.
      const usage = normalizeLlmUsage(summary.usage);
      const usageNote =
        usage === undefined
          ? ""
          : `; summary llm usage: input=${usage.inputTokens} cached=${usage.cachedInputTokens ?? 0} output=${usage.outputTokens}`;
      await this.append({
        type: "events.iterate.com/agent/history-reset",
        idempotencyKey: this.idempotencyKey(`history-reset@${triggerOffset}`),
        payload: {
          systemPrompt: state.systemPrompt,
          history: [
            {
              role: "user" as const,
              content: `[Earlier conversation history was compacted. Summary:]\n\n${summary.text}`,
            },
            ...carriedForward,
          ],
          reason: `compaction@${triggerOffset}: ~${contextTokens} tokens > ${thresholdTokens}${usageNote}`,
        },
      });
    } catch {
      // A throw here would fail the whole batch into redelivery and stall the
      // agent behind delivery backoff — for a best-effort lane, releasing the
      // world and letting the next over-threshold report retry is strictly
      // better than blocking everything on a flaky summary.
    } finally {
      this.#compactionInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Lane 3: reconciliation. The base calls this only for AT-HEAD batches, so
  // neither pass needs its own mid-refold gate: a catch-up fold can never
  // dial env.AI for a long-settled request or journal a false failure.
  // ---------------------------------------------------------------------------

  protected override async reconcile(
    args: Parameters<StreamProcessor<AgentProcessorContract>["reconcile"]>[0],
  ): Promise<void> {
    await this.#reconcileLlmObligations(args);
    await this.#reconcileLlmScheduling(args);
  }

  /**
   * Open LLM obligations (the fold's `llmRequests`) against this incarnation's
   * live executions:
   *
   * - `requested`, current (or nothing is current — bare-journal recovery),
   *   not live, not expired → START the attempt
   * - `requested` but another request is current → settle as superseded
   *   failure WITHOUT dialing: a stray requested event (raw append, an
   *   abandoned turn) must never run a parallel LLM turn nobody asked for
   * - `requested` but expired → settle as expired failure
   * - `started`, not live → CANCEL as durable-object-crashed (in-flight when
   *   the incarnation died — kill/reset/eviction). Never re-drive: the model
   *   may have partially streamed, and a cancel is the honest journal fact.
   *   The cancel's reducer re-queues the trigger, so the turn RESUMES with a
   *   fresh request instead of silently dropping the user's question.
   */
  async #reconcileLlmObligations(
    args: Parameters<StreamProcessor<AgentProcessorContract>["reconcile"]>[0],
  ): Promise<void> {
    const now = this.#now();
    const cancelCrashed: number[] = [];
    const settleAsFailed: { llmRequestOffset: number; message: string }[] = [];
    for (const [key, request] of Object.entries(args.state.llmRequests)) {
      const llmRequestOffset = Number(key);
      if (this.#liveLlmExecutions.has(llmRequestOffset)) continue;
      if (request.status === "requested" && now >= request.expiresAt) {
        settleAsFailed.push({
          llmRequestOffset,
          message:
            "LLM request expired before any attempt started (the host was down past the request's expiry). Failed by the reconciler; the agent's next trigger reschedules.",
        });
        continue;
      }
      if (request.status === "requested") {
        const isCurrent =
          args.state.currentRequest?.phase === "requested" &&
          args.state.currentRequest.llmRequestOffset === llmRequestOffset;
        if (!isCurrent && args.state.currentRequest !== null) {
          settleAsFailed.push({
            llmRequestOffset,
            message:
              "LLM request is not the agent's current request (superseded or raw-appended); settled by the reconciler without starting an attempt.",
          });
          continue;
        }
        this.#liveLlmExecutions.add(llmRequestOffset);
        args.runInBackground(async () => {
          try {
            await this.#executeLlmRequest({ llmRequestOffset, model: request.model });
          } finally {
            this.#liveLlmExecutions.delete(llmRequestOffset);
          }
        });
        continue;
      }
      cancelCrashed.push(llmRequestOffset);
    }
    if (cancelCrashed.length === 0 && settleAsFailed.length === 0) return;
    args.blockProcessorWhile(async () => {
      for (const llmRequestOffset of cancelCrashed) {
        console.error("[agent] cancelling in-flight llm request after durable-object crash", {
          llmRequestOffset,
        });
        await args.append({
          type: "events.iterate.com/agent/llm-request-cancelled",
          idempotencyKey: this.idempotencyKey(
            `llm-request-cancelled@requested:${llmRequestOffset}`,
          ),
          payload: {
            phase: "requested",
            reason: "durable-object-crashed",
            llmRequestOffset,
          },
        });
      }
      for (const { llmRequestOffset, message } of settleAsFailed) {
        console.error("[agent] settling undriven llm request", { llmRequestOffset, message });
        await args.append({
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: this.idempotencyKey(`llm-request-completed@${llmRequestOffset}`),
          payload: {
            durationMs: 0,
            llmRequestOffset,
            result: { status: "failure", error: { message } },
          },
        });
      }
    });
  }

  /**
   * The LLM-request scheduling decision, derived from the batch's final fold —
   * never per event, where appends made earlier in the same batch are
   * invisible. "A trigger is pending and no request is current" means exactly
   * one llm-request-scheduled for the current request generation; the
   * generation-keyed idempotency makes every re-derivation (many inputs in
   * one batch, chunked delivery, crash replay) collapse into the same stream
   * event.
   */
  async #reconcileLlmScheduling(
    args: Parameters<StreamProcessor<AgentProcessorContract>["reconcile"]>[0],
  ): Promise<void> {
    const { state } = args;
    if (state.currentRequest === null) {
      if (state.pendingTriggerOffset === null) return;
      if (
        state.pendingTriggerSource === "agent-loop" &&
        state.autonomousTurnCount >= DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS
      ) {
        await args.append({
          type: "events.iterate.com/agent/loop-stopped",
          idempotencyKey: this.idempotencyKey(
            `autonomous-turn-limit:${state.pendingTriggerOffset}`,
          ),
          payload: {
            maxAutonomousTurns: DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
            reason: `Agent circuit breaker stopped after ${DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS} consecutive autonomous turns.`,
            triggerOffset: state.pendingTriggerOffset,
          },
        });
        return;
      }
      await args.append({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: this.idempotencyKey(
          `llm-request-scheduled@generation:${state.requestGeneration}`,
        ),
        payload: {
          debounceMs: DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS + this.#llmRetryBackoffMs(state),
          model: state.llmConfig.model,
          requestId: `llm-request:gen-${state.requestGeneration}`,
        },
      });
      return;
    }
    if (state.currentRequest.phase === "requested") {
      // Last-resort backstop. Normally dead code: the obligation pass above
      // settles every open request (attempts self-cap at the expiry deadline,
      // crashed attempts cancel, expired intents fail), so this only fires
      // for folds the lifecycle didn't produce — hand-seeded checkpoints,
      // raw-append journals — or a reconciliation bug. The completion key is
      // the SAME one every other settle lane uses, so the backstop, the
      // obligation pass, and any late real settle collapse to one durable
      // outcome instead of double-failing the request.
      const requestedAt = state.currentRequest.requestedAt;
      if (requestedAt === undefined) return;
      if (this.#now() - requestedAt < AGENT_LLM_REQUEST_BACKSTOP_MS) return;
      const llmRequestOffset = state.currentRequest.llmRequestOffset;
      await args.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: this.idempotencyKey(`llm-request-completed@${llmRequestOffset}`),
        payload: {
          durationMs: this.#now() - requestedAt,
          llmRequestOffset,
          result: {
            status: "failure",
            error: {
              message: `No LLM attempt settled this request within ${AGENT_LLM_REQUEST_BACKSTOP_MS / 60_000} minutes; failed by the agent's backstop reconciler.`,
            },
          },
        },
      });
      return;
    }
    if (this.#scheduledRequestTimers.has(state.currentRequest.requestId)) return;
    // No active timer for this scheduled request: the DO restarted and lost the
    // debounce. Fire llm-request-requested immediately. The idempotency key
    // makes this safe if the timer also fires concurrently.
    await args.append(
      this.#buildLlmRequestRequested({
        model: state.llmConfig.model,
        requestId: state.currentRequest.requestId,
        scheduledOffset: state.currentRequest.scheduledOffset,
      }),
    );
  }

  /** The one construction of llm-request-requested — the debounce timer and
   * the restart-recovery lane both fire the request for one
   * llm-request-scheduled event, and the SHARED key (per scheduled offset) is
   * what collapses that race to a single append; building the whole event in
   * one place also keeps the expiry stamp and key from drifting apart. */
  #buildLlmRequestRequested(input: { model: string; requestId: string; scheduledOffset: number }) {
    return {
      type: "events.iterate.com/agent/llm-request-requested" as const,
      idempotencyKey: this.idempotencyKey(`llm-request-requested@${input.scheduledOffset}`),
      payload: {
        model: input.model,
        requestId: input.requestId,
        expiresAt: this.#now() + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
      },
    };
  }

  /**
   * The cancel for a user interrupt — plus, when this incarnation streamed
   * any of the doomed attempt's text, a model-visible input carrying the
   * response so far. Without it the next turn silently loses everything the
   * user just watched stream; the model would repeat or contradict itself
   * with no idea why. dont-trigger-request: the interrupting input is the
   * trigger. Refold-safe: replays find an empty map and the cancel dedupes.
   */
  #cancelEventsForCurrentRequest(request: NonNullable<AgentState["currentRequest"]>) {
    if (request.phase === "scheduled") {
      return [
        {
          type: "events.iterate.com/agent/llm-request-cancelled" as const,
          idempotencyKey: this.idempotencyKey(
            `llm-request-cancelled@scheduled:${request.scheduledOffset}`,
          ),
          payload: {
            phase: "scheduled" as const,
            reason: "interrupted-by-user-input" as const,
            requestId: request.requestId,
          },
        },
      ];
    }

    const cancelEvent = {
      type: "events.iterate.com/agent/llm-request-cancelled" as const,
      idempotencyKey: this.idempotencyKey(
        `llm-request-cancelled@requested:${request.llmRequestOffset}`,
      ),
      payload: {
        phase: "requested" as const,
        reason: "interrupted-by-user-input" as const,
        llmRequestOffset: request.llmRequestOffset,
      },
    };
    const partialResponse = this.#partialLlmResponseTexts.get(request.llmRequestOffset);
    if (partialResponse === undefined || partialResponse.trim() === "") return [cancelEvent];
    return [
      cancelEvent,
      {
        type: "events.iterate.com/agent/input-added" as const,
        idempotencyKey: this.idempotencyKey(
          `render-interrupted-partial@${request.llmRequestOffset}`,
        ),
        payload: {
          content: `Your in-progress response was interrupted by the user input above and cancelled. It never completed, and no code block in it was executed. Your response so far:\n\n${partialResponse}`,
          llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
        },
      },
    ];
  }

  /**
   * One LLM attempt, start to durable outcome. Journals started-evidence,
   * dials Workers AI (deadline-capped in the transport), streams chunk
   * events, and settles with exactly one llm-request-completed — success or
   * failure. Runs as a droppable background attempt; #reconcileLlmObligations
   * recovers the outcome if this incarnation dies mid-flight.
   */
  async #executeLlmRequest(input: { llmRequestOffset: number; model: string }): Promise<void> {
    const { llmRequestOffset, model } = input;
    const startedAt = this.#now();
    // Started-evidence outside the try: if this append fails the model was
    // never dialed, so no completion may be appended — the obligation stays
    // `requested` and a later reconciliation retries the attempt.
    await this.append({
      type: "events.iterate.com/agent/llm-request-started",
      idempotencyKey: this.idempotencyKey(`llm-request-started@${llmRequestOffset}`),
      payload: { llmRequestOffset, model },
    });

    try {
      const ai = this.deps.ai;
      if (ai === undefined) {
        throw new Error("Agent processor has no AI binding configured.");
      }
      const body = buildAgentLlmRequestBody({
        events: await this.#readConsumedEvents(),
        llmRequestOffset,
      });
      const completion = await runWorkersAiAttempt({
        ai,
        transport: this.deps.cloudflareAiGatewayTransport?.(),
        // The attempt's whole vendor phase (dial + stream drain) self-caps at
        // the intent-expiry horizon, so a wedged binding releases the live
        // set here instead of pinning the obligation until the backstop.
        deadlineMs: DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
        // Workers AI chat bodies are text-only here: file attachments flatten
        // to hint lines telling the agent how to fetch/convert the bytes.
        messages: body.messages.map((message) => ({
          role: message.role,
          content: flattenMessageToText(message),
        })),
        model,
        onChunk: async (chunk, index) => {
          // Accumulated text is what an interrupt hands back to the model as
          // its "response so far" (#cancelEventsForCurrentRequest).
          this.#partialLlmResponseTexts.set(
            llmRequestOffset,
            (this.#partialLlmResponseTexts.get(llmRequestOffset) ?? "") + extractChunkText(chunk),
          );
          // Ephemeral: the durable truth is the output-added /
          // llm-request-completed pair below.
          await this.append({
            type: "events.iterate.com/agent/llm-response-chunk",
            ephemeral: true,
            idempotencyKey: this.idempotencyKey(`llm-response-chunk@${llmRequestOffset}:${index}`),
            payload: { chunk: jsonCompatible(chunk), llmRequestOffset, sequence: index },
          });
        },
      });

      // Output and completion are one atomic append: the same information
      // triggers both facts, and a crash between two separate appends would
      // leave an answered turn looking crashed (output in history, obligation
      // still open — the crash-cancel would then re-run an answered turn).
      const completedEvent = {
        type: "events.iterate.com/agent/llm-request-completed" as const,
        idempotencyKey: this.idempotencyKey(`llm-request-completed@${llmRequestOffset}`),
        payload: {
          durationMs: this.#now() - startedAt,
          llmRequestOffset,
          result: {
            status: "success" as const,
            rawResponse: completion.rawResponse,
            ...(completion.usage === undefined ? {} : { usage: completion.usage }),
          },
        },
      };
      // The normalized token report rides the same atomic append as the
      // completion: same information, one commit. Skipped (not failed) when
      // the vendor reported no parseable usage.
      const normalizedUsage = normalizeLlmUsage(completion.usage);
      const usageEvents =
        normalizedUsage === undefined
          ? []
          : [
              {
                type: "events.iterate.com/agent/token-usage-reported" as const,
                idempotencyKey: this.idempotencyKey(`token-usage@${llmRequestOffset}`),
                payload: {
                  llmRequestOffset,
                  model,
                  maxContextTokens: contextWindowTokens(model),
                  ...normalizedUsage,
                },
              },
            ];
      if (await this.#isRequestStillCurrent({ llmRequestOffset })) {
        await this.append(
          {
            type: "events.iterate.com/agent/output-added",
            idempotencyKey: this.idempotencyKey(`output-added@${llmRequestOffset}`),
            payload: { content: completion.text, llmRequestOffset },
          },
          completedEvent,
          ...usageEvents,
        );
      } else {
        await this.append(completedEvent, ...usageEvents);
      }
    } catch (error) {
      await this.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: this.idempotencyKey(`llm-request-completed@${llmRequestOffset}`),
        payload: {
          durationMs: this.#now() - startedAt,
          llmRequestOffset,
          result: {
            status: "failure",
            error: { message: stringifyError(error) },
          },
        },
      });
    } finally {
      // The attempt is settled; a cancel for it can no longer be appended
      // (the completion or the cancel already cleared currentRequest), so the
      // accumulated text has no remaining reader.
      this.#partialLlmResponseTexts.delete(llmRequestOffset);
    }
  }

  /**
   * The whole journal's consumed subset, paged from offset 0 — the one read
   * behind prompt building and the request-currency check. Filtering to
   * `consumes` keeps bulk emitted-only types (response chunks) out of the
   * transfer; paging (rather than one capped read) means long histories are
   * never silently truncated.
   */
  async #readConsumedEvents(): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    using pager = this.stream.readEvents({
      afterOffset: 0,
      eventTypes: this.contract.consumes,
      limit: CONSUMED_EVENTS_PAGE_SIZE,
    });
    for (;;) {
      const page = await pager.next();
      events.push(...page);
      if (page.length < CONSUMED_EVENTS_PAGE_SIZE) return events;
    }
  }

  /** Re-folds committed history right before publishing output: a request the
   * user has since interrupted must not add its answer to the conversation. */
  async #isRequestStillCurrent(input: { llmRequestOffset: number }) {
    const state = reduceAgentEvents(await this.#readConsumedEvents());
    return (
      state.currentRequest?.phase === "requested" &&
      state.currentRequest.llmRequestOffset === input.llmRequestOffset
    );
  }
}

// =============================================================================
// The fold: one pure switch per consumed event.
// =============================================================================

function reduceAgentEvent(input: { event: AgentConsumedEvent; state: AgentState }): AgentState {
  const { event, state } = input;
  switch (event.type) {
    case "events.iterate.com/agent/config-updated":
      return state;
    case "events.iterate.com/agent/system-prompt-updated":
      return { ...state, systemPrompt: event.payload.systemPrompt };
    case "events.iterate.com/agents/message-received": {
      // Inbound messages fold straight into history. The trigger source keys
      // on WHO sent it: humans (web, MCP, Slack, email, GitHub) refill the
      // autonomous turn budget; another AGENT's mail counts against it — the
      // same breaker that stops script self-loops bounds agent↔agent reply
      // ping-pong, because neither side's messages reset the other.
      const from = event.payload.from;
      const files = event.payload.files;
      const triggerSource =
        event.payload.llmRequestPolicy.behaviour === "dont-trigger-request"
          ? null
          : from.kind === "agent"
            ? ("agent-loop" as const)
            : ("user" as const);
      // Child-agent-ness is not a birth-time prompt: everything an agent
      // needs to know about talking to the sender rides on the message
      // itself. The sender agent never sees this chat's sendMessage output,
      // so the label spells out the reply door.
      const content =
        from.kind === "agent"
          ? `Message from agent ${from.path} (that agent cannot see this conversation — to reply to it: await itx.agents.get(${JSON.stringify(from.path)}).message(text)):\n${event.payload.content}`
          : event.payload.content;
      return {
        ...state,
        history: [
          ...state.history,
          {
            role: "user",
            content,
            ...(files === undefined || files.length === 0 ? {} : { files }),
          },
        ],
        pendingTriggerOffset: triggerSource === null ? state.pendingTriggerOffset : event.offset,
        pendingTriggerSource: triggerSource === null ? state.pendingTriggerSource : triggerSource,
        autonomousTurnCount: triggerSource === "user" ? 0 : state.autonomousTurnCount,
      };
    }
    case "events.iterate.com/agent/input-added": {
      const triggerSource = agentInputTriggerSource(event);
      const files = event.payload.files;
      return {
        ...state,
        history: [
          ...state.history,
          {
            role: "user",
            content: event.payload.content,
            ...(files === undefined || files.length === 0 ? {} : { files }),
          },
        ],
        pendingTriggerOffset: triggerSource === null ? state.pendingTriggerOffset : event.offset,
        pendingTriggerSource: triggerSource === null ? state.pendingTriggerSource : triggerSource,
        autonomousTurnCount: triggerSource === "user" ? 0 : state.autonomousTurnCount,
        // A fresh user message is a fresh turn: it must get the full retry
        // budget (and no stale backoff), not one attempt because an earlier
        // turn burned the counter during a provider blip.
        consecutiveLlmFailures: triggerSource === "user" ? 0 : state.consecutiveLlmFailures,
      };
    }
    case "events.iterate.com/agent/output-added":
      return {
        ...state,
        history: [...state.history, { role: "assistant", content: event.payload.content }],
      };
    case "events.iterate.com/agent/llm-provider-selected":
      if (event.payload.ifUnset && state.llmConfigConfigured) return state;
      return {
        ...state,
        llmConfig: { model: event.payload.model },
        llmConfigConfigured: true,
      };
    case "events.iterate.com/agent/llm-request-scheduled":
      return {
        ...state,
        currentRequest: {
          phase: "scheduled",
          requestId: event.payload.requestId,
          scheduledOffset: event.offset,
        },
        pendingTriggerOffset: null,
        pendingTriggerSource: null,
        autonomousTurnCount:
          state.pendingTriggerSource === "agent-loop" ? state.autonomousTurnCount + 1 : 0,
      };
    case "events.iterate.com/agent/llm-request-requested": {
      const key = String(event.offset);
      const expiresAt =
        event.payload.expiresAt ??
        Date.parse(event.createdAt) + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS;
      const withLifecycle: AgentState = {
        ...state,
        llmRequests: {
          ...state.llmRequests,
          [key]: {
            status: "requested" as const,
            model: event.payload.model,
            expiresAt,
          },
        },
      };
      if (
        state.currentRequest?.phase !== "scheduled" ||
        state.currentRequest.requestId !== event.payload.requestId
      ) {
        return withLifecycle;
      }
      return {
        ...withLifecycle,
        currentRequest: {
          phase: "requested",
          llmRequestOffset: event.offset,
          requestedAt: Date.parse(event.createdAt),
        },
        pendingTriggerOffset: null,
      };
    }
    case "events.iterate.com/agent/llm-request-started": {
      const key = String(event.payload.llmRequestOffset);
      const existing = state.llmRequests[key];
      if (existing === undefined) return state;
      return {
        ...state,
        llmRequests: {
          ...state.llmRequests,
          [key]: { ...existing, status: "started" as const },
        },
      };
    }
    case "events.iterate.com/agent/llm-request-completed": {
      const llmRequests = { ...state.llmRequests };
      delete llmRequests[String(event.payload.llmRequestOffset)];
      const next: AgentState = { ...state, llmRequests };
      if (
        state.currentRequest?.phase !== "requested" ||
        state.currentRequest.llmRequestOffset !== event.payload.llmRequestOffset
      ) {
        return next;
      }
      const result = event.payload.result;
      return {
        ...next,
        consecutiveLlmFailures: result.status === "failure" ? state.consecutiveLlmFailures + 1 : 0,
        lastLlmFailureRateLimited:
          result.status === "failure" ? isRateLimitErrorMessage(result.error.message) : false,
        currentRequest: null,
        requestGeneration: state.requestGeneration + 1,
      };
    }
    case "events.iterate.com/agent/token-usage-reported":
      return {
        ...state,
        tokenUsage: {
          totalInputTokens: state.tokenUsage.totalInputTokens + event.payload.inputTokens,
          totalOutputTokens: state.tokenUsage.totalOutputTokens + event.payload.outputTokens,
          totalCachedInputTokens:
            state.tokenUsage.totalCachedInputTokens + (event.payload.cachedInputTokens ?? 0),
          totalReasoningOutputTokens:
            state.tokenUsage.totalReasoningOutputTokens +
            (event.payload.reasoningOutputTokens ?? 0),
        },
      };
    case "events.iterate.com/agent/history-reset":
      // Wholesale replace of the model-visible conversation. The request
      // lifecycle fields (currentRequest, llmRequests, requestGeneration) are
      // deliberately untouched: an attempt in flight across the reset settles
      // normally — clearing it here would strand its completion against a
      // fold that no longer expects it and wedge the turn.
      return {
        ...state,
        systemPrompt: event.payload.systemPrompt,
        history: event.payload.history,
      };
    case "events.iterate.com/agent/llm-request-cancelled":
      if (
        event.payload.phase === "scheduled" &&
        state.currentRequest?.phase === "scheduled" &&
        state.currentRequest.requestId === event.payload.requestId
      ) {
        return { ...state, currentRequest: null, requestGeneration: state.requestGeneration + 1 };
      }
      if (event.payload.phase === "requested") {
        // Always drop the obligation (a crash-cancel may arrive when
        // currentRequest was never set, e.g. a bare seeded requested+started
        // history). Clear currentRequest only when this was the agent-visible
        // current attempt.
        const llmRequests = { ...state.llmRequests };
        delete llmRequests[String(event.payload.llmRequestOffset)];
        const isCurrent =
          state.currentRequest?.phase === "requested" &&
          state.currentRequest.llmRequestOffset === event.payload.llmRequestOffset;
        if (!isCurrent) return { ...state, llmRequests };
        return {
          ...state,
          llmRequests,
          currentRequest: null,
          requestGeneration: state.requestGeneration + 1,
          // A user interrupt needs no re-queue: the interrupting input IS the
          // next trigger. A crash-cancel has no such input — the user asked
          // and never got an answer — so the cancel itself re-queues the turn
          // and the scheduling reconciler fires a fresh request. Source
          // "agent-loop": a crash-looping host burns down the autonomous-turn
          // breaker instead of retrying forever.
          ...(event.payload.reason === "durable-object-crashed"
            ? {
                pendingTriggerOffset: event.offset,
                pendingTriggerSource: "agent-loop" as const,
              }
            : {}),
        };
      }
      return state;
    case "events.iterate.com/agent/loop-stopped":
      return {
        ...state,
        pendingTriggerOffset: null,
        pendingTriggerSource: null,
      };
    default:
      return state;
  }
}

/**
 * Folds a raw journal into agent state outside the processor runtime — the
 * read path behind prompt building and request-currency checks. Non-consumed
 * types and events whose shape fails the contract parse are skipped exactly
 * like the live fold skips them (streams accept raw appends by design; a
 * malformed event is a fact of the log, not an exception). Reducer bugs, by
 * contrast, throw — swallowing them would silently fold wrong state.
 */
export function reduceAgentEvents(events: readonly StreamEvent[]): AgentState {
  let state = AgentProcessorContract.stateSchema.parse({});
  for (const event of events) {
    const definition = getConsumedEventDefinition({
      contract: AgentProcessorContract,
      eventType: event.type,
    });
    if (definition === undefined) continue;
    const parsed = cachedEventSchema({
      type: event.type,
      payloadSchema: definition.payloadSchema,
    }).safeParse(event);
    if (!parsed.success) continue;
    state = reduceAgentEvent({ event: parsed.data as AgentConsumedEvent, state });
  }
  return state;
}

function agentInputTriggerSource(
  event: Extract<AgentConsumedEvent, { type: "events.iterate.com/agent/input-added" }>,
): "user" | "agent-loop" | null {
  if (event.payload.llmRequestPolicy.behaviour === "dont-trigger-request") return null;
  // Inputs the loop generates for itself — script results, LLM-failure
  // retries — must count against the autonomous turn limit, not reset it.
  const agentLoopKeyPrefixes = ["agent/render-script-result@", "agent/render-llm-failure@"];
  return agentLoopKeyPrefixes.some((prefix) => event.idempotencyKey?.startsWith(prefix))
    ? "agent-loop"
    : "user";
}

// =============================================================================
// Building the model-facing chat request.
// =============================================================================

/** One agent-history message as the model receives it: the contract's
 * `AgentInputItem` shape plus the `system` role the request builder adds. */
type AgentChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  files?: AgentFileAttachment[];
};

/** The chat request is a pure refold of committed history up to the
 * llm-request-requested event's offset, so every retry of the same request
 * sees the same conversation. */
export function buildAgentLlmRequestBody(input: {
  events: readonly StreamEvent[];
  llmRequestOffset: number;
}): { messages: AgentChatMessage[] } {
  const state = reduceAgentEvents(
    input.events.filter((event) => event.offset <= input.llmRequestOffset),
  );
  // Without a clock the model's "now" is its training cutoff — every web
  // search for something recent, every scheduler cron, every "how old is
  // this?" judgment silently wrong, with no error signal. The request's own
  // llm-request-requested append time is the stamp: journaled, so refolds
  // and the UI trace replay reproduce the exact request byte for byte. It
  // rides as the LAST message, never inside the system prompt: a per-request
  // value at the head of the request would change the prefix every turn and
  // zero out the provider's prompt cache for the whole conversation behind
  // it (the tail position leaves every cached prefix intact).
  const requestedAt = input.events.find(
    (event) =>
      event.offset === input.llmRequestOffset &&
      event.type === "events.iterate.com/agent/llm-request-requested",
  )?.createdAt;
  return {
    messages: [
      { role: "system" as const, content: state.systemPrompt },
      ...state.history,
      ...(requestedAt === undefined
        ? []
        : [
            {
              role: "system" as const,
              content: `Current date and time (UTC): ${requestedAt}`,
            },
          ]),
    ],
  };
}

/**
 * Flattens one history message to plain text: content plus a hint line per
 * attachment. Models without native file support (or non-image files) see
 * attachments this way.
 */
export function flattenMessageToText(message: AgentChatMessage): string {
  const files = message.files ?? [];
  if (files.length === 0) return message.content;
  return [message.content, ...files.map(renderFileHintLine)].join("\n");
}

/**
 * The model-visible text for a file the current model cannot ingest natively:
 * never fail the turn — tell the agent where the bytes live and how to read
 * or convert them, and let it act (fetch via itx.files, convert via
 * itx.ai.toMarkdown) on its next script.
 */
function renderFileHintLine(file: AgentFileAttachment): string {
  return (
    `[Attached file: ${file.filename} (${file.contentType}, ${file.size} bytes) — ` +
    `bytes: await itx.files.get(${JSON.stringify(file.path)}).bytes(); ` +
    `convert: itx.ai.toMarkdown; public url: ${file.url}]`
  );
}

// =============================================================================
// Compaction: over-threshold usage reports → a summarizing history-reset.
// =============================================================================

/**
 * Instruction for the summary turn. The summary becomes the agent's ENTIRE
 * memory of everything before the reset, so it optimizes for retrieval keys —
 * names, paths, ids, decisions — over narrative flow.
 *
 * It rides as the LAST message of the compaction request, behind the
 * conversation exactly as normal turns send it — never as a fresh system
 * prompt with the transcript re-rendered behind it. Compaction fires at the
 * biggest prompt this agent will ever send (~half the context window), and
 * the tail position means that whole prompt is a prefix the provider already
 * has cached from the previous turn (the provider's cached-input discount)
 * instead of a from-scratch prompt sharing no bytes with it.
 */
const AGENT_COMPACTION_PROMPT = [
  "You are compacting this AI agent conversation because it is close to overflowing the model's context window. Do not respond to the messages above. Instead, write a summary that will REPLACE everything above as the agent's only memory of it.",
  "",
  "Preserve, with their exact spellings:",
  "- who the user is, what they are trying to achieve, and their standing preferences or instructions",
  "- decisions made and the reasons for them",
  "- open tasks, promises, and anything the agent said it would do",
  "- names, file paths, URLs, ids, and other exact strings the agent may need to reference again (including itx.files paths from attachment hint lines — files do not survive compaction except through your summary)",
  "- key results of work already done, so it is not redone",
  "",
  "Write dense prose. No preamble, no headings about the summarization itself — output only the summary.",
].join("\n");

/**
 * The compaction request: the conversation EXACTLY as `buildAgentLlmRequestBody`
 * sends it — same system prompt, same history messages — with the summarize
 * instruction appended as the trailing message. Byte-identity with the normal
 * turn's prefix is the point (guarded by a test): the provider's prompt cache
 * matches on exact prefixes, so any re-rendering of the transcript would turn
 * the most expensive request in an agent's life into a full cache miss.
 */
export function buildAgentCompactionRequestBody(state: {
  systemPrompt: AgentState["systemPrompt"];
  history: AgentState["history"];
}): { messages: AgentChatMessage[] } {
  return {
    messages: [
      { role: "system" as const, content: state.systemPrompt },
      ...state.history,
      { role: "system" as const, content: AGENT_COMPACTION_PROMPT },
    ],
  };
}

// =============================================================================
// Context windows: model → the window the token-usage-reported payload claims.
// =============================================================================

/**
 * Context windows per model family, longest-prefix matched so dated variants
 * inherit their family's window. The OpenAI figures are our OPERATING window,
 * not the documented one: GPT-5.6 Sol and GPT-5.5 have 1.05M-token windows,
 * but 272k is where OpenAI's pricing doubles, so compaction should treat that
 * as full.
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

// =============================================================================
// Codemode: scripts out of outputs, script results back into inputs.
// =============================================================================

const AGENT_SCRIPT_EXECUTION_ID_PREFIX = "agent-output:";

/**
 * Failed-request error inputs stop auto-retrying once this many failures land
 * in a row (counter resets on any success). Two automatic retries, then wait
 * for the user.
 */
const MAX_CONSECUTIVE_LLM_FAILURES = 3;

/**
 * Rate-limited failures get a longer runway: they are provider weather, not
 * anything a fresh prompt fixes, and with repeat rate-limits jumping to the
 * backoff cap (see #llmRetryBackoffMs) seven attempts span ~5 minutes —
 * enough to clear a saturated per-minute window. Observed live 2026-07-10
 * on the preview account: Workers AI `3021: rate limiting` bursts while
 * several preview slots ran agent e2e concurrently killed turns at 3
 * strikes inside ~30s, while sequential traffic moments later sailed
 * through.
 */
const MAX_CONSECUTIVE_RATE_LIMITED_LLM_FAILURES = 7;

/**
 * Whether an LLM failure message is the vendor telling us to slow down.
 * Matched on the message because the transport surfaces vendor errors as
 * text; Workers AI's shape is "3021: rate limiting: inference request per
 * min rate reached". Drives the backoff floor in #llmRetryBackoffMs and the
 * longer retry runway above. Derived from fold data only (the failure
 * event's message), so refolds agree.
 */
function isRateLimitErrorMessage(message: string): boolean {
  return /\b3021\b|rate.?limit/i.test(message);
}

const FENCED_SNIPPET_RE =
  /^[ \t]*```(?:js|javascript|ts|typescript)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/im;

type SnippetExtraction =
  | { kind: "script"; code: string }
  // The model queued several scripts in one response (planning ahead).
  // Executing only the first and dropping the rest silently is the worst
  // option — the model believes everything it wrote will run — so the caller
  // rejects the whole output with corrective feedback instead.
  | { kind: "multiple"; count: number }
  // A fenced block exists but nothing runnable came out of it: leading
  // comments or statements before the arrow function, or a non-JavaScript
  // language tag the extraction regex refuses. Nothing can run; the caller
  // sends corrective feedback (models habitually open code with a comment
  // line, and silence here reads as the platform hanging).
  | { kind: "malformed" }
  | { kind: "none" };

function extractAsyncJsSnippet(content: string): SnippetExtraction {
  // Fences count only at line starts: scripts legitimately carry ``` inside
  // string literals (chat messages formatted as markdown), and in valid JS
  // those always sit mid-line — a raw newline cannot appear in a string
  // literal, and an unescaped ``` would terminate a template literal. A fence
  // match anywhere used to cut the script at the first embedded ``` and
  // execute an unparseable prefix (unclosed string literal).
  const blocks = content.match(new RegExp(FENCED_SNIPPET_RE, "gim")) ?? [];
  if (blocks.length > 1) return { kind: "multiple", count: blocks.length };
  const fenced = content.match(FENCED_SNIPPET_RE);
  const code = (fenced?.[1] ?? content).trim();
  if (/^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code)) {
    return { kind: "script", code };
  }
  // Any response carrying a line-start fence that did not yield a runnable
  // script is a malformed attempt — including fences with a non-JS language
  // tag, which FENCED_SNIPPET_RE refuses to match. Only a fence-free
  // non-script response is a deliberate no-op turn; the system prompt
  // promises rejection-with-feedback for everything else.
  return fenced !== null || /^[ \t]*```/m.test(content) ? { kind: "malformed" } : { kind: "none" };
}

// The "tool result" half of the codemode loop: a finished script execution
// renders back into model-visible history so the next turn can look at the
// data. Two deliberate gaps end the loop instead of feeding it:
// - executions this agent did not request stay invisible (other scripts —
//   e.g. Slack bang commands — journal on the same stream);
// - a script that returned undefined and did not throw produces nothing.
//   Returning no value is how an agent ends its turn.
async function scriptResultAgentInput(
  event: Extract<
    AgentConsumedEvent,
    { type: "events.iterate.com/capability-host/script-execution-completed" }
  >,
  writeWorkspaceFile: AgentProcessorDeps["writeWorkspaceFile"],
): Promise<string | null> {
  const payload = event.payload;
  if (!payload.executionId.startsWith(AGENT_SCRIPT_EXECUTION_ID_PREFIX)) return null;
  if (payload.error !== undefined) {
    // Advertise the recovery tools at the moment of failure — a wrong call
    // is exactly when docs.typecheck's did-you-mean and docs.search's
    // working examples pay off, and nothing else tells the model they exist.
    return (
      `Your script threw:\n\`\`\`\n${truncateScriptResult(payload.error)}\n\`\`\`\n` +
      `Before retrying: \`await itx.docs.typecheck({ code })\` compiles a script against this ` +
      `scope's real types (typos come back as "did you mean …"), and ` +
      `\`await itx.docs.search({ q: "several related words" })\` finds working examples.`
    );
  }
  if (payload.result === undefined) return null;
  const text = stringifyScriptResult(payload.result);
  // String results are raw text, not JSON — the fence label, the spill
  // file's extension, and the read-it-back recipe all say so honestly.
  const isRawText = typeof payload.result === "string";
  const fence = isRawText ? "```" : "```json";
  if (text.length > SCRIPT_RESULT_HISTORY_LIMIT && writeWorkspaceFile !== undefined) {
    try {
      const spilledPath = await spillScriptResult({
        executionId: payload.executionId,
        extension: isRawText ? "txt" : "json",
        text,
        writeWorkspaceFile,
      });
      return [
        "Your script returned:",
        fence,
        text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT),
        "```",
        spillNotice({ isRawText, path: spilledPath, totalChars: text.length }),
      ].join("\n");
    } catch (error) {
      // Spilling is best effort: a workspace that cannot clone or write must
      // not lose the result entirely — fall through to inline truncation.
      console.error("[agent] failed to spill oversized script result to workspace", {
        error,
        executionId: payload.executionId,
      });
    }
  }
  return `Your script returned:\n${fence}\n${truncateScriptResult(text)}\n\`\`\``;
}

function stringifyScriptResult(result: unknown): string {
  // A returned string renders as itself: JSON.stringify would escape every
  // newline and quote, turning a fetched page or file into one unreadable
  // escaped line the model pays to mentally unescape (seen live: an 8.8KB
  // worker.ts as a single escape-riddled JSON string). Non-strings keep the
  // pretty-printed JSON shape.
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

const SCRIPT_RESULT_HISTORY_LIMIT = 30_000;

function truncateScriptResult(text: string): string {
  if (text.length <= SCRIPT_RESULT_HISTORY_LIMIT) return text;
  return `${text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT)}\n… truncated (${text.length} chars total — return less: slice arrays, pick fields)`;
}

/**
 * Where oversized script results land inside the agent's workspace checkout:
 * scratch files for the model to page through with itx.workspace, never meant
 * to be committed. One file per execution, so replays overwrite idempotently.
 * Size is no concern — workspace files past the inline threshold are stored
 * in R2 transparently.
 */
const SCRIPT_RESULT_SPILL_DIR = "/script-results";

/** Writes the full result text into the agent's workspace; returns its path. */
async function spillScriptResult(input: {
  executionId: string;
  extension: "json" | "txt";
  text: string;
  writeWorkspaceFile: NonNullable<AgentProcessorDeps["writeWorkspaceFile"]>;
}): Promise<string> {
  // Workspace publishes commit every non-ignored local file — without this
  // nested ignore every spill would ride along into workspace snapshot
  // commits (the overlay publish honors .gitignore).
  await input.writeWorkspaceFile({ content: "*\n", path: `${SCRIPT_RESULT_SPILL_DIR}/.gitignore` });
  const path = `${SCRIPT_RESULT_SPILL_DIR}/${input.executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.${input.extension}`;
  await input.writeWorkspaceFile({ content: input.text, path });
  return path;
}

/**
 * The model-facing text after a truncated preview: where the full result
 * lives and a concrete next-script recipe for paging it, so the model reads
 * the file with plain JavaScript instead of re-running the expensive fetch.
 */
function spillNotice(input: { isRawText: boolean; path: string; totalChars: number }): string {
  const readRecipe = input.isRawText
    ? [
        `  const text = await itx.workspace.readFile(${JSON.stringify(input.path)});`,
        "  return text.slice(30_000, 60_000); // page/regex to return only what you need",
      ]
    : [
        `  const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(input.path)}));`,
        "  return Object.keys(data); // then slice/filter/regex to return only what you need",
      ];
  return [
    `…truncated: showing the first ${SCRIPT_RESULT_HISTORY_LIMIT.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(input.path)} — don't re-fetch; read and filter it with plain JavaScript in your next script, e.g.:`,
    "```js",
    "async (itx) => {",
    ...readRecipe,
    "}",
    "```",
  ].join("\n");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
