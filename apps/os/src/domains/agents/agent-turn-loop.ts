// The agent's TURN LOOP component — one of the three parts composed into the
// agent processor (see agent-processor-implementation.ts). It owns the
// conversational loop: mirroring visible chat messages into history, clearing
// an agent-authored wait on a qualifying wake, interrupting an in-flight turn
// on new input, transcribing stream errors into model-visible context, and
// the whole at-head lifecycle — resume, the autonomous-turn breaker, the
// debounced intent, and adopting or expiring the open request. It does not
// talk to the model itself: it tells the AgentLlmRequest component when to
// run and when to abort.

import type { EmittedInput, ProcessEventArgs } from "iterate/processors";
import {
  appendUnlessLostIdempotencyRace,
  type AgentComponent,
  type AgentHost,
} from "./agent-host.ts";
import type { AgentProcessorContract, AgentProcessorState } from "./agent-processor-contract.ts";
import { contextClearsWaitingFor } from "./agent-prompt-fold.ts";
import type { AgentLlmRequest } from "./agent-llm-request.ts";
import { resolveSlashCommand } from "./slash-commands.ts";

export class AgentTurnLoop implements AgentComponent {
  readonly #host: AgentHost;
  readonly #llm: AgentLlmRequest;

  constructor(host: AgentHost, llm: AgentLlmRequest) {
    this.#host = host;
    this.#llm = llm;
  }

  // Synchronous. The two side-effect lanes are chosen HERE, at the dispatch
  // site, never inside helpers. The rule for choosing:
  //
  // - PER-EVENT consequences (the mirror, the waiting clear, the interrupt's
  //   cancel, the error transcription) use `blockProcessorWhile`: the event
  //   will not be delivered again once the cursor passes it, so losing the
  //   append would lose the consequence forever — at-least-once is the
  //   point, and the work is one fast local append.
  // - STATE-DERIVED consequences (the whole block after `delivery.caughtUp`)
  //   use `runInBackground`: a lost attempt is re-derived by ANY later
  //   delivery over the same reduced state, so nothing needs to hold the cursor.
  processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    const { event, state, blockProcessorWhile, append } = args;

    switch (event?.type) {
      case "events.iterate.com/agents/web-message-sent": {
        // Mirror the visible chat message into assistant history so the model
        // SEES what it sent on later turns (files ride along for vision).
        // Assistant role, deliberately: this quotes assistant-authored text,
        // and model output must never acquire developer/system instruction
        // precedence merely by passing through sendMessage. Blocked: a
        // per-event consequence — the event is delivered once, and losing the
        // mirror would silently drop the agent's own words from its memory.
        //
        // EXCEPT extracted prose (llmRequestOffset set): a userland response
        // interpreter delivering text lifted from an assistant output whose
        // raw form is ALREADY in history — mirroring would make the model
        // read its own words twice.
        if (event.payload.llmRequestOffset !== undefined) break;
        const files = event.payload.files;
        blockProcessorWhile(() =>
          appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                role: "assistant",
                content: `The assistant sent this visible web-chat message: ${event.payload.message}`,
                ...(files === undefined || files.length === 0 ? {} : { files }),
              },
              idempotencyKey: this.#host.idempotencyKey(`render-web-response@${event.offset}`),
            },
          ]),
        );
        break;
      }
      case "events.iterate.com/agents/context-added": {
        const payload = event.payload;
        // WAITING CLEAR — a qualifying wake retires an agent-authored
        // "waiting for input" summary. Registered BEFORE the interrupt's
        // early return: the interrupting message is itself a wake. The
        // conditional-clear payload carries the waking offset, so the reduce
        // only clears a wait established at or before it (a wait the agent
        // set AFTER this input raced in survives). Blocked: per-event
        // consequence, delivered once.
        if (state.summary.waitingFor !== undefined && contextClearsWaitingFor(payload)) {
          blockProcessorWhile(() =>
            appendUnlessLostIdempotencyRace(append, [
              {
                type: "events.iterate.com/agent/summary-updated",
                payload: { waitingFor: null, clearWaitingForThroughOffset: event.offset },
                idempotencyKey: this.#host.idempotencyKey(`waiting-clear@${event.offset}`),
              },
            ]),
          );
        }
        // A user message that resolves to a slash command belongs to the
        // codemode component (it runs as a script), and it is a side-band
        // action, not conversation: it must neither cancel an in-flight turn
        // nor schedule one — the SAME pure resolver gates it here, in the
        // codemode component, and in the fold's contextTriggerSource, so the
        // three can never disagree.
        if (payload.role === "user" && resolveSlashCommand(payload.content) !== null) break;
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
          const partialText = this.#llm.abortInFlight(open.requestedAtOffset);
          const appends: EmittedInput<AgentProcessorContract>[] = [];
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
              idempotencyKey: this.#host.idempotencyKey(
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
            idempotencyKey: this.#host.idempotencyKey(`settle/${open.requestedAtOffset}`),
          });
          // Block: this is a per-event consequence of THE interrupting
          // message. If the cancel append were a droppable attempt, a crash
          // after the cursor passed this event would leave the open request
          // uncancelled — and the next at-head pass would ADOPT and run the
          // very request the user tried to stop.
          blockProcessorWhile(() => appendUnlessLostIdempotencyRace(append, appends));
          // STOP: the at-head code below must not act this frame. It would
          // otherwise re-run the very request the queued settlement is about
          // to cancel (it reads the pre-cancel reduced state — the eviction-window
          // interrupt case, where nothing here is executing the request). The
          // settlement's own delivery re-runs everything over the settled
          // reduce, where the interrupting input's trigger drives the next turn.
          return;
        }
        break;
      }
      case "events.iterate.com/stream/error-occurred": {
        // EVERY error on the stream — the LLM component's own failures, the
        // sender's repeatedly failing events that were skipped, anything else — is transcribed into
        // model-visible context, without itself triggering a turn (retries
        // are the reduce's job). The integration actor demotes the error text
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
            idempotencyKey: this.#host.idempotencyKey(`transcribe-error@${event.offset}`),
          }),
        );
        break;
      }
    }

    this.#atHead(args);
  }

  // ---------------------------------------- state-derived side effects
  // Plain code over reduced state, after every delivery. Act only at head —
  // behind it the reduction is partial and outcomes may sit in stream pages not
  // yet replayed. Everything here is re-derived by any later delivery, so
  // every append is a droppable background attempt.
  #atHead(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    const { state, runInBackground, append, delivery } = args;
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null) return;

    // Paused: NEW turns stay parked until fresh EXTERNAL input records the
    // resume (self-driven triggers are exactly what the breaker paused).
    // Pause suppresses only the SCHEDULING branch below — an already-open
    // request is a recorded obligation the adopt/expire branch still has to
    // settle. The breaker itself only ever pauses when nothing is open, but
    // `agent/paused` is operator/script-appendable while a request is open;
    // returning here would strand that request forever after an eviction (a
    // fresh incarnation, not executing it, could neither run nor expire it
    // until external input happened to resume the loop). A live incarnation
    // already drains such a request — the background attempt keeps running
    // through the pause — so a revived one must adopt it the same way.
    if (state.paused !== null && state.pendingLlmRequestTrigger?.source === "external") {
      const trigger = state.pendingLlmRequestTrigger;
      runInBackground(() =>
        append({
          type: "events.iterate.com/agent/resumed",
          payload: { reason: "external input" },
          idempotencyKey: this.#host.idempotencyKey(`resume/${trigger.offset}`),
        }),
      );
    }

    // A trigger is pending and nothing is open → record the intent (or trip
    // the breaker), and STOP. Suppressed while paused. The LLM call does not
    // start here: the requested event comes back through our own subscription
    // carrying the offset the stream gave it, and the adopt branch below —
    // the ONE place work ever starts — picks it up. Starting fresh and
    // recovering after an eviction are the same code path.
    const trigger = state.pendingLlmRequestTrigger;
    if (state.paused === null && trigger !== null && state.openRequest === null) {
      // Agent birth and inbound input are independent distributed reactions.
      // Hold the trigger until the canonical system-prompt slot has arrived;
      // that context event's own delivery re-runs this pass over the same
      // pending trigger, so early user input cannot race an unconfigured
      // first turn.
      if (
        !state.contextItems.some(
          (item) => item.payload.role === "system" && item.payload.key === "agent/system-prompt",
        )
      ) {
        console.warn("[agent] holding llm trigger until canonical system prompt arrives", {
          pendingTriggerOffset: trigger.offset,
        });
        return;
      }
      const { maxAutonomousTurns } = state.config;
      if (trigger.source === "agent-loop" && state.autonomousTurnCount >= maxAutonomousTurns) {
        runInBackground(() =>
          append({
            type: "events.iterate.com/agent/paused",
            payload: {
              reason: `autonomous turn limit reached (${maxAutonomousTurns} consecutive turns without external input)`,
              triggerOffset: trigger.offset,
            },
            idempotencyKey: this.#host.idempotencyKey(`pause/${trigger.offset}`),
          }),
        );
        return;
      }
      // Debounce = wait for more content, plus failure backoff — one window,
      // anchored at the trigger. The delayed append IS the intent (no wake
      // event): if the trigger moves or an interrupt clears it before the
      // sleep ends, the requested event's reduce-guard turns the late intent
      // into a harmless stream fact. A droppable attempt: dying mid-window
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
      const windowClosesInMs = trigger.atMs + windowMs - this.#host.now();
      const intent: EmittedInput<AgentProcessorContract> = {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          model: state.config.llm.model,
          expiresAt: trigger.atMs + state.config.llmRequestExpiryMs,
        },
        // Dedupe fence only, keyed on the trigger's coordinates — the
        // request's IDENTITY is the offset the stream assigns on commit.
        idempotencyKey: this.#host.idempotencyKey(`request/${trigger.offset}`),
      };
      runInBackground(async () => {
        if (windowClosesInMs > 0) await this.#host.sleep(windowClosesInMs);
        await appendUnlessLostIdempotencyRace(append, [intent]);
      });
      return;
    }

    // An open request nobody HERE is executing → run it. First time through,
    // that is the normal start (our own requested event arriving at head);
    // after an eviction it is the recovery (the revived fact arriving at
    // head). Runs even while paused: a committed request is drained, never
    // stranded (see the paused branch above). Expired → settle it instead,
    // with the error transcribed for the next turn: answering a stale trigger
    // with a stale context snapshot is worse than admitting the miss. The
    // expiry settle is UNCONDITIONAL past the horizon — even against this
    // incarnation's own in-flight slot: a wedged attempt (a hung await the
    // transport deadline doesn't cover) would otherwise hold isExecuting
    // forever, and with steady unrelated deliveries keeping the DO alive no
    // eviction ever breaks the tie (the 2026-08-13 prd incident). Adoption
    // (nobody here executing) settles early, at the MIN_LLM_ATTEMPT_VALIDITY_MS
    // floor: a late revival adopting a request with seconds left computes a
    // near-zero transport deadline — prod 2026-08-11 saw a 9-second attempt
    // "time out" and burn its retries. A live attempt keeps the full horizon;
    // it may still finish.
    const open = state.openRequest;
    if (open !== null) {
      const executing = this.#llm.isExecuting(open.requestedAtOffset);
      const validityFloorMs = executing ? 0 : MIN_LLM_ATTEMPT_VALIDITY_MS;
      if (this.#host.now() + validityFloorMs >= open.expiresAt) {
        this.#llm.abandonExpired(open.requestedAtOffset);
        runInBackground(() =>
          appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agent/llm-request-settled",
              payload: {
                requestOffset: open.requestedAtOffset,
                result: { status: "cancelled", reason: "expired" },
              },
              idempotencyKey: this.#host.idempotencyKey(`settle/${open.requestedAtOffset}`),
            },
            {
              type: "events.iterate.com/stream/error-occurred",
              payload: {
                message: `LLM request @${open.requestedAtOffset} expired before it ran; the pending turn was dropped. A new message starts fresh.`,
              },
              idempotencyKey: this.#host.idempotencyKey(`expiry-error/${open.requestedAtOffset}`),
            },
          ]),
        );
      } else if (!executing) {
        this.#llm.run(args, open);
      }
    }
  }
}

/**
 * The floor under an attempt's transport deadline: adopting a request with
 * less remaining validity than this settles it expired rather than running a
 * doomed attempt (`deadlineMs = expiresAt - now` self-caps at the intent's
 * validity — see agent-llm-request.ts). Small next to the default 10-minute
 * horizon, so ordinary starts (debounce is seconds) never come near it.
 */
const MIN_LLM_ATTEMPT_VALIDITY_MS = 30_000;

/** Exponential failure backoff reduced into the debounce window: doubling from
 * the policy's base, capped at its ceiling. */
function retryBackoffMs(
  state: Pick<AgentProcessorState, "consecutiveLlmFailures" | "config">,
): number {
  const { backoffBaseMs, backoffMaxMs } = state.config.llmRequestRetryPolicy;
  if (state.consecutiveLlmFailures <= 0) return 0;
  return Math.min(2 ** (state.consecutiveLlmFailures - 1) * backoffBaseMs, backoffMaxMs);
}
