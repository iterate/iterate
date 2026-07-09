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
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
  DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  type AgentFileAttachment,
} from "./agent-processor-contract.ts";
import {
  jsonCompatible,
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
 */
type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  writeWorkspaceFile?: (input: { content: string; path: string }) => Promise<void>;
  now?: () => number;
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
            idempotencyKey: `agent/system-prompt-updated@${event.offset}`,
            payload: { systemPrompt },
          }),
        );
        return;
      }
      case "events.iterate.com/agents/user-message-received":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-message@${event.offset}`,
            payload: {
              content: event.payload.content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          }),
        );
        return;
      case "events.iterate.com/agents/web-message-sent": {
        // Files the agent attached to its own message ride the reflection too,
        // so the model SEES what it sent (vision) on later turns.
        const files = event.payload.files;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-response@${event.offset}`,
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
        blockProcessorWhile(() => append(cancelEventForCurrentRequest(interrupted)));
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
            idempotencyKey: `itx/script-execution-requested@${event.offset}`,
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
            idempotencyKey: `agent/render-script-result@${event.offset}`,
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
        const retry = state.consecutiveLlmFailures < MAX_CONSECUTIVE_LLM_FAILURES;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-llm-failure@${event.offset}`,
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
      default:
        return;
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
          idempotencyKey: `agent/llm-request-cancelled@requested:${llmRequestOffset}`,
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
          idempotencyKey: `agent/llm-request-completed@${llmRequestOffset}`,
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
          idempotencyKey: `agent/autonomous-turn-limit:${state.pendingTriggerOffset}`,
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
        idempotencyKey: `agent/llm-request-scheduled@generation:${state.requestGeneration}`,
        payload: {
          debounceMs: DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
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
      // raw-append journals — or a reconciliation bug. Idempotent completion
      // keys make the backstop and any late real settle converge to one
      // durable outcome.
      const requestedAt = state.currentRequest.requestedAt;
      if (requestedAt === undefined) return;
      if (this.#now() - requestedAt < AGENT_LLM_REQUEST_BACKSTOP_MS) return;
      const llmRequestOffset = state.currentRequest.llmRequestOffset;
      await args.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `agent/backstop-completed@${llmRequestOffset}`,
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

  /** The one construction of llm-request-requested (debounce and recovery
   * paths), so the expiry stamp and idempotency key can never drift apart. */
  #buildLlmRequestRequested(input: { model: string; requestId: string; scheduledOffset: number }) {
    return {
      type: "events.iterate.com/agent/llm-request-requested" as const,
      idempotencyKey: `agent/llm-request-requested@${input.scheduledOffset}`,
      payload: {
        model: input.model,
        requestId: input.requestId,
        expiresAt: this.#now() + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
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
    await this.stream.append({
      type: "events.iterate.com/agent/llm-request-started",
      idempotencyKey: `agent/llm-request-started@${llmRequestOffset}`,
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
          await this.stream.append({
            type: "events.iterate.com/agent/llm-response-chunk",
            idempotencyKey: `agent/llm-response-chunk@${llmRequestOffset}:${index}`,
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
        idempotencyKey: `agent/llm-request-completed@${llmRequestOffset}`,
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
      if (await this.#isRequestStillCurrent({ llmRequestOffset })) {
        await this.stream.append(
          {
            type: "events.iterate.com/agent/output-added",
            idempotencyKey: `agent/output-added@${llmRequestOffset}`,
            payload: { content: completion.text, llmRequestOffset },
          },
          completedEvent,
        );
      } else {
        await this.stream.append(completedEvent);
      }
    } catch (error) {
      await this.stream.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `agent/llm-request-completed@${llmRequestOffset}`,
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
      return {
        ...next,
        consecutiveLlmFailures:
          event.payload.result.status === "failure" ? state.consecutiveLlmFailures + 1 : 0,
        currentRequest: null,
        requestGeneration: state.requestGeneration + 1,
      };
    }
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

function cancelEventForCurrentRequest(request: NonNullable<AgentState["currentRequest"]>) {
  if (request.phase === "scheduled") {
    return {
      type: "events.iterate.com/agent/llm-request-cancelled" as const,
      idempotencyKey: `agent/llm-request-cancelled@scheduled:${request.scheduledOffset}`,
      payload: {
        phase: "scheduled" as const,
        reason: "interrupted-by-user-input" as const,
        requestId: request.requestId,
      },
    };
  }

  return {
    type: "events.iterate.com/agent/llm-request-cancelled" as const,
    idempotencyKey: `agent/llm-request-cancelled@requested:${request.llmRequestOffset}`,
    payload: {
      phase: "requested" as const,
      reason: "interrupted-by-user-input" as const,
      llmRequestOffset: request.llmRequestOffset,
    },
  };
}

// =============================================================================
// Building the model-facing chat request.
// =============================================================================

/** One agent-history message as the model receives it. */
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
// Codemode: scripts out of outputs, script results back into inputs.
// =============================================================================

const AGENT_SCRIPT_EXECUTION_ID_PREFIX = "agent-output:";

/**
 * Failed-request error inputs stop auto-retrying once this many failures land
 * in a row (counter resets on any success). Two automatic retries, then wait
 * for the user.
 */
const MAX_CONSECUTIVE_LLM_FAILURES = 3;

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
  // The agent's documented publish flow is `git.add({ filepath: "." })` —
  // without this nested ignore every spill would ride along into workspace
  // commits (isomorphic-git's add respects .gitignore).
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
