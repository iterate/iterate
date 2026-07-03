import { z } from "zod";
import type { StreamEvent } from "../../types.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  PI_COMPACTION_SUMMARY_PREFIX,
  PI_COMPACTION_SUMMARY_SUFFIX,
  PiProcessorContract,
  type PiAssistantContent,
  type PiAssistantMessage,
  type PiCompactionReason,
  type PiHistoryEntry,
  type PiToolCall,
} from "./pi-processor-contract.ts";

/** The pi processor's folded state (see the contract's stateSchema for field semantics). */
type PiState = z.infer<typeof PiProcessorContract.stateSchema>;
/** A parsed event from the pi contract's consumed vocabulary. */
type PiConsumedEvent = ReturnType<typeof PiProcessorContract.parseEvent>;
/** The contract-validated append helper handed to the process hooks. */
type PiAppend = Parameters<
  StreamProcessor<typeof PiProcessorContract>["processEventBatch"]
>[0]["append"];

/**
 * One message of an LLM request body: pi's Message union after the context
 * transform (compaction summaries rendered as user messages, error/aborted
 * assistant messages dropped, orphaned tool calls answered synthetically).
 */
export type PiLlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: PiAssistantContent[] }
  | { role: "toolResult"; content: string; isError: boolean; toolCallId: string; toolName: string };

/** A tool definition as sent to the LLM provider: JSON-schema parameters. */
export type PiLlmToolDefinition = {
  description: string;
  name: string;
  parameters: unknown;
};

/** A complete LLM request body, built purely from folded state (plus the injected tool catalog). */
export type PiLlmRequest = {
  messages: PiLlmMessage[];
  model: string;
  systemPrompt: string;
  tools: PiLlmToolDefinition[];
};

/**
 * The LLM transport dependency. Mirrors pi's StreamFn contract: once invoked
 * it must not throw — request failures and aborts are encoded in the returned
 * message via stopReason error/aborted (the processor is defensive about
 * violations, but honoring the contract preserves partial output).
 */
export type PiLlmDep = {
  complete(request: PiLlmRequest, options: { signal: AbortSignal }): Promise<PiAssistantMessage>;
};

/**
 * One executable tool. Mirrors pi's AgentTool: schema-validated arguments,
 * throw-on-failure execution (the processor converts throws into error
 * results), opt-in sequential execution, and pi's `terminate` flag to end the
 * turn without another LLM call.
 */
export type PiToolDep = {
  description: string;
  executionMode?: "parallel" | "sequential";
  parameters: z.ZodType;
  execute(
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ content: string; isError?: boolean; terminate?: boolean }>;
};

export class PiProcessor extends StreamProcessor<
  typeof PiProcessorContract,
  { llm: PiLlmDep; tools: Record<string, PiToolDep> }
> {
  readonly contract = PiProcessorContract;
  readonly #inFlightLlmRequests = new Map<number, AbortController>();
  readonly #inFlightToolBatches = new Map<number, AbortController>();
  readonly #inFlightCompactions = new Set<number>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof PiProcessorContract>["reduce"]>[0]) {
    return reducePiEvent({ event, state });
  }

  protected override processEvent({
    append,
    event,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<typeof PiProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/pi/llm-request-requested": {
        // Only act when the fold accepted the request as current (a replayed
        // or superseded request event reduces to a no-op).
        if (state.run.phase !== "streaming" || state.run.llmRequestId !== event.offset) return;
        this.#startLlmRequest({ append, llmRequestId: event.offset, runInBackground });
        return;
      }
      case "events.iterate.com/pi/assistant-message-added": {
        if (state.run.phase !== "executing-tools" || state.run.assistantOffset !== event.offset)
          return;
        if (this.#inFlightToolBatches.has(event.offset)) return;
        const controller = new AbortController();
        this.#inFlightToolBatches.set(event.offset, controller);
        const toolCalls = event.payload.message.content.filter(
          (block): block is PiToolCall => block.type === "toolCall",
        );
        runInBackground(() =>
          this.#executeToolCallBatch({
            append,
            assistantOffset: event.offset,
            signal: controller.signal,
            toolCalls,
          }),
        );
        return;
      }
      case "events.iterate.com/pi/abort-requested": {
        for (const controller of this.#inFlightLlmRequests.values()) controller.abort();
        for (const controller of this.#inFlightToolBatches.values()) controller.abort();
        return;
      }
      case "events.iterate.com/pi/compaction-requested": {
        if (state.compaction?.requestedOffset !== event.offset) return;
        this.#startCompaction({ append, requestedOffset: event.offset, runInBackground });
        return;
      }
      default:
        return;
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<typeof PiProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    await this.#settle(args);
  }

  /**
   * The loop's driving decisions, derived from reduced state once per batch —
   * never per event, where same-batch appends are invisible: keep in-flight
   * work alive across restarts, then (idle only) request compaction or the
   * next LLM call. All appends are idempotency-keyed, so re-derivation on
   * replay is inert. The non-trivial predicates (compactionToRequest,
   * lostToolCalls) are pure and unit-tested; this method is just their wiring.
   */
  async #settle({
    append,
    runInBackground,
    state,
  }: Parameters<
    StreamProcessor<typeof PiProcessorContract>["processEventBatch"]
  >[0]): Promise<void> {
    if (state.compaction !== null) {
      // Already in flight when processEvent started it in this batch; after a
      // restart this revives the summarize call.
      this.#startCompaction({
        append,
        requestedOffset: state.compaction.requestedOffset,
        runInBackground,
      });
      return;
    }

    if (state.run.phase === "streaming") {
      // Already in flight on the live path; after a restart this re-issues the
      // request. The assistant-message append is keyed on the llmRequestId, so
      // a lost race with a still-live twin instance dedups to one message.
      this.#startLlmRequest({ append, llmRequestId: state.run.llmRequestId, runInBackground });
      return;
    }

    if (state.run.phase === "executing-tools") {
      if (this.#inFlightToolBatches.has(state.run.assistantOffset)) return;
      // Restart recovery: this instance is not executing the batch, and tools
      // must not be blindly re-run, so the lost calls become error results —
      // pi's orphaned-call semantics — and the loop continues. (When the
      // assistant-message event itself is redelivered, processEvent instead
      // re-executes exactly the calls with no recorded result; this branch
      // covers the checkpoint-already-advanced case.)
      const { assistantOffset } = state.run;
      await append(
        ...lostToolCalls(state).map((call) => ({
          type: "events.iterate.com/pi/tool-result-added" as const,
          idempotencyKey: toolResultIdempotencyKey({
            assistantOffset,
            toolCallId: call.toolCallId,
          }),
          payload: {
            assistantOffset,
            content: "Tool execution was lost in a restart before it completed.",
            isError: true,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          },
        })),
      );
      return;
    }

    // Idle: compaction has priority over the next LLM request, so an
    // over-threshold context is summarized before it is sent anywhere.
    const compaction = compactionToRequest(state);
    if (compaction !== null) {
      await append({
        type: "events.iterate.com/pi/compaction-requested",
        idempotencyKey: `pi/compaction-requested@epoch:${state.compactionEpoch}:tail:${compaction.tailOffset}`,
        payload: compaction,
      });
      return;
    }

    if (state.pendingTrigger) {
      await append({
        type: "events.iterate.com/pi/llm-request-requested",
        idempotencyKey: `pi/llm-request@generation:${state.generation}`,
        payload: { generation: state.generation },
      });
    }
  }

  /** Register the request as in flight and run it in the background; no-op if already running here. */
  #startLlmRequest(input: {
    append: PiAppend;
    llmRequestId: number;
    runInBackground: (work: () => Promise<unknown>) => void;
  }): void {
    if (this.#inFlightLlmRequests.has(input.llmRequestId)) return;
    const controller = new AbortController();
    this.#inFlightLlmRequests.set(input.llmRequestId, controller);
    input.runInBackground(() =>
      this.#executeLlmRequest({
        append: input.append,
        llmRequestId: input.llmRequestId,
        signal: controller.signal,
      }),
    );
  }

  /** Register the compaction as in flight and run it in the background; no-op if already running here. */
  #startCompaction(input: {
    append: PiAppend;
    requestedOffset: number;
    runInBackground: (work: () => Promise<unknown>) => void;
  }): void {
    if (this.#inFlightCompactions.has(input.requestedOffset)) return;
    this.#inFlightCompactions.add(input.requestedOffset);
    input.runInBackground(() =>
      this.#executeCompaction({ append: input.append, requestedOffset: input.requestedOffset }),
    );
  }

  /**
   * The fold of every consumed event up to and including `offset` — the
   * deterministic context for a side effect anchored at that event. Re-reading
   * the journal (instead of capturing hook state) keeps the live path, the
   * restart path, and any twin instance building bit-identical requests.
   */
  async #stateAtOffset(offset: number): Promise<PiState> {
    const events = await this.stream.getEvents();
    return reducePiEvents(events.filter((event) => event.offset <= offset));
  }

  #requestWithTools(request: Omit<PiLlmRequest, "tools">): PiLlmRequest {
    return {
      ...request,
      tools: Object.entries(this.deps.tools).map(([name, tool]) => ({
        description: tool.description,
        name,
        parameters: z.toJSONSchema(tool.parameters),
      })),
    };
  }

  async #executeLlmRequest(input: {
    append: PiAppend;
    llmRequestId: number;
    signal: AbortSignal;
  }): Promise<void> {
    const idempotencyKey = `pi/assistant-message@${input.llmRequestId}`;
    try {
      // Replay guard: if a previous incarnation already recorded the answer,
      // do not bill a second model call for it.
      if ((await this.stream.getEvent({ idempotencyKey })) !== undefined) return;
      const request = this.#requestWithTools(
        buildPiLlmRequest(await this.#stateAtOffset(input.llmRequestId)),
      );
      let message: PiAssistantMessage;
      try {
        message = await this.deps.llm.complete(request, { signal: input.signal });
      } catch (error) {
        message = {
          role: "assistant",
          content: [],
          errorMessage: stringifyError(error),
          stopReason: input.signal.aborted ? "aborted" : "error",
        };
      }
      await input.append({
        type: "events.iterate.com/pi/assistant-message-added",
        idempotencyKey,
        payload: { llmRequestId: input.llmRequestId, message },
      });
    } finally {
      this.#inFlightLlmRequests.delete(input.llmRequestId);
    }
  }

  /**
   * pi's execution modes: parallel by default, whole batch sequential when any
   * called tool declares it. Parallel results are appended together in source
   * order after all executions finish (pi emits result messages the same way);
   * sequential appends per call and stops executing after an abort, leaving
   * the remaining calls to be synthesized as "No result provided" at the next
   * request build.
   */
  async #executeToolCallBatch(input: {
    append: PiAppend;
    assistantOffset: number;
    signal: AbortSignal;
    toolCalls: PiToolCall[];
  }): Promise<void> {
    const { append, assistantOffset, signal, toolCalls } = input;
    try {
      // Execute one call and build its result event; undefined when a
      // previous incarnation already recorded the result (never re-execute).
      const executeToResultEvent = async (call: PiToolCall) => {
        const idempotencyKey = toolResultIdempotencyKey({ assistantOffset, toolCallId: call.id });
        if ((await this.stream.getEvent({ idempotencyKey })) !== undefined) return undefined;
        const outcome = await this.#executeToolCall(call, signal);
        return {
          type: "events.iterate.com/pi/tool-result-added" as const,
          idempotencyKey,
          payload: {
            assistantOffset,
            content: outcome.content,
            isError: outcome.isError,
            toolCallId: call.id,
            toolName: call.name,
            ...(outcome.terminate === undefined ? {} : { terminate: outcome.terminate }),
          },
        };
      };

      const sequential = toolCalls.some(
        (call) => this.deps.tools[call.name]?.executionMode === "sequential",
      );
      if (sequential) {
        for (const call of toolCalls) {
          const result = await executeToResultEvent(call);
          if (result !== undefined) await append(result);
          if (signal.aborted) break;
        }
      } else {
        const results = await Promise.all(toolCalls.map(executeToResultEvent));
        const defined = results.filter((result) => result !== undefined);
        if (defined.length > 0) await append(...defined);
      }
    } finally {
      this.#inFlightToolBatches.delete(assistantOffset);
    }
  }

  async #executeToolCall(
    call: PiToolCall,
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean; terminate?: boolean }> {
    const tool = this.deps.tools[call.name];
    if (tool === undefined) return { content: `Tool ${call.name} not found`, isError: true };
    if (signal.aborted) return { content: "Operation aborted", isError: true };
    const parsed = tool.parameters.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        content: `Invalid arguments for tool ${call.name}: ${z.prettifyError(parsed.error)}`,
        isError: true,
      };
    }
    try {
      const result = await tool.execute(parsed.data, signal);
      return {
        content: result.content,
        isError: result.isError ?? false,
        ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
      };
    } catch (error) {
      return { content: stringifyError(error), isError: true };
    }
  }

  async #executeCompaction(input: { append: PiAppend; requestedOffset: number }): Promise<void> {
    const { append, requestedOffset } = input;
    const idempotencyKey = `pi/compaction-completed@${requestedOffset}`;
    try {
      if ((await this.stream.getEvent({ idempotencyKey })) !== undefined) return;
      // The plan folds the journal at the requested offset, so live and
      // restarted incarnations choose the same cut deterministically.
      const state = await this.#stateAtOffset(requestedOffset);
      const plan = planCompaction(state);
      let result:
        | { status: "success"; firstKeptIndex: number; summary: string; tokensBefore: number }
        | { status: "failure"; error: { message: string } };
      if (plan === null) {
        result = { status: "failure", error: { message: "No valid compaction cut point." } };
      } else {
        try {
          const message = await this.deps.llm.complete(
            { ...buildSummarizationRequest({ plan, state }), tools: [] },
            { signal: new AbortController().signal },
          );
          const summary = message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
          result =
            message.stopReason === "stop" || message.stopReason === "length"
              ? {
                  status: "success",
                  firstKeptIndex: plan.firstKeptIndex,
                  summary,
                  tokensBefore: plan.tokensBefore,
                }
              : {
                  status: "failure",
                  error: { message: message.errorMessage ?? `stopReason ${message.stopReason}` },
                };
        } catch (error) {
          result = { status: "failure", error: { message: stringifyError(error) } };
        }
      }
      await append({
        type: "events.iterate.com/pi/compaction-completed",
        idempotencyKey,
        payload: { requestedOffset, result },
      });
    } finally {
      this.#inFlightCompactions.delete(requestedOffset);
    }
  }
}

function toolResultIdempotencyKey(input: { assistantOffset: number; toolCallId: string }): string {
  return `pi/tool-result@${input.assistantOffset}:${input.toolCallId}`;
}

/**
 * Fold a raw event log into pi processor state. Events outside the contract's
 * consumed vocabulary are skipped (the processor shares its stream with other
 * processors' events), which is why this fold is lenient where the live
 * delivery path — already filtered to consumed types — validates strictly.
 */
export function reducePiEvents(events: readonly StreamEvent[]): PiState {
  let state = PiProcessorContract.stateSchema.parse({});
  for (const event of events) {
    try {
      state = reducePiEvent({
        event: PiProcessorContract.parseEvent(event) as PiConsumedEvent,
        state,
      });
    } catch {
      continue;
    }
  }
  return state;
}

/** Pure single-event fold, exported so the state machine is unit-testable event by event. */
export function reducePiEvent(input: { event: PiConsumedEvent; state: PiState }): PiState {
  const { event, state } = input;
  switch (event.type) {
    case "events.iterate.com/pi/config-updated": {
      const { compactionSettings, contextWindow, model, systemPrompt } = event.payload;
      return {
        ...state,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(model === undefined ? {} : { model }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(compactionSettings === undefined
          ? {}
          : { compactionSettings: { ...state.compactionSettings, ...compactionSettings } }),
      };
    }
    case "events.iterate.com/pi/user-message-received": {
      const entry: PiHistoryEntry = {
        message: { role: "user", content: event.payload.text },
        offset: event.offset,
      };
      if (state.run.phase === "idle") {
        return { ...state, history: [...state.history, entry], pendingTrigger: true };
      }
      if (event.payload.whileRunning === "follow-up") {
        return { ...state, followUpQueue: [...state.followUpQueue, event.payload.text] };
      }
      return { ...state, steeringQueue: [...state.steeringQueue, event.payload.text] };
    }
    case "events.iterate.com/pi/abort-requested": {
      // pi's abort: clear both queues, drop any pending trigger, end the run.
      // The in-flight request's partial output still lands in history when its
      // assistant-message-added arrives (as a stale, history-only event).
      // The generation bumps unconditionally so that an llm-request-requested
      // event already appended but not yet delivered when the abort landed
      // (settle races user appends) reduces to a stale no-op instead of
      // starting a model call the user just cancelled.
      return {
        ...state,
        followUpQueue: [],
        generation: state.generation + 1,
        pendingTrigger: false,
        run: { phase: "idle" },
        steeringQueue: [],
      };
    }
    case "events.iterate.com/pi/llm-request-requested": {
      // Stale requests (superseded by an abort, or raced by a competing
      // writer's compaction-requested) do not start a run — but they must
      // still advance the generation: the event consumed its
      // `pi/llm-request@generation:N` idempotency key, and re-deriving the
      // trigger under a spent key would dedup into this dead event forever.
      if (
        state.run.phase !== "idle" ||
        state.compaction !== null ||
        event.payload.generation !== state.generation
      ) {
        return { ...state, generation: state.generation + 1 };
      }
      return {
        ...state,
        pendingTrigger: false,
        run: { phase: "streaming", llmRequestId: event.offset },
      };
    }
    case "events.iterate.com/pi/assistant-message-added": {
      const { llmRequestId, message } = event.payload;
      const withHistory = {
        ...state,
        history: [...state.history, { message, offset: event.offset }],
      };
      if (state.run.phase !== "streaming" || state.run.llmRequestId !== llmRequestId) {
        // Stale: an aborted request's partial output arriving after the run
        // already ended. Record it; the request builder skips it.
        return withHistory;
      }
      const completed = { ...withHistory, generation: state.generation + 1 };
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        // pi ends the run dead on error/aborted — no steering injection, no
        // follow-up drain, no fresh request. Queued messages stay queued; the
        // next run (user prompt, or an overflow-recovery retrigger) drains
        // them at its own turn boundaries.
        return { ...completed, run: { phase: "idle" } };
      }
      const toolCalls = message.content.filter((block) => block.type === "toolCall");
      if (toolCalls.length > 0) {
        return {
          ...completed,
          overflowRecoveryAttempted: false,
          run: {
            phase: "executing-tools",
            allResultsTerminate: true,
            assistantOffset: event.offset,
            pendingToolCallIds: toolCalls.map((call) => call.id),
          },
        };
      }
      return drainQueuesAtRunEnd(
        { ...completed, overflowRecoveryAttempted: false, run: { phase: "idle" } },
        { atOffset: event.offset, continueLoop: false },
      );
    }
    case "events.iterate.com/pi/tool-result-added": {
      const { payload } = event;
      const withHistory = {
        ...state,
        history: [
          ...state.history,
          {
            message: {
              role: "toolResult" as const,
              content: payload.content,
              isError: payload.isError,
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
            },
            offset: event.offset,
          },
        ],
      };
      if (
        state.run.phase !== "executing-tools" ||
        state.run.assistantOffset !== payload.assistantOffset ||
        !state.run.pendingToolCallIds.includes(payload.toolCallId)
      ) {
        // Stale: a result landing after an abort ended the run. Keep the fact;
        // it does not drive the loop.
        return withHistory;
      }
      const pendingToolCallIds = state.run.pendingToolCallIds.filter(
        (id) => id !== payload.toolCallId,
      );
      const allResultsTerminate = state.run.allResultsTerminate && payload.terminate === true;
      if (pendingToolCallIds.length > 0) {
        return { ...withHistory, run: { ...state.run, allResultsTerminate, pendingToolCallIds } };
      }
      // Batch complete: continue the loop (pi's hasMoreToolCalls) unless every
      // result voted to terminate the turn.
      return drainQueuesAtRunEnd(
        { ...withHistory, run: { phase: "idle" } },
        { atOffset: event.offset, continueLoop: !allResultsTerminate },
      );
    }
    case "events.iterate.com/pi/compaction-requested": {
      // Compaction only starts from a settled idle state; an event that raced
      // a run start (competing writer) reduces to a no-op.
      if (state.compaction !== null || state.run.phase !== "idle") return state;
      return {
        ...state,
        compaction: {
          reason: event.payload.reason,
          requestedOffset: event.offset,
          tailOffset: event.payload.tailOffset,
          generation: state.generation,
        },
        ...(event.payload.reason === "overflow" ? { overflowRecoveryAttempted: true } : {}),
      };
    }
    case "events.iterate.com/pi/compaction-completed": {
      if (state.compaction?.requestedOffset !== event.payload.requestedOffset) return state;
      const base = { ...state, compaction: null, compactionEpoch: state.compactionEpoch + 1 };
      if (event.payload.result.status === "failure") {
        return { ...base, compactionFailedForTailOffset: state.compaction.tailOffset };
      }
      const { firstKeptIndex, summary } = event.payload.result;
      return {
        ...base,
        compactionFailedForTailOffset: null,
        // Index-addressed splice: while a compaction is in flight the fold
        // only ever appends to history, so the planned index still points at
        // the first kept entry. The summary's offset records provenance (this
        // event), not position.
        history: [
          { message: { role: "compactionSummary", summary }, offset: event.offset },
          ...state.history.slice(firstKeptIndex),
        ],
        // An overflow recovery retries the request that hit the wall — unless
        // the user aborted (or anything else moved the generation) meanwhile.
        ...(state.compaction.reason === "overflow" &&
        state.compaction.generation === state.generation
          ? { pendingTrigger: true }
          : {}),
      };
    }
    default:
      return state;
  }
}

/**
 * pi's end-of-turn drain points, as a fold: steering messages inject and keep
 * the loop going; otherwise a continuing tool loop re-triggers; otherwise
 * follow-ups start a new run; otherwise the agent goes quiet.
 */
function drainQueuesAtRunEnd(
  state: PiState,
  input: { atOffset: number; continueLoop: boolean },
): PiState {
  const asUserEntries = (texts: string[]): PiHistoryEntry[] =>
    texts.map((text) => ({ message: { role: "user", content: text }, offset: input.atOffset }));
  if (state.steeringQueue.length > 0) {
    return {
      ...state,
      history: [...state.history, ...asUserEntries(state.steeringQueue)],
      pendingTrigger: true,
      steeringQueue: [],
    };
  }
  if (input.continueLoop) return { ...state, pendingTrigger: true };
  if (state.followUpQueue.length > 0) {
    return {
      ...state,
      followUpQueue: [],
      history: [...state.history, ...asUserEntries(state.followUpQueue)],
      pendingTrigger: true,
    };
  }
  return state;
}

// =============================================================================
// Request building — pi's convertToLlm + transform-messages rules, as a pure
// function of folded state.
// =============================================================================

/**
 * Build the model-facing request body from history. Ports pi's context
 * transform exactly:
 * - error/aborted assistant messages are dropped entirely (their tool calls
 *   with them), so a failed or interrupted request never re-enters context;
 * - every tool call without a recorded result gets a synthetic
 *   "No result provided" error result, inserted before the next non-result
 *   message — an interrupted tool batch replays as errors, not as a
 *   protocol violation;
 * - compaction summaries render as user messages wrapped in pi's <summary>
 *   tags;
 * - tool results whose call is no longer in context (it arrived after an
 *   abort already orphaned the call) are dropped.
 */
export function buildPiLlmRequest(state: PiState): Omit<PiLlmRequest, "tools"> {
  const messages: PiLlmMessage[] = [];
  let openToolCalls: PiToolCall[] = [];
  const flushOrphanedToolCalls = () => {
    for (const call of openToolCalls) {
      messages.push({
        role: "toolResult",
        content: "No result provided",
        isError: true,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
    openToolCalls = [];
  };

  for (const { message } of state.history) {
    switch (message.role) {
      case "user":
        flushOrphanedToolCalls();
        messages.push({ role: "user", content: message.content });
        break;
      case "compactionSummary":
        flushOrphanedToolCalls();
        messages.push({
          role: "user",
          content: `${PI_COMPACTION_SUMMARY_PREFIX}${message.summary}${PI_COMPACTION_SUMMARY_SUFFIX}`,
        });
        break;
      case "assistant": {
        flushOrphanedToolCalls();
        if (message.stopReason === "error" || message.stopReason === "aborted") break;
        messages.push({ role: "assistant", content: message.content });
        openToolCalls = message.content.filter((block) => block.type === "toolCall");
        break;
      }
      case "toolResult": {
        if (!openToolCalls.some((call) => call.id === message.toolCallId)) break;
        openToolCalls = openToolCalls.filter((call) => call.id !== message.toolCallId);
        messages.push({
          role: "toolResult",
          content: message.content,
          isError: message.isError,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
        });
        break;
      }
    }
  }
  flushOrphanedToolCalls();

  return { messages, model: state.model, systemPrompt: state.systemPrompt };
}

// =============================================================================
// Compaction — pi's token accounting, cut-point selection, and summarization
// prompts, simplified to cut only at user messages (pi also cuts at assistant
// messages and summarizes the split turn's prefix separately).
// =============================================================================

/**
 * pi's estimateContextTokens: trust the most recent valid assistant usage
 * block, estimate everything after it at ~4 chars/token. A usage block is
 * only valid when it postdates the last compaction (entry offset beyond the
 * summary's provenance offset): a kept pre-compaction assistant message
 * reports the token count of the context that FORCED the compaction, and
 * anchoring on it would demand compaction forever.
 */
export function estimatePiContextTokens(history: readonly PiHistoryEntry[]): number {
  const summary = history.find((entry) => entry.message.role === "compactionSummary");
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    const message = entry.message;
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.usage !== undefined &&
      message.usage.totalTokens > 0 &&
      (summary === undefined || entry.offset > summary.offset)
    ) {
      let trailing = 0;
      for (let j = i + 1; j < history.length; j++)
        trailing += estimateMessageTokens(history[j]!.message);
      return message.usage.totalTokens + trailing;
    }
  }
  let estimated = 0;
  for (const entry of history) estimated += estimateMessageTokens(entry.message);
  return estimated;
}

function estimateMessageTokens(message: PiHistoryEntry["message"]): number {
  let chars = 0;
  switch (message.role) {
    case "user":
    case "toolResult":
      chars = message.content.length;
      break;
    case "compactionSummary":
      chars = message.summary.length;
      break;
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else chars += JSON.stringify(block.arguments).length + block.name.length;
      }
      break;
  }
  return Math.ceil(chars / 4);
}

/**
 * Choose the first kept history index: walk back from the tail until
 * ~keepRecentTokens accumulate, then snap forward to the nearest user message
 * (a turn boundary — never a tool result, per pi). Returns null when there is
 * no cut that would actually drop anything.
 */
export function findCompactionCutIndex(
  history: readonly PiHistoryEntry[],
  keepRecentTokens: number,
): number | null {
  let accumulated = 0;
  let reachedIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(history[i]!.message);
    if (accumulated >= keepRecentTokens) {
      reachedIndex = i;
      break;
    }
  }
  if (reachedIndex <= 0) return null;
  for (let i = reachedIndex; i < history.length; i++) {
    if (history[i]!.message.role === "user" && i > 0) return i;
  }
  return null;
}

/** Everything a compaction run needs, decided before the summarize call. */
export type PiCompactionPlan = {
  entriesToSummarize: PiHistoryEntry[];
  /** Index (into history at plan time) of the first entry kept verbatim. */
  firstKeptIndex: number;
  previousSummary: string | undefined;
  tokensBefore: number;
};

export function planCompaction(state: PiState): PiCompactionPlan | null {
  const cutIndex = findCompactionCutIndex(state.history, state.compactionSettings.keepRecentTokens);
  if (cutIndex === null) return null;
  const dropped = state.history.slice(0, cutIndex);
  const previousSummary =
    dropped[0]?.message.role === "compactionSummary" ? dropped[0].message.summary : undefined;
  const entriesToSummarize = previousSummary === undefined ? dropped : dropped.slice(1);
  // Nothing but the previous summary would be dropped: re-summarizing it
  // gains no tokens, so there is no useful compaction.
  if (entriesToSummarize.length === 0) return null;
  return {
    entriesToSummarize,
    firstKeptIndex: cutIndex,
    previousSummary,
    tokensBefore: estimatePiContextTokens(state.history),
  };
}

/**
 * The compaction-request decision for a settled idle state: an unrecovered
 * overflow error compacts unconditionally (once), a context estimate past
 * `contextWindow - reserveTokens` compacts proactively — provided a previous
 * attempt has not already failed for this same history tail and a useful cut
 * exists. Pure so the whole policy is unit-testable.
 */
export function compactionToRequest(
  state: PiState,
): { reason: PiCompactionReason; tailOffset: number } | null {
  const tailOffset = state.history.at(-1)?.offset ?? 0;
  if (state.compactionFailedForTailOffset === tailOffset) return null;
  const overflow = needsOverflowRecovery(state);
  const threshold =
    state.compactionSettings.enabled &&
    estimatePiContextTokens(state.history) >
      state.contextWindow - state.compactionSettings.reserveTokens;
  if (!overflow && !threshold) return null;
  if (planCompaction(state) === null) return null;
  return { reason: overflow ? "overflow" : "threshold", tailOffset };
}

/**
 * The tool calls of the current executing-tools run that still have no
 * recorded result, with their names resolved from the assistant message that
 * issued them. What a restarted instance must answer synthetically.
 */
export function lostToolCalls(state: PiState): { toolCallId: string; toolName: string }[] {
  if (state.run.phase !== "executing-tools") return [];
  const { assistantOffset, pendingToolCallIds } = state.run;
  const assistantEntry = state.history.find((entry) => entry.offset === assistantOffset);
  const toolCalls =
    assistantEntry?.message.role === "assistant"
      ? assistantEntry.message.content.filter(
          (block): block is PiToolCall => block.type === "toolCall",
        )
      : [];
  return pendingToolCallIds.map((toolCallId) => ({
    toolCallId,
    toolName: toolCalls.find((call) => call.id === toolCallId)?.name ?? "unknown",
  }));
}

/** pi's summarization system prompt, verbatim. */
export const PI_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const PI_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const PI_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * The summarize request. Deviation from pi: the slice to summarize is rendered
 * as one plain-text transcript in a single user message (pi replays it as real
 * messages); iterative updating via <previous-summary> is preserved.
 */
export function buildSummarizationRequest(input: {
  plan: PiCompactionPlan;
  state: PiState;
}): Omit<PiLlmRequest, "tools"> {
  const transcript = input.plan.entriesToSummarize
    .map(({ message }) => {
      switch (message.role) {
        case "user":
          return `[user]\n${message.content}`;
        case "assistant":
          return `[assistant]\n${message.content
            .map((block) =>
              block.type === "text"
                ? block.text
                : block.type === "toolCall"
                  ? `<tool call: ${block.name}(${JSON.stringify(block.arguments)})>`
                  : "",
            )
            .filter((text) => text !== "")
            .join("\n")}`;
        case "toolResult":
          return `[tool result: ${message.toolName}]\n${message.content}`;
        case "compactionSummary":
          return `[earlier summary]\n${message.summary}`;
      }
    })
    .join("\n\n");
  const instruction =
    input.plan.previousSummary === undefined
      ? PI_SUMMARIZATION_PROMPT
      : `<previous-summary>\n${input.plan.previousSummary}\n</previous-summary>\n\n${PI_UPDATE_SUMMARIZATION_PROMPT}`;
  return {
    messages: [{ role: "user", content: `${transcript}\n\n${instruction}` }],
    model: input.state.model,
    systemPrompt: PI_SUMMARIZATION_SYSTEM_PROMPT,
  };
}

// =============================================================================
// Overflow detection — a subset of pi's overflow.ts error-message catalog.
// =============================================================================

const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /context.{0,20}(length|window)/i,
  /exceeds? the (available )?context/i,
  /too many tokens/i,
  /input length and `max_tokens` exceed/i,
  /greater than the context length/i,
  /exceeded model token limit/i,
];
const NON_OVERFLOW_PATTERNS = [/rate.?limit/i, /quota/i, /billing/i, /overloaded/i];

export function isOverflowErrorMessage(errorMessage: string): boolean {
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * pi's overflow recovery trigger: the last assistant response failed with a
 * context-overflow error and the one-shot compact-and-retry has not been spent.
 */
function needsOverflowRecovery(state: PiState): boolean {
  if (state.overflowRecoveryAttempted) return false;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const message = state.history[i]!.message;
    if (message.role !== "assistant") continue;
    return (
      message.stopReason === "error" &&
      message.errorMessage !== undefined &&
      isOverflowErrorMessage(message.errorMessage)
    );
  }
  return false;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
