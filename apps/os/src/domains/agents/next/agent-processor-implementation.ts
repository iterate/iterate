// The clean-room agent processor IMPLEMENTATION: one `reduce` switch (the
// pure fold) and one `processEvent` switch whose job is side effects — first
// the per-event ones, then the ones decided by looking at state. The
// framework supplies exactly four things: ordered at-least-once delivery,
// `delivery.caughtUp`, the two side-effect lanes, and revival after eviction.
// Everything else here is user space.
// Design: tasks/simplify-stream-processor-contract.md.

import { StreamProcessor } from "iterate/processors";
import {
  AGENT_CONFIGURED,
  AGENT_CONTEXT_ADDED,
  AGENT_CREATED,
  AGENT_LLM_REQUEST_DEBOUNCE_MS,
  AGENT_LLM_REQUEST_EXPIRY_MS,
  AGENT_LLM_REQUEST_REQUESTED,
  AGENT_LLM_REQUEST_SETTLED,
  AGENT_LLM_RESPONSE_CHUNK,
  AGENT_LLM_RETRY_BACKOFF_BASE_MS,
  AGENT_LLM_RETRY_BACKOFF_MAX_MS,
  AGENT_LOOP_STOPPED,
  AGENT_SCRIPT_EXECUTION_ID_PREFIX,
  AgentNextProcessorContract,
  MAX_AUTONOMOUS_TURNS,
  MAX_CONSECUTIVE_LLM_FAILURES,
  MAX_CONSECUTIVE_RATE_LIMITED_LLM_FAILURES,
  SCRIPT_RESULT_HISTORY_LIMIT,
  SCRIPT_RUN_REQUESTED,
  SCRIPT_RUN_SETTLED,
  type AgentNextContextAddedPayload,
  type AgentNextState,
  type LlmRequestUsage,
} from "./agent-processor-contract.ts";

// Type carrier for the protected hook arg shapes (the one sanctioned spelling;
// protected members are only indexable from inside a subclass body).
abstract class HookArgCarrier extends StreamProcessor<AgentNextProcessorContract> {
  declare readonly processArgsCarrier: Parameters<
    StreamProcessor<AgentNextProcessorContract>["processEvent"]
  >[0];
  declare readonly reduceArgsCarrier: Parameters<
    StreamProcessor<AgentNextProcessorContract>["reduce"]
  >[0];
}
type ProcessArgs = HookArgCarrier["processArgsCarrier"];
type ReduceArgs = HookArgCarrier["reduceArgsCarrier"];

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
}) => Promise<{ text: string; usage?: LlmRequestUsage; rawResponse?: unknown }>;

export type AgentNextDeps = {
  callLlm: AgentLlmTransport;
  /** Injectable clock and sleep — virtual time in tests, real time in prod. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the autonomous-loop breaker threshold (tests, ops tuning). */
  maxAutonomousTurns?: number;
};

export class AgentNextProcessor extends StreamProcessor<AgentNextProcessorContract, AgentNextDeps> {
  readonly contract = AgentNextProcessorContract;

  /**
   * RUNTIME state: in-memory, dies with the isolate, never persisted. Which
   * requests (by requested-event offset) THIS incarnation is executing, and
   * how to abort them. The journal never knows about incarnations — after an
   * eviction a fresh incarnation folds the journal, finds the open request
   * absent from this map, and runs it again (adopt-based recovery).
   */
  #inFlightLlmCalls = new Map<number, AbortController>();
  /** Streamed text so far per in-flight request — preserved into the
   * cancelled settlement when an interrupt aborts mid-response. */
  #partialResponseTexts = new Map<number, string>();

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #sleep(ms: number): Promise<void> {
    return this.deps.sleep === undefined
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : this.deps.sleep(ms);
  }

  // ------------------------------------------------------------------ reduce
  // Pure fold, one switch. Short cases inline; longer ones call a
  // #reduceSoAndSoEvent helper.
  protected override reduce({ event, state }: ReduceArgs) {
    switch (event.type) {
      case AGENT_CREATED:
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: { createdAtOffset: event.offset } };
      case AGENT_CONFIGURED:
        // Wholesale setter — no merge semantics to reason about.
        return { ...state, config: event.payload.config };
      case AGENT_CONTEXT_ADDED:
        return this.#reduceContextAdded({ event, state });
      case AGENT_LLM_REQUEST_REQUESTED: {
        // Fold-guard: a late debounced intent — desire interrupted away, or a
        // sibling intent already won — folds to nothing, a harmless journal
        // fact. THIS is what makes the delayed append safe without any timer
        // bookkeeping or cancellation.
        if (state.wantsTurnSince === null || state.openRequest !== null) return state;
        return {
          ...state,
          wantsTurnSince: null,
          openRequest: {
            requestedAtOffset: event.offset,
            expiresAt: event.payload.expiresAt,
            model: event.payload.model,
          },
          // The turn covers everything folded so far: keyed context updates
          // after this point append occurrences instead of replacing slots.
          context: { ...state.context, publishedThrough: event.offset },
          autonomousTurnCount:
            state.wantsTurnSince.source === "agent-loop"
              ? state.autonomousTurnCount + 1
              : state.autonomousTurnCount,
        };
      }
      case AGENT_LLM_REQUEST_SETTLED: {
        // Fold-guard: a stale settlement (zombie driver finishing a turn an
        // interrupt already closed) folds to nothing.
        if (event.payload.requestOffset !== state.openRequest?.requestedAtOffset) return state;
        const settled = { ...state, openRequest: null };
        const result = event.payload.result;
        if (result.status === "succeeded") {
          return { ...settled, consecutiveLlmFailures: 0, lastLlmFailureRateLimited: false };
        }
        if (result.status === "failed") {
          return {
            ...settled,
            consecutiveLlmFailures: state.consecutiveLlmFailures + 1,
            lastLlmFailureRateLimited: result.rateLimited,
          };
        }
        return settled; // cancelled
      }
      case AGENT_LOOP_STOPPED:
        // The breaker consumed the pending self-driven trigger.
        return state.wantsTurnSince?.offset === event.payload.triggerOffset
          ? { ...state, wantsTurnSince: null }
          : state;
      case SCRIPT_RUN_REQUESTED:
        if (!event.payload.executionId.startsWith(AGENT_SCRIPT_EXECUTION_ID_PREFIX)) return state;
        return {
          ...state,
          activeScriptExecutionIds: [...state.activeScriptExecutionIds, event.payload.executionId],
        };
      case SCRIPT_RUN_SETTLED:
        return {
          ...state,
          activeScriptExecutionIds: state.activeScriptExecutionIds.filter(
            (id) => id !== event.payload.executionId,
          ),
        };
      default:
        // stream/processor-revived and anything else consumed only for its
        // delivery turn: no fold change.
        return state;
    }
  }

  #reduceContextAdded({ event, state }: ReduceArgs & { event: { type: string } }) {
    if (event.type !== AGENT_CONTEXT_ADDED) return state;
    const payload = event.payload;
    // Fold-guard: assistant output for a request that is no longer the open
    // one (an interrupt won the race) folds to nothing — text included. This
    // replaces the production processor's full re-fold currency check.
    if (
      payload.role === "assistant" &&
      payload.llmRequestOffset !== undefined &&
      payload.llmRequestOffset !== state.openRequest?.requestedAtOffset
    ) {
      return state;
    }
    const context = projectContextAdded(state.context, { offset: event.offset, payload });
    const trigger = contextTriggerSource(payload);
    if (trigger === null) return { ...state, context };
    return {
      ...state,
      context,
      // Every trigger moves the desire — newest wins; the debounce window and
      // all intent idempotency keys anchor to these coordinates.
      wantsTurnSince: { offset: event.offset, atMs: Date.parse(event.createdAt), source: trigger },
      autonomousTurnCount: trigger === "user" ? 0 : state.autonomousTurnCount,
    };
  }

  // ------------------------------------------------------------ processEvent
  // Synchronous. The two lanes are chosen HERE, at the dispatch site, never
  // inside helpers — helpers are plain async functions, unaware of their
  // lane. `blockProcessorWhile` registrations run in FIFO order, so the
  // state-derived work below always lands after the per-event work above.
  protected override processEvent(args: ProcessArgs): undefined {
    const { event, state, previousState, blockProcessorWhile, runInBackground, append, delivery } =
      args;

    switch (event?.type) {
      case AGENT_CONTEXT_ADDED: {
        const payload = event.payload;
        // INTERRUPT — cancellation is a property of new input, never a
        // free-standing command. Abort whatever this incarnation is running
        // and settle the open request as cancelled, carrying the streamed
        // partial text. A zombie's success settlement racing this collapses
        // on the shared settle key; whichever loses folds to nothing.
        const policy =
          payload.role === "user" || payload.role === "developer"
            ? payload.llmRequestPolicy
            : undefined;
        if (policy?.behaviour === "interrupt-current-request" && state.openRequest !== null) {
          const open = state.openRequest;
          for (const controller of this.#inFlightLlmCalls.values()) controller.abort();
          const partialText = this.#partialResponseTexts.get(open.requestedAtOffset);
          blockProcessorWhile(() =>
            append({
              type: AGENT_LLM_REQUEST_SETTLED,
              payload: {
                requestOffset: open.requestedAtOffset,
                result: {
                  status: "cancelled",
                  reason: "interrupted-by-user-input",
                  ...(partialText === undefined ? {} : { partialText }),
                },
              },
              idempotencyKey: this.idempotencyKey(`settle/${open.requestedAtOffset}`),
            }),
          );
        }
        // RESPONSE PARSING — an accepted assistant output may carry a script;
        // extraction rides the same delivery that folded the text.
        if (
          payload.role === "assistant" &&
          payload.llmRequestOffset !== undefined &&
          payload.llmRequestOffset === state.openRequest?.requestedAtOffset
        ) {
          const code = extractAgentScript(payload.content);
          if (code !== null) {
            blockProcessorWhile(() =>
              append({
                type: SCRIPT_RUN_REQUESTED,
                payload: {
                  code,
                  executionId: `${AGENT_SCRIPT_EXECUTION_ID_PREFIX}${event.offset}`,
                  expiresAt: this.#now() + AGENT_LLM_REQUEST_EXPIRY_MS,
                },
                idempotencyKey: this.idempotencyKey(`script-run-requested@${event.offset}`),
              }),
            );
          }
        }
        break;
      }
      case SCRIPT_RUN_SETTLED: {
        const { executionId, settlement } = event.payload;
        if (!executionId.startsWith(AGENT_SCRIPT_EXECUTION_ID_PREFIX)) break;
        blockProcessorWhile(() =>
          append({
            type: AGENT_CONTEXT_ADDED,
            payload: {
              role: "developer",
              content: renderScriptSettlement(executionId, settlement),
              actor: { type: "script", executionId },
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
            idempotencyKey: this.idempotencyKey(`render-script-result@${event.offset}`),
          }),
        );
        break;
      }
      case AGENT_LLM_REQUEST_SETTLED: {
        // A folded FAILURE renders a developer note. Under the retry cap the
        // note triggers the next turn (that note IS the retry mechanism —
        // desire only ever comes from context); at the cap it informs without
        // triggering. The caps and backoff are plain state, plain arithmetic.
        const result = event.payload.result;
        if (result.status !== "failed") break;
        // Only a settlement the fold ACCEPTED renders (it matched the open
        // request before folding); a stale zombie settlement stays silent.
        if (previousState.openRequest?.requestedAtOffset !== event.payload.requestOffset) break;
        const cap = result.rateLimited
          ? MAX_CONSECUTIVE_RATE_LIMITED_LLM_FAILURES
          : MAX_CONSECUTIVE_LLM_FAILURES;
        const retrying = state.consecutiveLlmFailures < cap;
        blockProcessorWhile(() =>
          append({
            type: AGENT_CONTEXT_ADDED,
            payload: {
              role: "developer",
              content: retrying
                ? `LLM request failed (${result.errorMessage}). Retrying.`
                : `LLM request failed (${result.errorMessage}). Giving up after ${state.consecutiveLlmFailures} consecutive failures; a new user message starts fresh.`,
              actor: { type: "agent", path: this.path },
              llmRequestPolicy: {
                behaviour: retrying ? "after-current-request" : "dont-trigger-request",
              },
            },
            idempotencyKey: this.idempotencyKey(`render-llm-failure@${event.offset}`),
          }),
        );
        break;
      }
      // created / configured / requested / loop-stopped / script-run-requested /
      // revived: no per-event effect — they matter through the fold below.
    }

    // ---------------------------------------- state-derived side effects
    // Plain code over the fold, after every delivery. Policy first: act only
    // at head — behind it the fold is partial and outcomes may sit in journal
    // pages not yet replayed.
    if (!delivery.caughtUp) return;

    // A turn is wanted and nothing is open → journal the intent (or fire the
    // breaker), and STOP. The LLM call does not start here: the requested
    // event comes back through our own subscription carrying the offset the
    // journal gave it, and the adopt branch below — the ONE place work ever
    // starts — picks it up. Starting fresh and recovering after an eviction
    // are the same code path.
    const desire = state.wantsTurnSince;
    if (desire !== null && state.openRequest === null && state.config !== null) {
      const maxAutonomousTurns = this.deps.maxAutonomousTurns ?? MAX_AUTONOMOUS_TURNS;
      if (desire.source === "agent-loop" && state.autonomousTurnCount >= maxAutonomousTurns) {
        blockProcessorWhile(() =>
          append({
            type: AGENT_LOOP_STOPPED,
            payload: { maxAutonomousTurns, triggerOffset: desire.offset },
            idempotencyKey: this.idempotencyKey(`autonomous-turn-limit:${desire.offset}`),
          }),
        );
        return;
      }
      const model = state.config.llm.model;
      const requestedInput = () => ({
        type: AGENT_LLM_REQUEST_REQUESTED,
        payload: { model, expiresAt: this.#now() + AGENT_LLM_REQUEST_EXPIRY_MS },
        // Dedupe fence only, keyed on the desire's coordinates — the
        // request's IDENTITY is the offset the journal assigns on commit.
        idempotencyKey: this.idempotencyKey(`request/${desire.offset}`),
      });
      // Debounce = wait for more content, plus failure backoff — one window.
      const windowMs = AGENT_LLM_REQUEST_DEBOUNCE_MS + retryBackoffMs(state);
      const windowClosesInMs = desire.atMs + windowMs - this.#now();
      if (windowClosesInMs > 0) {
        // The delayed append IS the intent (no wake event): if the desire
        // moves or an interrupt clears it before this fires, the requested
        // event's fold-guard turns the late intent into a harmless fact. A
        // droppable attempt: dying mid-window means the revival turn re-runs
        // this code with the window long closed and appends directly.
        runInBackground(async () => {
          await this.#sleep(windowClosesInMs);
          await append(requestedInput());
        });
      } else {
        blockProcessorWhile(() => append(requestedInput()));
      }
      return;
    }

    // An open request nobody HERE is executing → run it. First time through,
    // that is the normal start (our own requested event arriving at head);
    // after an eviction it is the recovery (the revived fact arriving at
    // head). Expired → settle it instead: answering a stale trigger with a
    // stale context snapshot is worse than admitting the miss.
    const open = state.openRequest;
    if (open !== null && !this.#inFlightLlmCalls.has(open.requestedAtOffset)) {
      if (this.#now() >= open.expiresAt) {
        blockProcessorWhile(() =>
          append({
            type: AGENT_LLM_REQUEST_SETTLED,
            payload: {
              requestOffset: open.requestedAtOffset,
              result: { status: "cancelled", reason: "expired" },
            },
            idempotencyKey: this.idempotencyKey(`settle/${open.requestedAtOffset}`),
          }),
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
  #runLlmRequest(args: ProcessArgs, open: NonNullable<AgentNextState["openRequest"]>) {
    const requestOffset = open.requestedAtOffset;
    const controller = new AbortController();
    this.#inFlightLlmCalls.set(requestOffset, controller);
    const startedAtMs = this.#now();
    let chunkSequence = 0;
    args.runInBackground(async () => {
      try {
        const response = await this.deps.callLlm({
          model: open.model,
          messages: buildLlmMessages({
            context: args.state.context,
            requestedAtOffset: requestOffset,
            nowIso: new Date(this.#now()).toISOString(),
          }),
          signal: controller.signal,
          onChunk: (text) => {
            this.#partialResponseTexts.set(
              requestOffset,
              (this.#partialResponseTexts.get(requestOffset) ?? "") + text,
            );
            const sequence = chunkSequence;
            chunkSequence += 1;
            // Ephemeral streaming: best-effort, never awaited, never folded.
            void args
              .append({
                type: AGENT_LLM_RESPONSE_CHUNK,
                payload: { requestOffset, sequence, text },
                ephemeral: true,
              })
              .catch(() => undefined);
          },
        });
        await args.append(
          {
            type: AGENT_CONTEXT_ADDED,
            payload: {
              role: "assistant",
              content: response.text,
              llmRequestOffset: requestOffset,
            },
            idempotencyKey: this.idempotencyKey(`assistant-context@${requestOffset}`),
          },
          {
            type: AGENT_LLM_REQUEST_SETTLED,
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
        );
      } catch (error) {
        // An aborted call is the interrupt path's story — it already settled
        // the request as cancelled; a second settlement would dedupe anyway.
        if (controller.signal.aborted) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        await args.append({
          type: AGENT_LLM_REQUEST_SETTLED,
          payload: {
            requestOffset,
            durationMs: Math.max(0, this.#now() - startedAtMs),
            result: {
              status: "failed",
              errorMessage,
              rateLimited: isRateLimitErrorMessage(errorMessage),
            },
          },
          idempotencyKey: this.idempotencyKey(`settle/${requestOffset}`),
        });
      } finally {
        this.#inFlightLlmCalls.delete(requestOffset);
        this.#partialResponseTexts.delete(requestOffset);
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Pure helpers — exported for direct unit testing.
// -----------------------------------------------------------------------------

/** Which turn-loop trigger a context item carries. Desire only ever comes
 * from context — there is no other scheduling input. */
export function contextTriggerSource(
  payload: AgentNextContextAddedPayload,
): "user" | "agent-loop" | null {
  if (payload.role === "system" || payload.role === "assistant") return null;
  if (payload.llmRequestPolicy.behaviour === "dont-trigger-request") return null;
  if (payload.role === "user") return "user";
  const actorType = payload.actor?.type;
  // The agent's own notes and its scripts drive the autonomous loop; every
  // other developer-lane author counts as an external (user-like) trigger.
  return actorType === "agent" || actorType === "script" ? "agent-loop" : "user";
}

/** Fold one context item into the projection. A keyed item replaces its
 * UNPUBLISHED slot in place; once published, an update appends a new
 * occurrence back-referencing the one it supersedes (append-only history). */
export function projectContextAdded(
  context: AgentNextState["context"],
  item: { offset: number; payload: AgentNextContextAddedPayload },
): AgentNextState["context"] {
  const lane = item.payload.role === "system" ? "system" : "history";
  const items = context[lane];
  const key = item.payload.key;
  if (key !== undefined) {
    const slotIndex = items.findLastIndex((existing) => existing.payload.key === key);
    if (slotIndex >= 0) {
      const slot = items[slotIndex]!;
      if (slot.offset > context.publishedThrough) {
        const replaced = [...items];
        replaced[slotIndex] = {
          offset: item.offset,
          ...(slot.updatesOffset === undefined ? {} : { updatesOffset: slot.updatesOffset }),
          payload: item.payload,
        };
        return { ...context, [lane]: replaced };
      }
      return {
        ...context,
        [lane]: [
          ...items,
          { offset: item.offset, updatesOffset: slot.offset, payload: item.payload },
        ],
      };
    }
  }
  return { ...context, [lane]: [...items, { offset: item.offset, payload: item.payload }] };
}

/** Exponential failure backoff folded into the debounce window; rate-limit
 * weather jumps straight to the ceiling (429s clear per-minute). */
export function retryBackoffMs(
  state: Pick<AgentNextState, "consecutiveLlmFailures" | "lastLlmFailureRateLimited">,
): number {
  if (state.consecutiveLlmFailures <= 0) return 0;
  if (state.lastLlmFailureRateLimited && state.consecutiveLlmFailures >= 2) {
    return AGENT_LLM_RETRY_BACKOFF_MAX_MS;
  }
  return Math.min(
    2 ** (state.consecutiveLlmFailures - 1) * AGENT_LLM_RETRY_BACKOFF_BASE_MS,
    AGENT_LLM_RETRY_BACKOFF_MAX_MS,
  );
}

export function isRateLimitErrorMessage(message: string): boolean {
  return /\b429\b|\b3021\b|rate.?limit/i.test(message);
}

/** Build the model-facing message array from the fold, pinned to the
 * request's offset so an adopting incarnation reproduces the same prompt the
 * intent covered. System items dedupe by key (latest wins); developer items
 * from anyone but the agent or its scripts are DEMOTED to user role (trust
 * boundary). The trailing timestamp message is last so the provider's
 * prompt-cache prefix stays stable across turns. */
export function buildLlmMessages(args: {
  context: AgentNextState["context"];
  requestedAtOffset: number;
  nowIso: string;
}): AgentLlmMessage[] {
  const covered = (item: { offset: number }) => item.offset <= args.requestedAtOffset;
  const systemByKey = new Map<string, string>();
  const systemUnkeyed: string[] = [];
  for (const item of args.context.system.filter(covered)) {
    if (item.payload.key === undefined) systemUnkeyed.push(item.payload.content);
    else systemByKey.set(item.payload.key, item.payload.content);
  }
  const messages: AgentLlmMessage[] = [];
  const systemContent = [...systemByKey.values(), ...systemUnkeyed].join("\n\n");
  if (systemContent.length > 0) messages.push({ role: "system", content: systemContent });
  for (const item of args.context.history.filter(covered)) {
    messages.push({ role: modelRoleFor(item.payload), content: renderContextItem(item) });
  }
  messages.push({ role: "developer", content: `The current time is ${args.nowIso}.` });
  return messages;
}

function modelRoleFor(payload: AgentNextContextAddedPayload): AgentLlmMessage["role"] {
  if (payload.role !== "developer") return payload.role;
  const actorType = payload.actor?.type;
  return actorType === "agent" || actorType === "script" ? "developer" : "user";
}

function renderContextItem(item: {
  offset: number;
  updatesOffset?: number;
  payload: AgentNextContextAddedPayload;
}): string {
  const headerParts = [`@${item.offset}`];
  if (item.payload.key !== undefined) headerParts.push(`key=${item.payload.key}`);
  if (item.updatesOffset !== undefined) headerParts.push(`updates=@${item.updatesOffset}`);
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
export function renderScriptSettlement(executionId: string, settlement: unknown): string {
  const body = JSON.stringify(settlement, null, 2) ?? String(settlement);
  const truncated =
    body.length > SCRIPT_RESULT_HISTORY_LIMIT
      ? `${body.slice(0, SCRIPT_RESULT_HISTORY_LIMIT)}\n… [truncated ${body.length - SCRIPT_RESULT_HISTORY_LIMIT} chars]`
      : body;
  return `Script ${executionId} settled:\n${truncated}`;
}
