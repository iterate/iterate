import { mergeProcessorConfig, StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  AgentNextProcessorContract,
  type AgentNextContextAddedPayload,
  type AgentNextState,
} from "./agent-processor-contract.ts";

/**
 * The clean-room agent processor. Design: tasks/simplify-stream-processor-contract.md.
 *
 * HOW IT WORKS, end to end:
 *
 * Context events arrive on the agent's stream (`agents/context-added`: user
 * messages, developer notes, script results, assistant output). The pure
 * `reduce` fold projects them into `state.contextItems` — ONE ordered list;
 * system items sit in place — and records the newest turn-worthy one as
 * `state.pendingLlmRequestTrigger`. When `processEvent` runs at the head of
 * the stream with a trigger pending and no request open, it waits out a
 * short debounce window (plus failure backoff) and then journals the INTENT
 * to run one turn: an `agent/llm-request-requested` event. That event's own
 * journal offset IS the request's identity — there are no synthetic ids
 * anywhere; every related idempotency key derives from an offset.
 *
 * The requested event comes back through the processor's own subscription;
 * the fold opens `state.openRequest`, and the at-head pass finds an open
 * request this incarnation is not executing and starts the LLM call — the
 * ONE place work ever starts. Because the intent lives in the journal and
 * not in a closure, recovery is the same code path: after an eviction the
 * platform appends `stream/processor-revived`, the fresh incarnation folds
 * the journal, sees the open request, and adopts it — same offset, same
 * idempotency keys, so a zombie incarnation racing the successor collapses
 * to one journal story on the shared `settle/<offset>` key.
 *
 * Success lands as ONE atomic append: the assistant context item plus the
 * `agent/llm-request-settled` fact. Failures settle with an accompanying
 * `stream/error-occurred` event; the fold schedules the retry (backoff and
 * caps are plain state arithmetic), and EVERY error-occurred event on the
 * stream — from this processor or anything else — is transcribed into
 * model-visible context so the next turn can see it. Cancellation is a
 * property of new input (`llmRequestPolicy: interrupt-current-request`),
 * never a free-standing command: the interrupt aborts the in-flight call,
 * settles the request cancelled with the streamed partial text, and the
 * interrupting message's own trigger drives the next turn.
 *
 * At most ONE LLM request is ever open: `state.openRequest` is a single slot
 * and the requested-event fold-guard drops intents while it is set.
 * Concurrency belongs to subagents (separate streams), not to parallel turns
 * over one conversation fold. Runaway self-driven chains hit the
 * `maxAutonomousTurns` breaker, which journals `agent/paused` (mirroring
 * stream/paused); the next external message journals `agent/resumed`.
 *
 * All tuning (model, debounce, expiry, retry policy, breaker threshold)
 * lives in `state.config` with schema defaults; `agent/configured` merges
 * partial patches.
 */
export class AgentNextProcessor extends StreamProcessor<AgentNextProcessorContract, AgentNextDeps> {
  readonly contract = AgentNextProcessorContract;

  /**
   * RUNTIME state: in-memory, dies with the isolate, never persisted. The one
   * LLM call THIS incarnation is executing (mirroring the single
   * `state.openRequest` slot), with its abort handle and the text streamed so
   * far (preserved into the cancelled settlement when an interrupt aborts
   * mid-response). The journal never knows about incarnations — a fresh one
   * folds the journal, finds the open request absent here, and runs it again
   * (adopt-based recovery).
   */
  #inFlightLlmCall: {
    requestOffset: number;
    controller: AbortController;
    partialText: string;
  } | null = null;

  // ------------------------------------------------------------ processEvent
  // Synchronous. The two side-effect lanes are chosen HERE, at the dispatch
  // site, never inside helpers. The rule for choosing:
  //
  // - PER-EVENT consequences (rendering a script result, transcribing an
  //   error) use `blockProcessorWhile`: the event will not be delivered
  //   again once the cursor passes it, so losing the append would lose the
  //   consequence forever — at-least-once is the point, and the work is one
  //   fast local append.
  // - STATE-DERIVED consequences (the whole block after `delivery.caughtUp`)
  //   use `runInBackground`: a lost attempt is re-derived by ANY later
  //   delivery over the same fold, so nothing needs to hold the cursor.
  protected override processEvent(args: ProcessEventArgs<AgentNextProcessorContract>): undefined {
    const { event, state, blockProcessorWhile, runInBackground, append, delivery } = args;

    switch (event?.type) {
      case "events.iterate.com/agents/context-added": {
        const payload = event.payload;
        // INTERRUPT — cancellation is a property of new input, never a
        // free-standing command. Abort whatever this incarnation is running
        // and settle the open request as cancelled, carrying the streamed
        // partial text. A zombie's success settlement racing this loses on
        // the shared settle key; whichever append lands second is dropped.
        if (
          payload.llmRequestPolicy.behaviour === "interrupt-current-request" &&
          (payload.role === "user" || payload.role === "developer") &&
          state.openRequest !== null
        ) {
          const open = state.openRequest;
          this.#inFlightLlmCall?.controller.abort();
          const partialText =
            this.#inFlightLlmCall?.requestOffset === open.requestedAtOffset &&
            this.#inFlightLlmCall.partialText !== ""
              ? this.#inFlightLlmCall.partialText
              : undefined;
          const appends: EmittedInput<AgentNextProcessorContract>[] = [];
          if (partialText !== undefined) {
            appends.push({
              type: "events.iterate.com/agents/context-added",
              payload: {
                // The streamed partial stays model-visible — the next turn
                // must know what the user already watched stream, or the
                // model repeats or contradicts it. No `llmRequestOffset`:
                // this is a record of an interruption, not parseable output
                // (script extraction must never run on a half response).
                role: "assistant",
                content: `[Response interrupted by the user's next message; partial output follows]\n${partialText}`,
              },
              idempotencyKey: this.idempotencyKey(
                `render-interrupted-partial@${open.requestedAtOffset}`,
              ),
            });
          }
          appends.push({
            type: "events.iterate.com/agent/llm-request-settled",
            payload: {
              requestOffset: open.requestedAtOffset,
              result: {
                status: "cancelled",
                reason: "interrupted-by-user-input",
                ...(partialText === undefined ? {} : { partialText }),
              },
            },
            idempotencyKey: this.idempotencyKey(`settle/${open.requestedAtOffset}`),
          });
          // Block: this is a per-event consequence of THE interrupting
          // message. If the cancel append were a droppable attempt, a crash
          // after the cursor passed this event would leave the open request
          // uncancelled — and the next at-head pass would ADOPT and run the
          // very request the user tried to stop.
          blockProcessorWhile(() => this.#appendUnlessLostIdempotencyRace(append, appends));
          // STOP: nothing below may act this frame. The at-head code would
          // otherwise re-run the very request the queued settlement is about
          // to cancel (it reads the pre-cancel fold — the eviction-window
          // interrupt case, where nothing here is executing the request). The
          // settlement's own delivery re-runs everything over the settled
          // fold, where the interrupting input's trigger drives the next turn.
          return;
        }
        // RESPONSE PARSING — an accepted assistant output may carry a script;
        // extraction rides the same delivery that folded the text. Blocked for
        // the same per-event reason as above: this event is delivered once.
        if (
          payload.role === "assistant" &&
          payload.llmRequestOffset !== undefined &&
          payload.llmRequestOffset === state.openRequest?.requestedAtOffset
        ) {
          const code = extractAgentScript(payload.content);
          if (code !== null) {
            blockProcessorWhile(() =>
              // Deterministic body (expiresAt anchors to the assistant event,
              // never `now`): an at-least-once redelivery of this event
              // re-appends the identical request and dedupes on the key —
              // a `now`-stamped expiry would make the re-append a same-key
              // CONFLICT and wedge the frame forever. The race-tolerant
              // append covers a config change between deliveries.
              this.#appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/capability-host/script-run-requested",
                  payload: {
                    code,
                    executionId: `agent-output:${event.offset}`,
                    expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
                  },
                  idempotencyKey: this.idempotencyKey(`script-run-requested@${event.offset}`),
                },
              ]),
            );
          }
        }
        break;
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        const { executionId, settlement } = event.payload;
        if (!executionId.startsWith("agent-output:")) break;
        // Per-event render (blocked): the settlement is delivered once, and a
        // lost render would silently drop the script's result from the
        // conversation. Race-tolerant: a truncation-limit config change
        // between redeliveries alters the rendered body under the same key.
        blockProcessorWhile(() =>
          this.#appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                role: "developer",
                content: renderScriptSettlement(
                  executionId,
                  settlement,
                  state.config.scriptResultHistoryLimit,
                ),
                actor: { type: "script", executionId },
                llmRequestPolicy: { behaviour: "after-current-request" },
              },
              idempotencyKey: this.idempotencyKey(`render-script-result@${event.offset}`),
            },
          ]),
        );
        break;
      }
      case "events.iterate.com/stream/error-occurred": {
        // EVERY error on the stream — this processor's own LLM failures, the
        // runner's poison skips, anything else — is transcribed into
        // model-visible context, without itself triggering a turn (retries
        // are the fold's job). The integration actor demotes the error text
        // to user role at prompt time: error strings are data, not
        // instructions. Per-event render (blocked): delivered once.
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agents/context-added",
            payload: {
              role: "developer",
              content: `Error on stream: ${event.payload.message}`,
              actor: { type: "integration", name: "stream-error" },
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
            idempotencyKey: this.idempotencyKey(`transcribe-error@${event.offset}`),
          }),
        );
        break;
      }
      // created / configured / requested / settled / paused / resumed /
      // script-run-requested / revived: no per-event effect — they matter
      // through the fold below.
    }

    // ---------------------------------------- state-derived side effects
    // Plain code over the fold, after every delivery. Act only at head —
    // behind it the fold is partial and outcomes may sit in journal pages not
    // yet replayed. Everything here is re-derived by any later delivery, so
    // every append is a droppable background attempt.
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null) return;

    // Paused: turns stay parked until fresh EXTERNAL input journals the
    // resume (self-driven triggers are exactly what the breaker paused).
    if (state.paused !== null) {
      const trigger = state.pendingLlmRequestTrigger;
      if (trigger?.source === "external") {
        runInBackground(() =>
          append({
            type: "events.iterate.com/agent/resumed",
            payload: { reason: "external input" },
            idempotencyKey: this.idempotencyKey(`resume/${trigger.offset}`),
          }),
        );
      }
      return;
    }

    // A trigger is pending and nothing is open → journal the intent (or trip
    // the breaker), and STOP. The LLM call does not start here: the requested
    // event comes back through our own subscription carrying the offset the
    // journal gave it, and the adopt branch below — the ONE place work ever
    // starts — picks it up. Starting fresh and recovering after an eviction
    // are the same code path.
    const trigger = state.pendingLlmRequestTrigger;
    if (trigger !== null && state.openRequest === null) {
      const { maxAutonomousTurns } = state.config;
      if (trigger.source === "agent-loop" && state.autonomousTurnCount >= maxAutonomousTurns) {
        runInBackground(() =>
          append({
            type: "events.iterate.com/agent/paused",
            payload: {
              reason: `autonomous turn limit reached (${maxAutonomousTurns} consecutive turns without external input)`,
            },
            idempotencyKey: this.idempotencyKey(`pause/${trigger.offset}`),
          }),
        );
        return;
      }
      // Debounce = wait for more content, plus failure backoff — one window,
      // anchored at the trigger. The delayed append IS the intent (no wake
      // event): if the trigger moves or an interrupt clears it before the
      // sleep ends, the requested event's fold-guard turns the late intent
      // into a harmless journal fact. A droppable attempt: dying mid-window
      // means the revival turn re-runs this code with the window long closed
      // and appends immediately.
      //
      // Every delivery at head while the window is open schedules ANOTHER
      // sleep-then-append for the same trigger, so the intent body must be
      // DETERMINISTIC from trigger + config (expiresAt anchors to the
      // trigger's time, never `now`): identical bodies dedupe on the key. A
      // config change between schedulings makes the late body differ — the
      // race-tolerant append lets the first-committed intent stand.
      const windowMs = state.config.llmRequestDebounceMs + retryBackoffMs(state);
      const windowClosesInMs = trigger.atMs + windowMs - this.#now();
      const intent: EmittedInput<AgentNextProcessorContract> = {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          model: state.config.llm.model,
          expiresAt: trigger.atMs + state.config.llmRequestExpiryMs,
        },
        // Dedupe fence only, keyed on the trigger's coordinates — the
        // request's IDENTITY is the offset the journal assigns on commit.
        idempotencyKey: this.idempotencyKey(`request/${trigger.offset}`),
      };
      runInBackground(async () => {
        if (windowClosesInMs > 0) await this.#sleep(windowClosesInMs);
        await this.#appendUnlessLostIdempotencyRace(append, [intent]);
      });
      return;
    }

    // An open request nobody HERE is executing → run it. First time through,
    // that is the normal start (our own requested event arriving at head);
    // after an eviction it is the recovery (the revived fact arriving at
    // head). Expired → settle it instead, with the error transcribed for the
    // next turn: answering a stale trigger with a stale context snapshot is
    // worse than admitting the miss.
    const open = state.openRequest;
    if (open !== null && this.#inFlightLlmCall?.requestOffset !== open.requestedAtOffset) {
      if (this.#now() >= open.expiresAt) {
        runInBackground(() =>
          this.#appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agent/llm-request-settled",
              payload: {
                requestOffset: open.requestedAtOffset,
                result: { status: "cancelled", reason: "expired" },
              },
              idempotencyKey: this.idempotencyKey(`settle/${open.requestedAtOffset}`),
            },
            {
              type: "events.iterate.com/stream/error-occurred",
              payload: {
                message: `LLM request @${open.requestedAtOffset} expired before it ran; the pending turn was dropped. A new message starts fresh.`,
              },
              idempotencyKey: this.idempotencyKey(`expiry-error/${open.requestedAtOffset}`),
            },
          ]),
        );
      } else {
        this.#runLlmRequest(args, open);
      }
    }
  }

  /**
   * Execute the LLM call for a journaled intent — background work: it can run
   * for minutes, and the journal (not this closure) is what survives an
   * eviction. Success lands as ONE atomic append: the assistant context item
   * plus the settlement, both idempotency-keyed on the request's offset, so a
   * zombie racing a fresh incarnation collapses to one journal story.
   */
  #runLlmRequest(
    args: ProcessEventArgs<AgentNextProcessorContract>,
    open: NonNullable<AgentNextState["openRequest"]>,
  ) {
    const requestOffset = open.requestedAtOffset;
    const inFlight = { requestOffset, controller: new AbortController(), partialText: "" };
    this.#inFlightLlmCall = inFlight;
    const startedAtMs = this.#now();
    let chunkSequence = 0;
    args.runInBackground(async () => {
      try {
        const response = await this.deps.callLlm({
          model: open.model,
          messages: buildLlmMessages({
            contextItems: args.state.contextItems,
            requestedAtOffset: requestOffset,
            nowIso: new Date(this.#now()).toISOString(),
          }),
          signal: inFlight.controller.signal,
          onChunk: (text) => {
            inFlight.partialText += text;
            const sequence = chunkSequence;
            chunkSequence += 1;
            // Ephemeral streaming: best-effort, never awaited, never folded.
            void args
              .append({
                type: "events.iterate.com/agent/llm-response-chunk",
                payload: { requestOffset, sequence, text },
              })
              .catch(() => undefined);
          },
        });
        await this.#appendUnlessLostIdempotencyRace(args.append, [
          {
            type: "events.iterate.com/agents/context-added",
            payload: {
              role: "assistant",
              content: response.text,
              llmRequestOffset: requestOffset,
            },
            idempotencyKey: this.idempotencyKey(`assistant-context@${requestOffset}`),
          },
          {
            type: "events.iterate.com/agent/llm-request-settled",
            payload: {
              requestOffset,
              durationMs: Math.max(0, this.#now() - startedAtMs),
              result: {
                status: "succeeded",
                text: response.text,
                ...(response.usage === undefined ? {} : { usage: response.usage }),
              },
            },
            idempotencyKey: this.idempotencyKey(`settle/${requestOffset}`),
          },
        ]);
      } catch (error) {
        // An aborted call is the interrupt path's story — it already settled
        // the request as cancelled.
        if (inFlight.controller.signal.aborted) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Attempt arithmetic from the dispatch-time fold: this failure is
        // attempt (consecutiveLlmFailures + 1). The settled event's fold
        // schedules the retry; the error-occurred event gets transcribed into
        // context so the next turn sees what happened.
        const attempt = args.state.consecutiveLlmFailures + 1;
        const { maxAttempts } = args.state.config.llmRequestRetryPolicy;
        await this.#appendUnlessLostIdempotencyRace(args.append, [
          {
            type: "events.iterate.com/agent/llm-request-settled",
            payload: {
              requestOffset,
              durationMs: Math.max(0, this.#now() - startedAtMs),
              result: { status: "failed", errorMessage },
            },
            idempotencyKey: this.idempotencyKey(`settle/${requestOffset}`),
          },
          {
            type: "events.iterate.com/stream/error-occurred",
            payload: {
              message:
                attempt < maxAttempts
                  ? `LLM request @${requestOffset} failed (attempt ${attempt} of ${maxAttempts}): ${errorMessage}. Retrying.`
                  : `LLM request @${requestOffset} failed (attempt ${attempt} of ${maxAttempts}): ${errorMessage}. Giving up; a new user message starts fresh.`,
            },
            idempotencyKey: this.idempotencyKey(`failure-error/${requestOffset}`),
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
   * Append a batch whose idempotency keys may race concurrent writers: every
   * writer of `settle/<offset>` (success, failure, interrupt, expiry) races
   * every other, and two debounce schedulings of one trigger race on
   * `request/<offset>` when config changed between them. The journal rejects
   * a same-key append with a different body; the FIRST writer's story stands
   * and losing the race is success — the obligation is settled/journaled, and
   * the fold sorts out whose fact counts.
   */
  async #appendUnlessLostIdempotencyRace(
    append: ProcessEventArgs<AgentNextProcessorContract>["append"],
    events: EmittedInput<AgentNextProcessorContract>[],
  ): Promise<void> {
    try {
      await append(...events);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/idempotency key .* already names a different event/.test(message)) throw error;
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure fold, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<AgentNextProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/agent/created":
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: { createdAtOffset: event.offset } };
      case "events.iterate.com/agent/configured":
        // Deep-merge the patch (omitted keys keep their values), then
        // re-validate against the complete config schema — the framework's
        // standard config recipe (mergeProcessorConfig).
        return {
          ...state,
          config: this.contract.stateSchema.shape.config.parse(
            mergeProcessorConfig(state.config, event.payload.config),
          ),
        };
      case "events.iterate.com/agent/llm-request-requested": {
        // Fold-guard: a late debounced intent — trigger interrupted away, a
        // sibling intent already won, or the agent paused meanwhile — folds
        // to nothing, a harmless journal fact. THIS is what makes the delayed
        // append safe without any timer bookkeeping or cancellation.
        if (
          state.pendingLlmRequestTrigger === null ||
          state.openRequest !== null ||
          state.paused !== null
        ) {
          return state;
        }
        return {
          ...state,
          pendingLlmRequestTrigger: null,
          openRequest: {
            requestedAtOffset: event.offset,
            expiresAt: event.payload.expiresAt,
            model: event.payload.model,
          },
          // The turn covers everything folded so far: keyed context updates
          // after this point append occurrences instead of replacing in place.
          lastLlmRequestOffset: event.offset,
          autonomousTurnCount:
            state.pendingLlmRequestTrigger.source === "agent-loop"
              ? state.autonomousTurnCount + 1
              : state.autonomousTurnCount,
        };
      }
      case "events.iterate.com/agent/llm-request-settled": {
        // Fold-guard: a stale settlement (zombie driver finishing a turn an
        // interrupt already closed) folds to nothing.
        if (event.payload.requestOffset !== state.openRequest?.requestedAtOffset) return state;
        const settled = { ...state, openRequest: null };
        const result = event.payload.result;
        if (result.status === "succeeded") return { ...settled, consecutiveLlmFailures: 0 };
        if (result.status === "cancelled") return settled;
        const failures = state.consecutiveLlmFailures + 1;
        return {
          ...settled,
          consecutiveLlmFailures: failures,
          // Under the retry cap the failure itself is the next trigger — the
          // retry is pure fold arithmetic, no wake event, no rendered nudge.
          // At the cap the conversation waits for fresh input.
          ...(failures < state.config.llmRequestRetryPolicy.maxAttempts
            ? {
                pendingLlmRequestTrigger: {
                  offset: event.offset,
                  atMs: Date.parse(event.createdAt),
                  source: "agent-loop" as const,
                },
              }
            : {}),
        };
      }
      case "events.iterate.com/agent/paused":
        // The breaker (or an operator) parked the loop. Only a SELF-DRIVEN
        // pending trigger dies with it: an external trigger that raced the
        // pause append survives, so the paused branch of the at-head pass
        // immediately journals the resume — a user message can never be
        // swallowed by a pause it crossed in flight.
        return {
          ...state,
          paused: {
            ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
            atOffset: event.offset,
          },
          pendingLlmRequestTrigger:
            state.pendingLlmRequestTrigger?.source === "agent-loop"
              ? null
              : state.pendingLlmRequestTrigger,
        };
      case "events.iterate.com/agent/resumed":
        return {
          ...state,
          paused: null,
          autonomousTurnCount: 0,
          // Re-anchor a surviving trigger to THIS event. A debounced intent
          // that landed during the pause folded to nothing but still consumed
          // the trigger-keyed `request/<offset>` idempotency key —
          // re-scheduling under the old key would dedupe to that no-op event
          // forever and strand the trigger. A fresh offset is a fresh key; it
          // also restarts the debounce window and the expiry horizon from
          // resume time instead of a possibly long-stale trigger time (a
          // pause longer than llmRequestExpiryMs would otherwise open a
          // request that instantly settles expired).
          pendingLlmRequestTrigger:
            state.pendingLlmRequestTrigger === null
              ? null
              : {
                  offset: event.offset,
                  atMs: Date.parse(event.createdAt),
                  source: state.pendingLlmRequestTrigger.source,
                },
        };
      case "events.iterate.com/capability-host/script-run-requested":
        if (!event.payload.executionId.startsWith("agent-output:")) return state;
        return {
          ...state,
          activeScriptExecutionIds: [...state.activeScriptExecutionIds, event.payload.executionId],
        };
      case "events.iterate.com/capability-host/script-run-settled":
        return {
          ...state,
          activeScriptExecutionIds: state.activeScriptExecutionIds.filter(
            (id) => id !== event.payload.executionId,
          ),
        };
      case "events.iterate.com/agents/context-added": {
        const payload = event.payload;
        // Fold-guard: assistant output for a request that is no longer the
        // open one (an interrupt won the race) folds to nothing — text
        // included.
        if (
          payload.role === "assistant" &&
          payload.llmRequestOffset !== undefined &&
          payload.llmRequestOffset !== state.openRequest?.requestedAtOffset
        ) {
          return state;
        }
        const contextItems = projectContextAdded({
          items: state.contextItems,
          lastLlmRequestOffset: state.lastLlmRequestOffset,
          item: { offset: event.offset, payload },
        });
        const trigger = contextTriggerSource(payload);
        if (trigger === null) return { ...state, contextItems };
        return {
          ...state,
          contextItems,
          // Every trigger moves the pending slot — newest wins; the debounce
          // window and the intent idempotency key anchor to these coordinates.
          pendingLlmRequestTrigger: {
            offset: event.offset,
            atMs: Date.parse(event.createdAt),
            source: trigger,
          },
          // Fresh external input is a fresh start: the autonomous-turn budget
          // and the failure streak both reset.
          ...(trigger === "external" ? { autonomousTurnCount: 0, consecutiveLlmFailures: 0 } : {}),
        };
      }
      default:
        // stream/processor-revived, stream/error-occurred, and anything else
        // consumed only for its delivery turn: no fold change.
        return state;
    }
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #sleep(ms: number): Promise<void> {
    return this.deps.sleep === undefined
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : this.deps.sleep(ms);
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

export type AgentLlmMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
};

/** The injected LLM transport — the processor's only vendor surface, so tests
 * swap in a scripted fake and the processor never knows. */
export type AgentLlmTransport = (args: {
  model: string;
  messages: AgentLlmMessage[];
  signal: AbortSignal;
  onChunk?: (text: string) => void;
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

export type AgentNextDeps = {
  callLlm: AgentLlmTransport;
  /** Injectable clock and sleep — virtual time in tests, real time in prod. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// -----------------------------------------------------------------------------
// Pure helpers — exported for direct unit testing.
// -----------------------------------------------------------------------------

/** Which turn-loop trigger a context item carries. A trigger only ever comes
 * from context or from a failed settlement's fold — there is no other
 * scheduling input. */
export function contextTriggerSource(
  payload: AgentNextContextAddedPayload,
): "external" | "agent-loop" | null {
  if (payload.role === "system" || payload.role === "assistant") return null;
  if (payload.llmRequestPolicy.behaviour === "dont-trigger-request") return null;
  if (payload.role === "user") return "external";
  const actorType = payload.actor?.type;
  // The agent's own notes and its scripts drive the autonomous loop; every
  // other developer-lane author (integration, webhook, human tooling) is an
  // external trigger.
  return actorType === "agent" || actorType === "script" ? "agent-loop" : "external";
}

/**
 * Fold one context item into the list. The rule, in one sentence: if no LLM
 * request has seen the keyed item yet, an update with the same key replaces
 * it in place; once a request has seen it, the update appends a new
 * occurrence (append-only history — every covered prompt stays
 * reconstructible).
 */
export function projectContextAdded(args: {
  items: AgentNextState["contextItems"];
  lastLlmRequestOffset: number;
  item: AgentNextState["contextItems"][number];
}): AgentNextState["contextItems"] {
  const key = args.item.payload.key;
  if (key !== undefined) {
    const slotIndex = args.items.findLastIndex((existing) => existing.payload.key === key);
    if (slotIndex >= 0 && args.items[slotIndex]!.offset > args.lastLlmRequestOffset) {
      const replaced = [...args.items];
      replaced[slotIndex] = args.item;
      return replaced;
    }
  }
  return [...args.items, args.item];
}

/** Exponential failure backoff folded into the debounce window: doubling from
 * the policy's base, capped at its ceiling. */
export function retryBackoffMs(
  state: Pick<AgentNextState, "consecutiveLlmFailures" | "config">,
): number {
  const { backoffBaseMs, backoffMaxMs } = state.config.llmRequestRetryPolicy;
  if (state.consecutiveLlmFailures <= 0) return 0;
  return Math.min(2 ** (state.consecutiveLlmFailures - 1) * backoffBaseMs, backoffMaxMs);
}

/** Build the model-facing message array from the fold: the covered items in
 * journal order (system items sit in place — providers accept system content
 * mid-history), then the timestamp. The CONTENT is pinned to the request's
 * offset, so an adopting incarnation reproduces the covered context exactly;
 * the trailing timestamp deliberately is NOT pinned — it reports the actual
 * attempt time (a late adoption honestly says so), and it sits last so the
 * provider's prompt-cache prefix is unaffected either way. Developer items
 * from anyone but the agent or its scripts are DEMOTED to user role (trust
 * boundary). */
export function buildLlmMessages(args: {
  contextItems: AgentNextState["contextItems"];
  requestedAtOffset: number;
  nowIso: string;
}): AgentLlmMessage[] {
  const messages: AgentLlmMessage[] = [];
  for (const item of args.contextItems) {
    if (item.offset > args.requestedAtOffset) continue;
    // Trust demotion: developer items from anyone but the agent or its own
    // scripts read as user content, never as instructions.
    const actorType = item.payload.actor?.type;
    const role =
      item.payload.role !== "developer"
        ? item.payload.role
        : actorType === "agent" || actorType === "script"
          ? "developer"
          : "user";
    messages.push({ role, content: renderContextItem(item) });
  }
  messages.push({ role: "developer", content: `The current time is ${args.nowIso}.` });
  return messages;
}

function renderContextItem(item: AgentNextState["contextItems"][number]): string {
  const headerParts = [`@${item.offset}`];
  if (item.payload.key !== undefined) headerParts.push(`key=${item.payload.key}`);
  const fileHints = (item.payload.files ?? []).map(
    (file) =>
      `\n[file: ${file.filename} (${file.contentType}, ${file.size} bytes) at ${file.path}]`,
  );
  return `${headerParts.join(" ")} ${item.payload.content}${fileHints.join("")}`;
}

/** Pull a runnable script out of assistant output: the first fenced ts/typescript
 * block containing an async shape. Returns null when the turn is prose-only. */
export function extractAgentScript(content: string): string | null {
  const fence = /```(?:ts|typescript)\n([\s\S]*?)```/.exec(content);
  if (fence === null) return null;
  const code = fence[1]!.trim();
  return code.includes("async") ? code : null;
}

/** Render a capability-host settlement as developer context. Oversized results
 * truncate — big payloads belong in files the next script reads. */
export function renderScriptSettlement(
  executionId: string,
  settlement: unknown,
  historyLimit: number,
): string {
  const body = JSON.stringify(settlement, null, 2) ?? String(settlement);
  const truncated =
    body.length > historyLimit
      ? `${body.slice(0, historyLimit)}\n… [truncated ${body.length - historyLimit} chars]`
      : body;
  return `Script ${executionId} settled:\n${truncated}`;
}
