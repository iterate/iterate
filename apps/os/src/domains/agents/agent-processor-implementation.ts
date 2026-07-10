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
import { subagentParentPath } from "../../lib/subagent-paths.ts";
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
  jsonCompatible,
  normalizeLlmUsage,
  runWorkersAiAttempt,
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
 */
type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  writeWorkspaceFile?: (input: { content: string; path: string }) => Promise<void>;
  now?: () => number;
  llmRetryBackoffBaseMs?: number;
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
        blockProcessorWhile(() => append(this.#cancelEventForCurrentRequest(interruptedRequest)));
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
        blockProcessorWhile(() => append(this.#cancelEventForCurrentRequest(interrupted)));
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
          const code = extractAsyncJsSnippet(event.payload.content);
          if (code === null) return;
          await append({
            type: "events.iterate.com/capability-host/script-execution-requested",
            idempotencyKey: this.idempotencyKey("script-execution-requested", event),
            payload: {
              code,
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
      // the threshold, summarize the conversation into a history-reset. A
      // droppable ATTEMPT like the LLM turn itself: the report is the durable
      // evidence, and if this incarnation dies mid-summary the next
      // over-threshold report re-triggers.
      case "events.iterate.com/agent/token-usage-reported": {
        const usage = event.payload;
        const contextTokens = usage.inputTokens + usage.outputTokens;
        const thresholdTokens = Math.floor(
          usage.maxContextTokens * AGENT_COMPACTION_TRIGGER_FRACTION,
        );
        if (contextTokens < thresholdTokens) return;
        runInBackground(() =>
          this.#compactHistory({
            contextTokens,
            llmRequestOffset: usage.llmRequestOffset,
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

  /** True while this incarnation has a summary in flight. Skip, don't queue:
   * the lane is best-effort and the next over-threshold report re-triggers,
   * so a second concurrent trigger has nothing to add. */
  #compactionInFlight = false;

  /**
   * One compaction attempt: summarize the whole model-visible conversation
   * with the agent's own model, then replace history with the summary (plus
   * any turns that landed while the summary ran, carried forward verbatim).
   * Best-effort by design — every early return leaves the journal untouched
   * and a later over-threshold report retries:
   *
   * - a reset landed since the measured prompt was built → the trigger is
   *   stale. This one check also covers redelivery: a re-run of an already
   *   compacted trigger finds its own earlier reset.
   * - history was rewritten mid-run (concurrent reset) → drop the summary
   * - the summary call itself fails → nothing durable changed; the base's
   *   runInBackground catch logs the error
   */
  async #compactHistory(input: {
    contextTokens: number;
    llmRequestOffset: number;
    thresholdTokens: number;
    triggerOffset: number;
  }): Promise<void> {
    const { contextTokens, llmRequestOffset, thresholdTokens, triggerOffset } = input;
    const ai = this.deps.ai;
    if (ai === undefined) return;
    if (this.#compactionInFlight) return;
    this.#compactionInFlight = true;
    try {
      // The report measured the prompt built at llmRequestOffset; any reset
      // after that point means the measurement describes a history that is
      // already gone (including this trigger's own reset, on redelivery).
      const resetsSinceMeasurement = await this.stream.getEvents({
        afterOffset: llmRequestOffset,
        eventTypes: ["events.iterate.com/agent/history-reset"],
        limit: 1,
      });
      if (resetsSinceMeasurement.length > 0) return;

      const state = reduceAgentEvents(await this.#readConsumedEvents());
      if (state.history.length === 0) return;
      const transcript = state.history
        .map(
          (message) =>
            `${message.role === "user" ? "User" : "Assistant"}:\n${flattenMessageToText(message)}`,
        )
        .join("\n\n");
      const summary = await runWorkersAiAttempt({
        ai,
        deadlineMs: DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
        messages: [
          { role: "system", content: AGENT_COMPACTION_PROMPT },
          { role: "user", content: transcript },
        ],
        model: state.llmConfig.model,
        onChunk: async () => {},
      });

      // Re-fold: turns that landed while the summary ran are carried forward
      // verbatim behind the summary; a rewritten prefix means another reset
      // won the race and this summary describes a conversation that no longer
      // exists.
      const stateNow = reduceAgentEvents(await this.#readConsumedEvents());
      const prefix = stateNow.history.slice(0, state.history.length);
      if (JSON.stringify(prefix) !== JSON.stringify(state.history)) return;
      const carriedForward = stateNow.history.slice(state.history.length);
      await this.append({
        type: "events.iterate.com/agent/history-reset",
        idempotencyKey: this.idempotencyKey(`history-reset@${triggerOffset}`),
        payload: {
          systemPrompt: stateNow.systemPrompt,
          history: [
            {
              role: "user" as const,
              content: `[Earlier conversation history was compacted. Summary:]\n\n${summary.text}`,
            },
            ...carriedForward,
          ],
          reason: `compaction@${triggerOffset}: ~${contextTokens} tokens > ${thresholdTokens}`,
        },
      });
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

  #cancelEventForCurrentRequest(request: NonNullable<AgentState["currentRequest"]>) {
    if (request.phase === "scheduled") {
      return {
        type: "events.iterate.com/agent/llm-request-cancelled" as const,
        idempotencyKey: this.idempotencyKey(
          `llm-request-cancelled@scheduled:${request.scheduledOffset}`,
        ),
        payload: {
          phase: "scheduled" as const,
          reason: "interrupted-by-user-input" as const,
          requestId: request.requestId,
        },
      };
    }

    return {
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
          await this.append({
            type: "events.iterate.com/agent/llm-response-chunk",
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
      // same breaker that stops script self-loops bounds parent↔subagent
      // reply ping-pong, because neither side's messages reset the other.
      const from = event.payload.from;
      const files = event.payload.files;
      const triggerSource =
        event.payload.llmRequestPolicy.behaviour === "dont-trigger-request"
          ? null
          : from.kind === "agent"
            ? ("agent-loop" as const)
            : ("user" as const);
      const content =
        from.kind === "agent"
          ? `Message from agent ${from.path}:\n${event.payload.content}`
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
    case "events.iterate.com/stream/child-stream-created": {
      // Every descendant stream announces its FULL path to every ancestor;
      // this agent's subagents are the announcements whose parent-agent path
      // is exactly this stream (event.path), so grandchildren stay out.
      const childPath = event.payload.childPath;
      if (subagentParentPath(childPath) !== event.path) return state;
      if (state.subagents.some((subagent) => subagent.path === childPath)) return state;
      return {
        ...state,
        subagents: [...state.subagents, { path: childPath, spawnedAt: event.createdAt }],
      };
    }
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
  return {
    messages: [{ role: "system" as const, content: state.systemPrompt }, ...state.history],
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
 * System prompt for the summary turn. The summary becomes the agent's ENTIRE
 * memory of everything before the reset, so it optimizes for retrieval keys —
 * names, paths, ids, decisions — over narrative flow.
 */
const AGENT_COMPACTION_PROMPT = [
  "You are compacting an AI agent's conversation history because it is close to overflowing the model's context window. Write a summary that will REPLACE the transcript below as the agent's only memory of it.",
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

// =============================================================================
// Context windows: model → the window the token-usage-reported payload claims.
// =============================================================================

/**
 * Context windows per model family, longest-prefix matched so dated variants
 * inherit their family's window. The OpenAI figures are our OPERATING window,
 * not the documented one: gpt-5.5's real window is 1.05M tokens, but 272k is
 * where OpenAI's pricing doubles, so compaction should treat that as full.
 * Kimi's documented window is 262,144; 256k is the safe round-down.
 */
const MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "openai/gpt-5.5": 272_000,
  "openai/gpt-5": 272_000,
  "@cf/moonshotai/kimi-k2.7-code": 256_000,
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

function extractAsyncJsSnippet(content: string): string | null {
  // Fences count only at line starts: scripts legitimately carry ``` inside
  // string literals (chat messages formatted as markdown), and in valid JS
  // those always sit mid-line — a raw newline cannot appear in a string
  // literal, and an unescaped ``` would terminate a template literal. A fence
  // match anywhere used to cut the script at the first embedded ``` and
  // execute an unparseable prefix (unclosed string literal).
  const fenced = content.match(
    /^[ \t]*```(?:js|javascript|ts|typescript)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/im,
  );
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
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
    return `Your script threw:\n\`\`\`\n${truncateScriptResult(payload.error)}\n\`\`\``;
  }
  if (payload.result === undefined) return null;
  const text = stringifyScriptResult(payload.result);
  if (text.length > SCRIPT_RESULT_HISTORY_LIMIT && writeWorkspaceFile !== undefined) {
    try {
      const spilledPath = await spillScriptResult({
        executionId: payload.executionId,
        text,
        writeWorkspaceFile,
      });
      return [
        "Your script returned:",
        "```json",
        text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT),
        "```",
        spillNotice({ path: spilledPath, totalChars: text.length }),
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
  return `Your script returned:\n\`\`\`json\n${truncateScriptResult(text)}\n\`\`\``;
}

function stringifyScriptResult(result: unknown): string {
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
  text: string;
  writeWorkspaceFile: NonNullable<AgentProcessorDeps["writeWorkspaceFile"]>;
}): Promise<string> {
  // Workspace publishes commit every non-ignored local file — without this
  // nested ignore every spill would ride along into workspace snapshot
  // commits (the overlay publish honors .gitignore).
  await input.writeWorkspaceFile({ content: "*\n", path: `${SCRIPT_RESULT_SPILL_DIR}/.gitignore` });
  const path = `${SCRIPT_RESULT_SPILL_DIR}/${input.executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
  await input.writeWorkspaceFile({ content: input.text, path });
  return path;
}

/**
 * The model-facing text after a truncated preview: where the full result
 * lives and a concrete next-script recipe for paging it, so the model reads
 * the file with plain JavaScript instead of re-running the expensive fetch.
 */
function spillNotice(input: { path: string; totalChars: number }): string {
  return [
    `…truncated: showing the first ${SCRIPT_RESULT_HISTORY_LIMIT.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(input.path)} — don't re-fetch; read and filter it with plain JavaScript in your next script, e.g.:`,
    "```js",
    "async (itx) => {",
    `  const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(input.path)}));`,
    "  return Object.keys(data); // then slice/filter/regex to return only what you need",
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
