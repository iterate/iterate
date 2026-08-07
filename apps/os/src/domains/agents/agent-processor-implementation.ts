import { isIdempotencyConflict, StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs, StreamEvent } from "iterate/processors";
import { inferJsonType } from "../../lib/infer-json-type.ts";
import { previewJson } from "../../lib/truncate-json.ts";
import { INLINE_RESULT_PREAMBLE_LIMIT } from "../capability-host/capability-host-preamble.ts";
import {
  AgentProcessorContract,
  type AgentFileAttachment,
  type AgentProcessorState,
} from "./agent-processor-contract.ts";
import {
  AGENT_COMPACTION_PROMPT,
  buildAgentLlmRequestBody,
  contextClearsWaitingFor,
  flattenMessageToText,
  reduceAgentEvent,
  type AgentChatMessage,
} from "./agent-prompt-fold.ts";
import {
  buildSlashCommandCode,
  resolveSlashCommand,
  SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX,
  SLASH_COMMAND_EXECUTION_PREFIX,
} from "./slash-commands.ts";
import {
  extractChunkText,
  jsonCompatible,
  normalizeLlmUsage,
  runWorkersAiAttempt,
  type CloudflareAiGatewayTransport,
  type WorkersAiBinding,
  type WorkersAiMessage,
} from "./workers-ai-transport.ts";

/**
 * The agent processor. Design: tasks/simplify-stream-processor-contract.md;
 * in-place replacement of the previous processor:
 * tasks/agent-processor-replacement.md.
 *
 * HOW IT WORKS, end to end:
 *
 * Context events arrive on the agent's stream (`agents/context-added`: user
 * messages, developer notes, script results, assistant output). The pure
 * `reduce` projects them into `state.contextItems` — ONE ordered list;
 * system items sit in place — and records the newest turn-worthy one as
 * `state.pendingLlmRequestTrigger`. When `processEvent` runs at the head of
 * the stream with a trigger pending, no request open, and the canonical
 * system prompt present (the keyed "agent/system-prompt" slot — agent birth
 * and inbound input are independent distributed reactions, so early input
 * waits for configuration), it waits out a short debounce window (plus
 * failure backoff) and then records the INTENT to run one turn: an
 * `agent/llm-request-requested` event. That event's own stream offset IS the
 * request's identity — there are no synthetic ids anywhere; every related
 * idempotency key derives from an offset.
 *
 * The requested event comes back through the processor's own subscription;
 * the reducer opens `state.openRequest`, and the at-head pass finds an open
 * request this incarnation is not executing and starts the LLM call — the
 * ONE place work ever starts. The prompt is a pure reduction of committed
 * history up to the request's offset (`buildAgentLlmRequestBody`), so every
 * retry of the same request sees the same conversation, and the UI's request
 * inspector (lib/llm-request-replay.ts) replays the exact wire messages from
 * mirrored events. The call travels through the Workers AI transport
 * (unified billing or the BYOK gateway lane — workers-ai-transport.ts);
 * streamed chunks are emitted as forcibly-ephemeral `llm-response-chunk`
 * events carrying the provider's raw chunk objects. Because the intent lives
 * in the stream and not in a closure, recovery is the same code path: after
 * an eviction the platform appends `stream/processor-revived`, whose wake
 * produces an eventless at-head pass; the fresh incarnation sees the open
 * request and adopts it — same offset, same idempotency keys, so a zombie
 * incarnation racing the successor collapses to one stream story on the
 * shared `settle/<offset>` key.
 *
 * Success lands as ONE atomic append: the assistant context item, the
 * `agent/llm-request-settled` fact, and (when the vendor reported parseable
 * usage) the normalized `agent/token-usage-reported` event — same
 * information, one commit. Failures settle with an accompanying
 * `stream/error-occurred` event; the reduce schedules the retry (backoff and
 * caps are plain state arithmetic), and EVERY error-occurred event on the
 * stream — from this processor or anything else — is transcribed into
 * model-visible context so the next turn can see it. Cancellation is a
 * property of new input (`llmRequestPolicy: interrupt-current-request`),
 * never a free-standing command: the interrupt aborts the in-flight call,
 * settles the request cancelled with the streamed partial text, and the
 * interrupting message's own trigger drives the next turn.
 *
 * The codemode loop: an accepted assistant output may carry ONE fenced
 * TypeScript script, which is extracted and handed to the capability host
 * (`script-run-requested`, executionId `agent-output:<offset>`). Responses
 * with several blocks, or a fenced block that is not a single leading-`async`
 * function, are rejected wholesale with corrective feedback — executing the
 * first block and silently dropping the rest is the worst option, because
 * the model believes everything it wrote will run. The host's settlement
 * renders back as developer context (truncated at
 * `config.scriptResultHistoryLimit`; the full text of an oversized result
 * spills into the agent's own workspace directory under script-results/ when
 * the host can write files there). The agent also mirrors its own visible web-chat
 * messages (`agents/web-message-sent`) into assistant history so the model
 * sees what it sent, and clears an agent-authored "waiting for input"
 * summary when a qualifying wake arrives (the conditional clear only clears
 * a wait established at or before the waking input's offset).
 *
 * Compaction: every successful turn's `token-usage-reported` says how full
 * the context ran. Past `config.compactionTriggerFraction` of the model's
 * window, the processor stops the world, replays the exact request whose
 * usage crossed the threshold, asks the model to summarize that prefix, and
 * appends ONE developer context item with
 * `compaction.replacesHistoryThrough`. Its reduce arm seals coverage through
 * the barrier, drops every non-system item at or below it, and collapses
 * keyed system occurrences to their latest — the summary becomes the whole
 * memory of everything before the barrier.
 *
 * At most ONE LLM request is ever open: `state.openRequest` is a single slot
 * and the requested-event reduce-guard drops intents while it is set.
 * Concurrency belongs to subagents (separate streams), not to parallel turns
 * over one reduced conversation. Runaway self-driven chains hit the
 * `maxAutonomousTurns` breaker, which records `agent/paused` (mirroring
 * stream/paused); the next external message records `agent/resumed`.
 *
 * All tuning (model, debounce, expiry, retry policy, breaker threshold,
 * script truncation, compaction trigger) lives in `state.config` with schema
 * defaults; `agent/configured` merges partial patches.
 */
export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;

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
  //   delivery over the same reduced state, so nothing needs to hold the cursor.
  protected override processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    const { event, previousState, state, blockProcessorWhile, runInBackground, append, delivery } =
      args;

    switch (event?.type) {
      case "events.iterate.com/agents/web-message-sent": {
        // Mirror the visible chat message into assistant history so the model
        // SEES what it sent on later turns (files ride along for vision).
        // Assistant role, deliberately: this quotes assistant-authored text,
        // and model output must never acquire developer/system instruction
        // precedence merely by passing through sendMessage. Blocked: a
        // per-event consequence — the event is delivered once, and losing the
        // mirror would silently drop the agent's own words from its memory.
        const files = event.payload.files;
        blockProcessorWhile(() =>
          this.#appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                role: "assistant",
                content: `The assistant sent this visible web-chat message: ${event.payload.message}`,
                ...(files === undefined || files.length === 0 ? {} : { files }),
              },
              idempotencyKey: this.idempotencyKey(`render-web-response@${event.offset}`),
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
            this.#appendUnlessLostIdempotencyRace(append, [
              {
                type: "events.iterate.com/agent/summary-updated",
                payload: { waitingFor: null, clearWaitingForThroughOffset: event.offset },
                idempotencyKey: this.idempotencyKey(`waiting-clear@${event.offset}`),
              },
            ]),
          );
        }
        // SLASH COMMANDS — a user message that resolves to a known command
        // runs as a codemode script with this agent's provenance instead of
        // triggering an LLM turn (contextTriggerSource skips it via the SAME
        // pure resolver, so processor and reduce can never disagree). Checked
        // BEFORE the interrupt: a command is a side-band action, not
        // conversation — it must neither cancel an in-flight turn nor be
        // swallowed by the interrupt path's early return. Blocked per-event
        // consequence with the assistant-script path's discipline:
        // deterministic body (expiry anchored to the event, never `now`) so
        // an at-least-once redelivery dedupes on the key, race-tolerant for
        // a config change between deliveries. Non-resolving "/..." text falls
        // through to the model untouched.
        if (payload.role === "user") {
          const slashCommand = resolveSlashCommand(payload.content);
          if (slashCommand !== null) {
            const executionId = `${SLASH_COMMAND_EXECUTION_PREFIX}${slashCommand.command}:${event.offset}`;
            blockProcessorWhile(() =>
              this.#appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/capability-host/script-run-requested",
                  payload: {
                    code: buildSlashCommandCode(slashCommand, executionId),
                    executionId,
                    expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
                  },
                  idempotencyKey: this.idempotencyKey(`slash-command@${event.offset}`),
                },
              ]),
            );
            break;
          }
        }
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
          // to cancel (it reads the pre-cancel reduced state — the eviction-window
          // interrupt case, where nothing here is executing the request). The
          // settlement's own delivery re-runs everything over the settled
          // reduce, where the interrupting input's trigger drives the next turn.
          return;
        }
        // RESPONSE PARSING — an accepted assistant output may carry ONE
        // codemode script; extraction rides the same delivery that reduced the
        // text. Only output linked to THE open request is executable: a
        // caller may raw-append assistant-role history, and may even supply a
        // numeric llmRequestOffset, without thereby gaining a path to
        // capability execution. Blocked for the same per-event reason as
        // above: this event is delivered once, and both the script request
        // and the corrective feedback would be lost forever with it.
        if (
          payload.role === "assistant" &&
          payload.llmRequestOffset !== undefined &&
          payload.llmRequestOffset === state.openRequest?.requestedAtOffset
        ) {
          const extraction = extractAsyncTypescriptSnippet(payload.content);
          if (extraction.kind === "malformed") {
            blockProcessorWhile(() =>
              this.#appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/agents/context-added",
                  payload: {
                    role: "developer",
                    content:
                      "Your code block did NOT run. Use a ```ts fence whose content STARTS with `async` — a single `async (itx) => { ... }`, TypeScript only, no comments or statements before the function. Resend it as one such block (move any leading comments inside the function body).",
                    llmRequestPolicy: { behaviour: "after-current-request" },
                  },
                  idempotencyKey: this.idempotencyKey(`malformed-snippet-rejected@${event.offset}`),
                },
              ]),
            );
          } else if (extraction.kind === "multiple") {
            blockProcessorWhile(() =>
              this.#appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/agents/context-added",
                  payload: {
                    role: "developer",
                    content: `Your response contained ${extraction.count} fenced code blocks, so NOTHING was executed. Respond with exactly ONE fenced code block per turn. Do not queue future steps as extra blocks — your script's return value arrives as your next input and you write the next step then. Resend just the FIRST step as a single \`\`\`ts block.`,
                    llmRequestPolicy: { behaviour: "after-current-request" },
                  },
                  idempotencyKey: this.idempotencyKey(`multi-snippet-rejected@${event.offset}`),
                },
              ]),
            );
          } else if (extraction.kind === "script") {
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
                    code: extraction.code,
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
      case "events.iterate.com/capability-host/preamble-set":
      case "events.iterate.com/capability-host/preamble-removed": {
        // Preamble changes on this agent's scope transcribe into developer
        // context — the model can only use symbols it knows exist. Never a
        // turn trigger: when the agent's own script set the entry, the
        // script's settlement drives the next turn; an external set is
        // configuration, not conversation. Blocked: per-event consequence,
        // delivered once.
        const isSet = event.type === "events.iterate.com/capability-host/preamble-set";
        const content = isSet
          ? `Preamble entry ${JSON.stringify(event.payload.key)} was set. This TypeScript is now injected above your scripts — its symbols are in scope:\n\`\`\`ts\n${event.payload.code}\n\`\`\``
          : `Preamble entry ${JSON.stringify(event.payload.key)} was removed; its symbols are no longer available to your scripts.`;
        blockProcessorWhile(() =>
          this.#appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                role: "developer",
                content,
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
              },
              idempotencyKey: this.idempotencyKey(`render-preamble-change@${event.offset}`),
            },
          ]),
        );
        break;
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        const { executionId, settlement } = event.payload;
        // Settlement reduction removes the execution from `state`, so inspect
        // the immediately preceding projection. Only a request provenance-
        // stamped by this agent processor can enter that active set.
        if (!previousState.activeScriptExecutionIds.includes(executionId)) break;
        // `/script` publishes its successful result directly as interruptive
        // context, then returns the same value so the capability host keeps it
        // in the script-results preamble. Only its failures render here.
        if (
          executionId.startsWith(SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX) &&
          settlement.status === "succeeded"
        ) {
          break;
        }
        // Per-event render (blocked): the settlement is delivered once, and a
        // lost render would silently drop the script's result from the
        // conversation. Rendering may first spill an oversized result into
        // the agent's workspace (a durable write that can wait on the
        // checkout's first-use clone), so the whole render-then-append runs
        // inside the blocking section — the input must not land before the
        // file it references. Race-tolerant: a truncation-limit config change
        // between redeliveries alters the rendered body under the same key.
        blockProcessorWhile(async () => {
          const content = await renderScriptSettlement({
            executionId,
            settlement,
            historyLimit: state.config.scriptResultHistoryLimit,
            writeWorkspaceFile: this.deps.writeWorkspaceFile,
          });
          if (content === null) return;
          await this.#appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                role: "developer",
                content,
                actor: { type: "script", executionId },
                llmRequestPolicy: { behaviour: "after-current-request" },
              },
              idempotencyKey: this.idempotencyKey(`render-script-result@${event.offset}`),
            },
          ]);
        });
        break;
      }
      case "events.iterate.com/stream/error-occurred": {
        // EVERY error on the stream — this processor's own LLM failures, the
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
            idempotencyKey: this.idempotencyKey(`transcribe-error@${event.offset}`),
          }),
        );
        break;
      }
      case "events.iterate.com/agent/token-usage-reported": {
        // COMPACTION TRIGGER: the report says how full this turn's context
        // ran. Past the configured fraction of the model's window, STOP THE
        // WORLD and summarize the history prefix into one context item —
        // blocked (per-event: the report is delivered once, and the summary
        // must land before later context piles onto an already-too-big
        // prompt). Blocking work is FIFO per event and settles before the
        // next event reduces, so compactions run one at a time. The stream
        // probe below lets a newer committed report supersede this one.
        const usage = event.payload;
        const contextTokens = usage.inputTokens + usage.outputTokens;
        const thresholdTokens = Math.floor(
          usage.maxContextTokens * state.config.compactionTriggerFraction,
        );
        if (contextTokens < thresholdTokens) break;
        const triggerFraction = state.config.compactionTriggerFraction;
        const hasHistory = state.contextItems.some((item) => item.payload.role !== "system");
        blockProcessorWhile(async () => {
          // A later over-threshold report already in the stream supersedes
          // this one: summarizing an older prefix now would be thrown away by
          // the newer request's compaction, so defer to it.
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
        break;
      }
      // created / configured / requested / settled / paused / resumed /
      // summary-updated / script-run-requested / revived: no per-event
      // effect — they matter through the reduce below.
    }

    // ---------------------------------------- state-derived side effects
    // Plain code over reduced state, after every delivery. Act only at head —
    // behind it the reduction is partial and outcomes may sit in stream pages not
    // yet replayed. Everything here is re-derived by any later delivery, so
    // every append is a droppable background attempt.
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
          idempotencyKey: this.idempotencyKey(`resume/${trigger.offset}`),
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
            idempotencyKey: this.idempotencyKey(`pause/${trigger.offset}`),
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
      const windowClosesInMs = trigger.atMs + windowMs - this.#now();
      const intent: EmittedInput<AgentProcessorContract> = {
        type: "events.iterate.com/agent/llm-request-requested",
        payload: {
          model: state.config.llm.model,
          expiresAt: trigger.atMs + state.config.llmRequestExpiryMs,
        },
        // Dedupe fence only, keyed on the trigger's coordinates — the
        // request's IDENTITY is the offset the stream assigns on commit.
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
    // head). Runs even while paused: a committed request is drained, never
    // stranded (see the paused branch above). Expired → settle it instead,
    // with the error transcribed for the next turn: answering a stale trigger
    // with a stale context snapshot is worse than admitting the miss.
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
   * Execute the LLM call for a recorded intent — background work: it can run
   * for minutes, and the stream (not this closure) is what survives an
   * eviction. The prompt is rebuilt from committed history pinned to the
   * request's offset, so an adopting incarnation reproduces the covered
   * context exactly. Success lands as ONE atomic append: the assistant
   * context item, the settlement, and the normalized token-usage report, all
   * idempotency-keyed on the request's offset, so a zombie racing a fresh
   * incarnation collapses to one stream story.
   */
  #runLlmRequest(
    args: ProcessEventArgs<AgentProcessorContract>,
    open: NonNullable<AgentProcessorState["openRequest"]>,
  ) {
    const requestOffset = open.requestedAtOffset;
    const inFlight = { requestOffset, controller: new AbortController(), partialText: "" };
    this.#inFlightLlmCall = inFlight;
    const startedAtMs = this.#now();
    let chunkSequence = 0;
    args.runInBackground(async () => {
      try {
        const events = await this.#readConsumedEvents();
        const body = buildAgentLlmRequestBody({ events, llmRequestOffset: requestOffset });
        const completion = await this.#attemptLlm({
          model: open.model,
          messages: await prepareAgentLlmMessages(body.messages, this.deps.resolveModelFileUrl),
          signal: inFlight.controller.signal,
          // The attempt can never outlive its intent: dial + stream drain
          // self-cap at whatever validity the request has left.
          deadlineMs: Math.max(1, open.expiresAt - this.#now()),
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
        await this.#appendUnlessLostIdempotencyRace(args.append, [
          {
            type: "events.iterate.com/agents/context-added",
            payload: {
              role: "assistant",
              content: completion.text,
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
                text: completion.text,
                ...(usage === undefined ? {} : { usage }),
                ...(completion.rawResponse === undefined
                  ? {}
                  : { rawResponse: completion.rawResponse }),
              },
            },
            idempotencyKey: this.idempotencyKey(`settle/${requestOffset}`),
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
                  idempotencyKey: this.idempotencyKey(`token-usage@${requestOffset}`),
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
  async #attemptLlm(input: {
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
    if (this.deps.callLlm !== undefined) {
      return await this.deps.callLlm({
        model: input.model,
        messages: input.messages,
        signal: input.signal,
        onChunk: (text) => input.onChunk(text),
      });
    }
    const ai = this.deps.ai;
    if (ai === undefined) {
      throw new Error("Agent processor has no AI binding configured.");
    }
    const completion = await raceAbort(
      input.signal,
      runWorkersAiAttempt({
        ai,
        transport: this.deps.cloudflareAiGatewayTransport?.(),
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
      const events = await this.#readConsumedEvents();

      // Same transport seam as normal turns: BYOK carries the per-agent
      // prompt_cache_key, so this request lands on the shard that already
      // holds the conversation's prefix (and the cache discount lands on our
      // bill — the unified lane meters cached tokens at the uncached price).
      // The usage report names the model that saw the exact measured request;
      // a later configuration event may already have selected another model,
      // but switching here would forfeit that cache.
      const summary = await this.#attemptLlm({
        model,
        messages: await prepareAgentLlmMessages(
          buildAgentCompactionRequestBody({ events, llmRequestOffset }).messages,
          this.deps.resolveModelFileUrl,
        ),
        signal: new AbortController().signal,
        deadlineMs,
        onChunk: async () => {},
      });

      await this.append({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: this.idempotencyKey(`compact-context@${triggerOffset}`),
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

  /**
   * The whole stream's consumed subset, paged from offset 0 — the one read
   * behind prompt building and the compaction guards. Filtering to `consumes`
   * keeps bulk emitted-only types (response chunks) out of the transfer;
   * paging (rather than one capped read) means long histories are never
   * silently truncated.
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

  /** Targeted durable guard for compaction redelivery. Long streams are
   * exactly where this runs, so never reread their entire consumed history
   * merely to discover a later summary. */
  async #hasCompactionCovering(offset: number): Promise<boolean> {
    const payloadSchema =
      AgentProcessorContract.events["events.iterate.com/agents/context-added"].payloadSchema;
    using pager = this.stream.readEvents({
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
    using pager = this.stream.readEvents({
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

  /**
   * Append a batch whose idempotency keys may race concurrent writers: every
   * writer of `settle/<offset>` (success, failure, interrupt, expiry) races
   * every other, and two debounce schedulings of one trigger race on
   * `request/<offset>` when config changed between them. The stream rejects
   * a same-key append with a different body; the FIRST writer's story stands
   * and losing the race is success — the obligation is settled/recorded, and
   * the reduce sorts out whose fact counts.
   */
  async #appendUnlessLostIdempotencyRace(
    append: ProcessEventArgs<AgentProcessorContract>["append"],
    events: EmittedInput<AgentProcessorContract>[],
  ): Promise<void> {
    try {
      await append(...events);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure reduce. The one switch lives in the module-level `reduceAgentEvent`
  // below (not inline here) because two OFF-RUNTIME readers run the exact
  // same projection over raw stream events: prompt building (the request is
  // a pure re-reduction pinned to the requested offset) and the UI's request
  // inspector (lib/llm-request-replay.ts replays the wire messages from
  // mirrored events via `reduceAgentEvents`).
  protected override reduce({ event, state }: ReduceArgs<AgentProcessorContract>) {
    return reduceAgentEvent({ event, state });
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

/** The test/custom-host LLM seam: when provided it REPLACES the Workers AI
 * path entirely, so suites drive turns with a scripted transport and the
 * processor never knows. `onChunk` receives text deltas. Usage comes back
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
 * Host-provided deps beyond the stream plumbing.
 *
 * - `ai` is the Workers AI binding (`env.AI`) used for every LLM turn.
 *   Optional so a host without one fails requests with a recorded error
 *   instead of crashing at construction.
 * - `cloudflareAiGatewayTransport` resolves how attempts travel through the
 *   gateway (unified billing vs the BYOK lane — see
 *   CloudflareAiGatewayTransport). A function, not a value: it reads
 *   deployment config and the host's secrets, and a bad config must fail the
 *   ATTEMPT (recorded, retried) rather than DO construction.
 * - `resolveModelFileUrl` remints a short-lived, immutable URL for a project
 *   file immediately before a model request. Production hosts provide it;
 *   bare tests without it retain the stored attachment URL.
 * - `writeWorkspaceFile` writes one file into THIS agent's own workspace
 *   directory (the filesystem `itx.workspace` resolves to; the given path is
 *   relative to that directory) so oversized script results can spill to a
 *   file the model pages through with plain TypeScript. Returns the
 *   fully-qualified workspace path it wrote. Optional: without it, oversized
 *   results fall back to inline truncation.
 * - `callLlm` overrides the whole Workers AI path when provided — the test
 *   seam (see AgentLlmTransport).
 * - `now`/`sleep`: injectable clock — virtual time in tests, real time in
 *   production.
 */
export type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  cloudflareAiGatewayTransport?: () => CloudflareAiGatewayTransport;
  resolveModelFileUrl?: (file: AgentFileAttachment) => Promise<string>;
  writeWorkspaceFile?: (input: {
    content: string;
    path: string;
  }) => Promise<{ absolutePath: string }>;
  callLlm?: AgentLlmTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Page size for full-stream reads (prompt building, compaction guards). */
const CONSUMED_EVENTS_PAGE_SIZE = 500;

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

/** Exponential failure backoff reduced into the debounce window: doubling from
 * the policy's base, capped at its ceiling. */
function retryBackoffMs(
  state: Pick<AgentProcessorState, "consecutiveLlmFailures" | "config">,
): number {
  const { backoffBaseMs, backoffMaxMs } = state.config.llmRequestRetryPolicy;
  if (state.consecutiveLlmFailures <= 0) return 0;
  return Math.min(2 ** (state.consecutiveLlmFailures - 1) * backoffBaseMs, backoffMaxMs);
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

// -----------------------------------------------------------------------------
// Codemode: scripts out of outputs, script results back into inputs.
// -----------------------------------------------------------------------------

const FENCED_SNIPPET_RE = /^[ \t]*```(?:ts|typescript)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/im;
const ANY_FENCED_BLOCK_RE = /^[ \t]*```[^\n]*\n[\s\S]*?\n[ \t]*```[ \t]*$/gim;

type SnippetExtraction =
  | { kind: "script"; code: string }
  // The model queued several scripts in one response (planning ahead).
  // Executing only the first and dropping the rest silently is the worst
  // option — the model believes everything it wrote will run — so the caller
  // rejects the whole output with corrective feedback instead.
  | { kind: "multiple"; count: number }
  // A fenced block exists but nothing runnable came out of it: leading
  // comments or statements before the arrow function, or a non-TypeScript
  // language tag the extraction regex refuses. Nothing can run; the caller
  // sends corrective feedback (models habitually open code with a comment
  // line, and silence here reads as the platform hanging).
  | { kind: "malformed" }
  | { kind: "none" };

function extractAsyncTypescriptSnippet(content: string): SnippetExtraction {
  // Fences count only at line starts: scripts legitimately carry ``` inside
  // string literals (chat messages formatted as markdown), and in valid
  // TypeScript those always sit mid-line — a raw newline cannot appear in a
  // string literal, and an unescaped ``` would terminate a template literal.
  // A fence match anywhere used to cut the script at the first embedded ```
  // and execute an unparseable prefix (unclosed string literal). Count every
  // fenced block before validating its language tag: a mixed response (one
  // runnable TypeScript block plus another fenced block) must reject the
  // whole output instead of executing the first and silently dropping the
  // rest.
  const blocks = content.match(ANY_FENCED_BLOCK_RE) ?? [];
  if (blocks.length > 1) return { kind: "multiple", count: blocks.length };
  const fenced = content.match(FENCED_SNIPPET_RE);
  const code = (fenced?.[1] ?? content).trim();
  if (/^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code)) {
    return { kind: "script", code };
  }
  // Any response carrying a line-start fence that did not yield a runnable
  // script is a malformed attempt — including fences with a non-TypeScript
  // language tag, which FENCED_SNIPPET_RE refuses to match. Only a fence-free
  // non-script response is a deliberate no-op turn; the system prompt
  // promises rejection-with-feedback for everything else.
  return fenced !== null || /^[ \t]*```/m.test(content) ? { kind: "malformed" } : { kind: "none" };
}

// The "tool result" half of the codemode loop: a finished script execution
// renders back into model-visible history so the next turn can look at the
// data. Two deliberate gaps end the loop instead of feeding it:
// - executions this agent did not request stay invisible (other scripts —
//   e.g. Slack bang commands — record on the same stream; the caller
//   filters by the `agent-output:` prefix before ever calling this);
// - a script that returned undefined and did not throw produces nothing.
//   Returning no value is how an agent ends its turn.
async function renderScriptSettlement(input: {
  executionId: string;
  settlement: {
    status: "succeeded" | "failed";
    result?: unknown;
    error?: string;
    phase?: string;
    failureKind?: string;
    executionMayHaveOccurred?: boolean;
  };
  historyLimit: number;
  writeWorkspaceFile: AgentProcessorDeps["writeWorkspaceFile"];
}): Promise<string | null> {
  const { executionId, settlement, historyLimit, writeWorkspaceFile } = input;
  if (settlement.status === "failed") {
    // Advertise the recovery tools at the moment of failure — a wrong call
    // is exactly when docs.typecheck's did-you-mean and docs.search's
    // working examples pay off, and nothing else tells the model they exist.
    const executionNote = settlement.executionMayHaveOccurred
      ? "The script may have partially executed; inspect state before retrying."
      : "The script did not execute.";
    return (
      `Your script failed during ${settlement.phase} (${settlement.failureKind}):\n` +
      `\`\`\`\n${truncateScriptResult(settlement.error ?? "unknown error", historyLimit)}\n\`\`\`\n${executionNote}\n` +
      `Before retrying: \`await itx.docs.typecheck({ code })\` compiles a script against this ` +
      `scope's real types (typos come back as "did you mean …"), and ` +
      `\`await itx.docs.search({ q: "several related words" })\` finds working examples.`
    );
  }
  if (settlement.result === undefined) return null;
  const text = stringifyScriptResult(settlement.result);
  // The preamble binding this exact result got: the SAME compact-JSON split
  // the capability host applies when deriving the `results` array. NOT the
  // spill decision below — that keys on pretty-printed length vs the
  // configured historyLimit, so a result can spill to a file yet still be an
  // inline `data` row (no `.load`); a recipe naming the wrong member fails
  // typecheck in the very next script.
  const resultsAccess =
    JSON.stringify(settlement.result).length <= INLINE_RESULT_PREAMBLE_LIMIT ? "data" : "load";
  const preambleNote =
    resultsAccess === "data"
      ? "\nThis result is available to your next script as `results[0].data` (the preamble `results` array, newest first)."
      : "\nThe full result is available to your next script via `await results[0].load(itx)` (the preamble `results` array, newest first).";
  // String results are raw text, not JSON — the fence label, the spill
  // file's extension, and the read-it-back recipe all say so honestly.
  const isRawText = typeof settlement.result === "string";
  const fence = isRawText ? "```" : "```json";
  if (text.length > historyLimit && writeWorkspaceFile !== undefined) {
    try {
      const spilledPath = await spillScriptResult({
        executionId,
        extension: isRawText ? "txt" : "json",
        text,
        writeWorkspaceFile,
      });
      // Once the full result is safely on disk, the inline copy stops trying
      // to be the data and becomes a map of it: shrink hard (well under
      // historyLimit) and spend the space on shape instead of payload.
      if (isRawText) {
        const shownChars = Math.min(OVERSIZED_RAW_TEXT_PREVIEW_CHARS, historyLimit);
        return [
          "Your script returned:",
          "```",
          text.slice(0, shownChars),
          "```",
          rawTextSpillNotice({
            path: spilledPath,
            resultsAccess,
            shownChars,
            totalChars: text.length,
          }),
        ].join("\n");
      }
      return renderOversizedJsonResult({
        historyLimit,
        path: spilledPath,
        result: settlement.result,
        resultsAccess,
        text,
      });
    } catch (error) {
      // Spilling is best effort: a workspace that cannot clone or write must
      // not lose the result entirely — fall through to inline truncation.
      console.error("[agent] failed to spill oversized script result to workspace", {
        error,
        executionId,
      });
    }
  }
  return `Your script returned:\n${fence}\n${truncateScriptResult(text, historyLimit)}\n\`\`\`${preambleNote}`;
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

function truncateScriptResult(text: string, historyLimit: number): string {
  if (text.length <= historyLimit) return text;
  return `${text.slice(0, historyLimit)}\n… truncated (${text.length} chars total; up to ${historyLimit} render inline — return less: slice arrays, pick fields)`;
}

/**
 * Where oversized script results land, relative to the agent's own workspace
 * directory: private scratch files for the model to page through with
 * itx.workspace, under no mount and therefore never committable. One file per
 * execution, so replays overwrite idempotently. Size is no concern —
 * workspace files past the inline threshold are stored in R2 transparently.
 */
const SCRIPT_RESULT_SPILL_DIR = "script-results";

/** Writes the full result text into the agent's workspace directory; returns
 * the fully-qualified workspace path. */
async function spillScriptResult(input: {
  executionId: string;
  extension: "json" | "txt";
  text: string;
  writeWorkspaceFile: NonNullable<AgentProcessorDeps["writeWorkspaceFile"]>;
}): Promise<string> {
  const path = `${SCRIPT_RESULT_SPILL_DIR}/${input.executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.${input.extension}`;
  const written = await input.writeWorkspaceFile({ content: input.text, path });
  return written.absolutePath;
}

/** Inline budgets for an oversized result once the full copy is spilled: the
 * inferred type and shape-preserving preview replace raw payload — the model
 * reads the spill file when it needs actual data, so keep history lean. */
const OVERSIZED_RAW_TEXT_PREVIEW_CHARS = 10_000;
const OVERSIZED_TYPE_MAX_CHARS = 3_000;
const OVERSIZED_JSON_PREVIEW_MAX_BYTES = 8_000;

/**
 * Oversized JSON result, spilled successfully: render an inferred TypeScript
 * type (the whole shape, cheap) plus an aggressively elided preview (a few
 * items per array, capped strings/depth) plus the read-it-back recipe. Both
 * smart parts degrade independently — a value that defeats inference or
 * previewing still renders the other, or falls back to a plain slice.
 */
function renderOversizedJsonResult(input: {
  historyLimit: number;
  path: string;
  result: unknown;
  /** Which member the preamble `results` row for THIS result actually has —
   * `data` (inline literal) or `load` (typed async loader); the recipe must
   * name the one that exists or the next script fails typecheck. */
  resultsAccess: "data" | "load";
  text: string;
}): string {
  let typeText: string | null = null;
  try {
    typeText = inferJsonType(input.result, {
      maxChars: Math.min(OVERSIZED_TYPE_MAX_CHARS, input.historyLimit),
    });
  } catch (error) {
    console.error("[agent] failed to infer type for oversized script result", { error });
  }
  let previewText: string;
  try {
    const preview = previewJson(input.result, {
      maxArrayItems: 3,
      maxBytes: Math.min(OVERSIZED_JSON_PREVIEW_MAX_BYTES, input.historyLimit),
      maxDepth: 5,
      maxStringChars: 500,
    });
    previewText = JSON.stringify(preview.value, null, 2);
  } catch (error) {
    console.error("[agent] failed to build preview for oversized script result", { error });
    previewText = `${input.text.slice(0, Math.min(OVERSIZED_JSON_PREVIEW_MAX_BYTES, input.historyLimit))}\n… (cut mid-document)`;
  }
  return [
    `Your script returned ${input.text.length.toLocaleString("en-US")} chars of JSON — over the ~${input.historyLimit.toLocaleString("en-US")}-char inline limit.${typeText === null ? "" : " Inferred type:"}`,
    ...(typeText === null ? [] : ["```ts", `type Result = ${typeText}`, "```"]),
    "Preview (long arrays/strings elided):",
    "```json",
    previewText,
    "```",
    "The full result is available to your next script through the preamble `results` array — don't re-fetch:",
    "```ts",
    "async (itx) => {",
    input.resultsAccess === "load"
      ? "  const data = await results[0].load(itx); // newest first; typed — the full result"
      : "  const data = results[0].data; // newest first; the full result, typed by its literal",
    "  // filter/pick with plain TypeScript and return only what you need",
    "}",
    "```",
    `(The full copy is also saved in your workspace at ${JSON.stringify(input.path)} — use itx.workspace to page a slice if that suits better.)`,
  ].join("\n");
}

/**
 * The model-facing text after a truncated raw-text preview: where the full
 * result lives and a concrete next-script recipe for paging it, so the model
 * reads the file with plain TypeScript instead of re-running the expensive
 * fetch.
 */
function rawTextSpillNotice(input: {
  path: string;
  /** See renderOversizedJsonResult: the member this result's preamble row has. */
  resultsAccess: "data" | "load";
  shownChars: number;
  totalChars: number;
}): string {
  // A loader-backed result pages SERVER-SIDE: getScriptResult's slice serves
  // one string page of the stored text, so the script never holds the whole
  // thing. A small inline result is already in the preamble — plain .slice.
  const recipe =
    input.resultsAccess === "load"
      ? [
          "async (itx) => {",
          `  // pages server-side — only the requested chars enter the script`,
          `  const page = await itx.capabilityHost.getScriptResult(results[0].executionId, { slice: [${input.shownChars}, ${input.shownChars * 4}] });`,
          "  return page.data; // page.slicedFrom = { totalChars, start, end } — keep paging from there",
          "}",
        ]
      : [
          "async (itx) => {",
          "  const text = results[0].data; // newest first — the full string",
          `  return text.slice(${input.shownChars}, ${input.shownChars * 4}); // page/regex to return only what you need`,
          "}",
        ];
  const fullStringNote =
    input.resultsAccess === "load"
      ? "(Need the whole string in one script? `await results[0].load(itx)`. The full copy is also saved in your workspace at "
      : "(The full copy is also saved in your workspace at ";
  return [
    `…truncated: showing the first ${input.shownChars.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full text is available to your next script through the preamble \`results\` array — don't re-fetch:`,
    "```ts",
    ...recipe,
    "```",
    `${fullStringNote}${JSON.stringify(input.path)}.)`,
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
