/**
 * AgentCore - High-level Design
 *
 * • Unit-testable in production - runs in durable object context with injected dependencies:
 *   - Event storage/retrieval
 *   - OpenAI client
 *   - Background task execution
 *   - Tool implementations
 *
 * • Event sourcing architecture:
 *   - Primary interface: addEvent() / addEvents()
 *   - Events with triggerLLMRequest: true trigger OpenAI API calls
 *   - All state derived from event log
 *
 * • Reducer-based state management:
 *   - Core reducer handles built-in events
 *   - Pluggable slice reducers extend functionality
 *   - See ./slices/ folder for examples
 *
 * • LLM requests use reduced state computed from full event history
 */

import { Mutex } from "async-mutex";
import type { OpenAI } from "openai";
import type {
  ResponseFunctionToolCall,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.mjs";
import { z } from "zod/v4";
import { mergeDeep } from "remeda";
import { stripNonSerializableProperties } from "../utils/schema-helpers.ts";
import type { JSONSerializable } from "../utils/type-helpers.ts";
import { deepCloneWithFunctionRefs } from "./deep-clone-with-function-refs.ts";
import {
  AgentCoreEvent,
  AgentCoreEventInput,
  type AugmentedCoreReducedState,
  CORE_INITIAL_REDUCED_STATE,
  type CoreReducedState,
} from "./agent-core-schemas.js";
import { renderPromptFragment } from "./prompt-fragments.js";
import { MCPServer, type RuntimeTool, type ToolSpec } from "./tool-schemas.ts";
import { evaluateContextRuleMatchers } from "./context.ts";

/**
 * AgentCoreSliceSpec – single generic object describing a slice.
 * All properties are optional so slice authors only specify what they need.
 */
export interface AgentCoreSliceSpec {
  /** Additional state injected by this slice */
  SliceState?: object;
  /** Zod schema for stored events */
  EventSchema?: z.ZodType;
  /** Zod schema for *input* events. If undefined the EventSchema (or core+deps union) is used */
  EventInputSchema?: z.ZodType;
  /** Extra dependencies required by the slice reducer */
  SliceDeps?: unknown;
  /** Compile-time list of slice dependencies */
  DependsOnSlices?: readonly AgentCoreSlice<any>[];
}

// Helper conditional extraction utilities for the spec object ----------------

// prettier-ignore
export type SliceStateOf<Spec> = Spec extends { SliceState: infer S }
  ? S extends object
    ? S
    : Record<never, never>
  : Record<never, never>;
// prettier-ignore
export type SliceDepsOf<Spec> = Spec extends { SliceDeps: infer D } ? D : unknown;
// prettier-ignore
export type SliceEventSchemaOf<Spec> = Spec extends { EventSchema: infer Ev }
  ? Ev extends z.ZodType
    ? Ev
    : never
  : never;
// prettier-ignore
export type SliceEventInputSchemaOf<Spec> = Spec extends { EventInputSchema: infer EvIn }
  ? EvIn extends z.ZodType
    ? EvIn
    : never
  : SliceEventSchemaOf<Spec>; // default
// prettier-ignore
export type SliceDependsOnOf<Spec> = Spec extends { DependsOnSlices: infer Deps }
  ? Deps extends readonly AgentCoreSlice[]
    ? Deps
    : []
  : [];

// Helper: tuple starting with this slice followed by its declared dependencies.
// Ensures the resulting AgentCore type parameter always contains the current
// slice (for its own events) plus any slices it depends on.
// Using a conditional type keeps the tuple variadic-safe when there are no deps.
export type SelfAndDeps<Spec extends AgentCoreSliceSpec> =
  SliceDependsOnOf<Spec> extends infer D
    ? D extends readonly AgentCoreSlice[]
      ? [AgentCoreSlice<Spec>, ...D]
      : [AgentCoreSlice<Spec>]
    : [AgentCoreSlice<Spec>];

// Minimal subset of AgentCore exposed to slice reducers – gives strong typing
// for state/events/addEvent(s) while avoiding incompatibility issues with the
// concrete AgentCore instance passed in at runtime.
export type AgentCoreMinimal<Spec extends AgentCoreSliceSpec> = Pick<
  AgentCore<SelfAndDeps<Spec>>, // ensures the slice itself + its deps are included
  "addEvent" | "addEvents" | "state" | "events"
>;

// Helper to extract the Spec generic from an AgentCoreSlice
export type SliceSpecOf<S> = S extends AgentCoreSlice<infer Sp> ? Sp : never;

// Type-level error for conflicting dep names (kept from old implementation)
export type CheckDepsConflict<T> =
  T extends Record<string, any>
    ? {
        [K in keyof T]: K extends keyof Omit<T, K>
          ? T[K] extends Omit<T, K>[K]
            ? T[K]
            : never // conflict
          : T[K];
      }
    : T;

// -----------------------------------------------------------------------------
// Core public types – every slice provides the same quartet of types so they can
// be unioned by AgentCore generics.
// -----------------------------------------------------------------------------

export interface AgentCoreDeps {
  /** Persist the full event array whenever it changes – safe to store by ref */
  storeEvents(events: ReadonlyArray<AgentCoreEvent>): void;
  /** Run a background task (e.g. DurableObject ctx.waitUntil) */
  background(fn: () => Promise<void>): void;
  /** Lazily construct an OpenAI client */
  getOpenAIClient(): Promise<OpenAI>;
  /** Batch resolve tool specs to runtime implementations */
  toolSpecsToImplementations: (specs: ToolSpec[]) => RuntimeTool[];
  /** Upload a file and return its ID and metadata - used for agent-to-user file sharing */
  uploadFile?: (data: {
    content: ReadableStream;
    filename: string;
    contentLength?: number;
    mimeType?: string;
    metadata?: Record<string, any>;
  }) => Promise<{
    fileId: string;
    openAIFileId: string;
    originalFilename?: string;
    size?: number;
    mimeType?: string;
  }>;
  /** Convert an iterate file ID to a public download URL */
  turnFileIdIntoPublicURL?: (fileId: string) => string;
  /** Forward streaming chunks to live clients (optional) */
  onLLMStreamResponseStreamingChunk?: (chunk: ResponseStreamEvent) => void;
  /**
   * Optional callback that will be invoked once for **every** event that is
   * successfully added by a single `addEvents()` call **after** the internal
   * state has been updated and the events have been persisted.
   *
   * This allows host environments (e.g. Durable Objects) to react to newly
   * added events in a type-safe way (e.g. to send events to posthog)
   */
  onEventAdded?: <E, S>(payload: { event: E; reducedState: S }) => void;
  /**
   * Optional hook to collect context items (prompts and tools) that should be
   * included in LLM requests. Called right before making each LLM request.
   */
  getRuleMatchData: (state: CoreReducedState) => unknown;
  /**
   * Optional hook to get the final redirect URL for any authorization flows.
   */
  getFinalRedirectUrl?: <S>(payload: {
    durableObjectInstanceName: string;
    reducedState: S;
  }) => Promise<string | undefined>;
  /** Provided console instance */
  console: Console;
}

export type AgentCoreState = CoreReducedState;
// Re-export event types from schemas for convenience
export type { AgentCoreEvent, AgentCoreEventInput };

// ---------------------------------------------------------------------------
// Updated AgentCoreSlice interface -----------------------------------------
// ---------------------------------------------------------------------------

export interface AgentCoreSlice<Spec extends AgentCoreSliceSpec = AgentCoreSliceSpec> {
  name: string;
  /** Optional slice-local initial state */
  initialState?: SliceStateOf<Spec>;
  /** Zod schema for stored events (required when slice defines events) */
  eventSchema: SliceEventSchemaOf<Spec>;
  /** Zod schema for input events (defaults to `eventSchema`) */
  eventInputSchema: SliceEventInputSchemaOf<Spec>;
  /** Async reducer returning partial state updates */
  reduce(
    state: Readonly<
      CoreReducedState<z.input<SliceEventInputSchemaOf<Spec>>> &
        SliceStateOf<Spec> &
        MergedStateForSlices<SliceDependsOnOf<Spec>, z.input<SliceEventInputSchemaOf<Spec>>>
    >,
    deps: AgentCoreDeps &
      SliceDepsOf<Spec> &
      MergedDepsForSlices<SliceDependsOnOf<Spec>> & { agentCore: AgentCoreMinimal<Spec> },
    event: AgentCoreEvent | z.infer<SliceEventSchemaOf<Spec>>,
  ): Partial<
    CoreReducedState<z.input<SliceEventInputSchemaOf<Spec>>> &
      SliceStateOf<Spec> &
      MergedStateForSlices<SliceDependsOnOf<Spec>, z.input<SliceEventInputSchemaOf<Spec>>>
  > | void;
}

// -----------------------------------------------------------------------------
// Helper type machinery (refactored to spec object) -------------------------
// -----------------------------------------------------------------------------

type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

// Replace StateOf/DepsOf with new implementations
export type MergedStateForSlices<
  Sls extends readonly AgentCoreSlice[],
  InputEvents = AgentCoreEventInput,
> = CoreReducedState<InputEvents> & UnionToIntersection<SliceStateOf<SliceSpecOf<Sls[number]>>>;

export type MergedDepsForSlices<Sls extends readonly AgentCoreSlice[]> = AgentCoreDeps &
  CheckDepsConflict<UnionToIntersection<SliceDepsOf<SliceSpecOf<Sls[number]>>>>;

// Raw schema extraction types (event schemas)
export type MergedEventSchemaForSlices<Sls extends readonly AgentCoreSlice[]> =
  | typeof AgentCoreEvent
  | (Sls[number] extends infer T
      ? T extends AgentCoreSlice<any>
        ? SliceEventSchemaOf<SliceSpecOf<T>>
        : never
      : never);

export type MergedEventInputSchemaForSlices<Sls extends readonly AgentCoreSlice[]> =
  | typeof AgentCoreEventInput
  | (Sls[number] extends infer T
      ? T extends AgentCoreSlice<any>
        ? SliceEventInputSchemaOf<SliceSpecOf<T>>
        : never
      : never);

export type MergedEventForSlices<Sls extends readonly AgentCoreSlice[]> =
  | AgentCoreEvent
  | (Sls[number] extends infer T
      ? T extends AgentCoreSlice<any>
        ? z.infer<SliceEventSchemaOf<SliceSpecOf<T>>>
        : never
      : never);

export type MergedEventInputForSlices<Sls extends readonly AgentCoreSlice[]> =
  | AgentCoreEventInput
  | (Sls[number] extends infer T
      ? T extends AgentCoreSlice<any>
        ? z.input<SliceEventInputSchemaOf<SliceSpecOf<T>>>
        : never
      : never);

// -----------------------------------------------------------------------------
// AgentCore class – parameterised by an immutable tuple of slices.
// -----------------------------------------------------------------------------

export interface AgentCoreConstructorOptions<
  Slices extends readonly AgentCoreSlice[],
  CombinedDeps extends MergedDepsForSlices<Slices>,
> {
  deps: CombinedDeps;
  slices: Slices;
}

type ResponsesAPIParams = Parameters<OpenAI["responses"]["stream"]>[0];

export class AgentCore<
  Slices extends readonly AgentCoreSlice[] = [],
  CoreSlices extends readonly AgentCoreSlice[] = [],
> {
  // Combined state (core + slices) ------------------------------------------
  // Each AgentCore instance must get its own copy of array/object fields to avoid
  // accidental shared mutable state between different durable object instances.
  // We therefore create fresh copies for the problematic properties.
  private _state = {
    ...CORE_INITIAL_REDUCED_STATE,
  } as MergedStateForSlices<Slices> & MergedStateForSlices<CoreSlices>;

  recordRawRequest = true;

  private augmentState(
    inputState: typeof this._state,
  ): MergedStateForSlices<Slices> & MergedStateForSlices<CoreSlices> & AugmentedCoreReducedState {
    const next: AugmentedCoreReducedState = {
      ...inputState,
      runtimeTools: [],
      ephemeralPromptFragments: {},
      toolSpecs: [],
      mcpServers: [],
      rawKeys: Object.keys(inputState),
    };

    const enabledContextRules = Object.values(next.contextRules).filter((contextRule) => {
      const matchAgainst = this.deps.getRuleMatchData(next);
      return evaluateContextRuleMatchers({ contextRule, matchAgainst });
    });
    const updatedContextRulesTools = enabledContextRules.flatMap((rule) => rule.tools || []);
    next.namespacedRuntimeTools = {
      ...next.namespacedRuntimeTools,
      "context-rule": this.deps.toolSpecsToImplementations(updatedContextRulesTools),
    };
    next.toolSpecs = [...next.toolSpecs, ...updatedContextRulesTools];
    next.mcpServers = [
      ...next.mcpServers,
      ...enabledContextRules.flatMap((rule) => rule.mcpServers || []),
    ];

    // todo: figure out how to deduplicate these in case of name collisions?
    next.runtimeTools = Object.values(next.namespacedRuntimeTools).flat();
    return next as unknown as MergedStateForSlices<Slices> &
      MergedStateForSlices<CoreSlices> &
      AugmentedCoreReducedState;
  }

  get state() {
    return this.augmentState(this._state);
  }

  // Event log ---------------------------------------------------------------
  private _events: MergedEventForSlices<Slices>[] = [];
  get events(): ReadonlyArray<MergedEventForSlices<Slices>> {
    return this._events;
  }

  // Dependencies & slices ---------------------------------------------------
  private readonly deps: MergedDepsForSlices<Slices>;
  private readonly slices: Readonly<Slices>;

  private readonly _mutex = new Mutex();

  // Combined Zod schema for validating any incoming event
  private readonly combinedEventSchema: z.ZodType<AgentCoreEvent>;
  // Combined Zod schema for validating input events (with optional fields)
  private readonly combinedEventInputSchema: z.ZodType<AgentCoreEventInput>;

  // Track initialization state
  private _initialized = false;

  // Track seen idempotency keys for deduplication
  private readonly _seenIdempotencyKeys = new Set<string>();

  constructor(options: AgentCoreConstructorOptions<Slices, MergedDepsForSlices<Slices>>) {
    const { deps, slices } = options;

    // Always ensure console exists
    this.deps = {
      ...deps,
      console: deps.console ?? console,
    };
    this.slices = slices;

    // Initialize slice states and merge initial state into core state
    for (const slice of slices) {
      if (slice.initialState) {
        this._state = { ...this._state, ...slice.initialState };
      }
    }

    // Build combined event schemas: core first, then slice schemas
    const sliceSchemas = slices.map((s) => s.eventSchema);
    this.combinedEventSchema = sliceSchemas.length
      ? z.union([AgentCoreEvent, ...sliceSchemas])
      : AgentCoreEvent;

    // Build combined input event schema
    const sliceInputSchemas = slices.map((s) => s.eventInputSchema);
    this.combinedEventInputSchema = sliceInputSchemas.length
      ? z.union([AgentCoreEventInput, ...sliceInputSchemas])
      : AgentCoreEventInput;
  }

  // -------------------------------------------------------------------------
  // Public API – event ingestion
  // -------------------------------------------------------------------------

  /**
   * Helper method to check if an LLM request is currently in progress
   */
  llmRequestInProgress(): boolean {
    return this._state.llmRequestStartedAtIndex !== null;
  }

  /**
   * Initialize the agent with existing events from storage and replay them through reducers.
   * This method can only be called once per agent instance.
   * @throws Error if called more than once
   */
  async initializeWithEvents(existing: AgentCoreEvent[]): Promise<void> {
    // Acquire mutex to ensure thread safety
    const release = await this._mutex.acquire();
    try {
      // Check if already initialized
      if (this._initialized) {
        throw new Error(
          "[AgentCore] initializeWithEvents called multiple times - agent is already initialized",
        );
      }

      this.deps.console.debug(`[AgentCore] Initializing with ${existing.length} existing events`);

      // Clear current state
      this._events = [];
      this._state = { ...CORE_INITIAL_REDUCED_STATE } as typeof this._state;

      // Re-initialize slice states
      for (const slice of this.slices) {
        if (slice.initialState) {
          this._state = { ...this._state, ...slice.initialState };
        }
      }

      // Process all events with validation
      if (existing.length > 0) {
        // Process events one by one to maintain state consistency
        for (const event of existing) {
          // Validate the event
          const validated = this.combinedEventSchema.parse(event);

          // Track idempotency key if present
          if (validated.idempotencyKey) {
            this._seenIdempotencyKeys.add(validated.idempotencyKey);
          }

          // TODO: This pattern of push-then-update could be cleaned up to match addEvents pattern
          this._events.push(validated);
          this._state = this.runReducersOnSingleEvent(this._state, validated);
        }
      }

      // Mark as initialized
      this._initialized = true;

      // Add initialized with events event
      const initializedEvent = {
        type: "CORE:INITIALIZED_WITH_EVENTS",
        data: {
          eventCount: existing.length,
        },
        metadata: {},
        eventIndex: this._events.length,
        createdAt: new Date().toISOString(),
        triggerLLMRequest: false,
      } as const;
      // TODO: This pattern of push-then-update could be cleaned up to match addEvents pattern
      this._events.push(initializedEvent);
      this._state = this.runReducersOnSingleEvent(this._state, initializedEvent);

      // Invoke callback for initialized event
      if (this.deps.onEventAdded) {
        this.deps.onEventAdded({ event: initializedEvent, reducedState: { ...this._state } });
      }

      // Always store events after initialization (before potentially starting background tasks)
      this.deps.storeEvents(this._events);
    } finally {
      release();
    }

    // Check if we need to resume an LLM request that was interrupted
    // Important: This must be done AFTER releasing the mutex to avoid deadlock
    // when the background task fails and tries to call addEvents()
    if (this.llmRequestInProgress()) {
      const requestIndex = this._state.llmRequestStartedAtIndex;
      if (requestIndex !== null) {
        this.deps.console.warn(
          `[AgentCore] Resuming interrupted LLM request at index ${requestIndex} - indicates DO crash during request`,
        );
        this.runLLMRequestInBackground(requestIndex, this.getResponsesAPIParams());
      }
    }
  }

  /** btw this returns an array */
  addEvent(
    event: MergedEventInputForSlices<Slices> | MergedEventInputForSlices<CoreSlices>,
  ): { eventIndex: number }[] {
    return this.addEvents([event]);
  }

  /**
   * Atomically add one or more events to the agent. This is the _primary external interface_ of the agent.
   *
   * The function
   *  - makes sure the events conform to this agent's event schema (either the core events or one of the slice's event schemas)
   *  - add createdAt and eventIndex props
   *  - run all reducers to update the agent state (the core agent reducer, as well as each slice's reducer in order)
   *
   * If an event has triggerLLMRequest: true, then any ongoing LLM request will be cancelled and a new one started in the background.
   *
   * addEvents calls are strictly serialised - only one batch of events can be added at any point in time (protected by mutex)
   *
   * Nonetheless, it is an async function, becaue the reducers can be async
   * (e.g. to query some service to find out what the input schema for a certain trpc procedure tool is)
   */
  addEvents(
    events: MergedEventInputForSlices<Slices>[] | MergedEventInputForSlices<CoreSlices>[],
  ): { eventIndex: number }[] {
    // Check if initialized
    if (!this._initialized) {
      throw new Error("[AgentCore] Cannot add events before calling initializeWithEvents");
    }

    try {
      const originalEvents = [...this._events];
      const originalState = { ...this._state };
      const eventsAddedThisBatch: Array<{
        event: MergedEventForSlices<Slices>;
        reducedState: MergedStateForSlices<Slices>;
      }> = [];

      try {
        // Parse all events first
        for (const ev of events) {
          // Check for idempotency key deduplication
          if (ev.idempotencyKey && this._seenIdempotencyKeys.has(ev.idempotencyKey)) {
            this.deps.console.warn(
              `[AgentCore] Skipping duplicate event with idempotencyKey: ${ev.idempotencyKey}`,
            );
            continue; // Skip this event
          }

          const parsed = this.combinedEventInputSchema.parse({
            ...ev,
            eventIndex: this._events.length,
            createdAt: ev.createdAt ?? new Date().toISOString(),
          }) as MergedEventForSlices<Slices>;

          // Add idempotency key to seen set if present
          if (parsed.idempotencyKey) {
            this._seenIdempotencyKeys.add(parsed.idempotencyKey);
          }

          // Add to _events for now in case that is used in a reducer - but if any errors occur, we'll roll it back
          this._events.push(parsed);

          // run core reducer and all slice reducers in sequence to update the state
          this._state = this.runReducersOnSingleEvent(this._state, parsed);

          parsed.metadata ||= {};

          // Store the event and its reduced state for later callback invocation
          eventsAddedThisBatch.push({ event: parsed, reducedState: { ...this._state } });
        }

        // Only invoke callbacks after we're sure the batch succeeded
        if (this.deps.onEventAdded) {
          for (const { event, reducedState } of eventsAddedThisBatch) {
            this.deps.onEventAdded({ event, reducedState });
          }
        }
      } catch (err) {
        // Rollback both events and state to before the batch
        this._events = originalEvents;
        this._state = originalState;

        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorStack = err instanceof Error ? (err.stack ?? "") : "";

        const errorEvent = {
          type: "CORE:INTERNAL_ERROR",
          data: {
            error: `Error while calling addEvents: ${errorMessage}\nEvents batch: ${JSON.stringify(events)}`,
            stack: errorStack,
          },
          metadata: {},
          eventIndex: this._events.length,
          createdAt: new Date().toISOString(),
          triggerLLMRequest: false,
        } as const;

        // Add the error event to the events array
        // TODO: This pattern of push-then-update could be cleaned up to match addEvents pattern
        this._events.push(errorEvent);

        // Run reducers on the error event itself
        // This ensures the error event is properly processed
        this._state = this.runReducersOnSingleEvent(this._state, errorEvent);

        // Invoke callback for error event
        if (this.deps.onEventAdded) {
          this.deps.onEventAdded({ event: errorEvent, reducedState: { ...this._state } });
        }

        throw err;
      }

      // Handle LLM request triggering if needed
      if (this._state.triggerLLMRequest) {
        // Check if paused before starting
        if (this._state.paused) {
          this.deps.console.warn("[AgentCore] LLM request trigger ignored - requests are paused");
        } else {
          // Check if we need to cancel an in-flight request
          // This happens after processing all events in the batch, so if a batch contains
          // both a trigger event and an LLM_REQUEST_END event (like when makeLLMRequest
          // processes a tool call), the llmRequestStartedAtIndex will already be cleared
          // and we won't cancel. This is intentional - when an LLM request returns a tool call,
          // makeLLMRequest adds all events for that request as one batch (output event,
          // tool call input/output, and LLM request end), so we don't want to cancel.
          if (this.llmRequestInProgress()) {
            this.deps.console.warn(
              "[AgentCore] Cancelling in-flight request – new trigger received",
            );
            // Add a cancel event
            const cancelEvent = {
              type: "CORE:LLM_REQUEST_CANCEL",
              data: { reason: "superseded" },
              metadata: {},
              eventIndex: this._events.length,
              createdAt: new Date().toISOString(),
              triggerLLMRequest: false,
            } as const;
            // TODO: This pattern of push-then-update could be cleaned up to match addEvents pattern
            this._events.push(cancelEvent);
            this._state = this.runReducersOnSingleEvent(this._state, cancelEvent);

            // Invoke callback for cancel event
            if (this.deps.onEventAdded) {
              this.deps.onEventAdded({ event: cancelEvent, reducedState: { ...this._state } });
            }
          }

          // Add LLM_REQUEST_START event
          const responsesAPIParams = this.getResponsesAPIParams();
          const startEvent = {
            type: "CORE:LLM_REQUEST_START",
            eventIndex: this._events.length,
            createdAt: new Date().toISOString(),
            data: this.recordRawRequest ? { rawRequest: responsesAPIParams } : {},
            metadata: {},
            triggerLLMRequest: false,
          } satisfies AgentCoreEvent;
          // TODO: This pattern of push-then-update could be cleaned up to match addEvents pattern
          this._events.push(startEvent);
          this._state = this.runReducersOnSingleEvent(this._state, startEvent);

          // Invoke callback for start event
          if (this.deps.onEventAdded) {
            this.deps.onEventAdded({ event: startEvent, reducedState: { ...this._state } });
          }

          // Store the request index for this LLM call
          const thisRequestIndex = startEvent.eventIndex;

          // Execute LLM call in background
          this.runLLMRequestInBackground(thisRequestIndex, responsesAPIParams);
        }
      }
      return eventsAddedThisBatch.map((e) => e.event);
    } finally {
      // Finally, make sure the callback to actually store all the new events is called
      // TODO fix this
      this.deps.storeEvents(this._events);
    }
  }

  // -------------------------------------------------------------------------
  // Reducer execution helpers
  // -------------------------------------------------------------------------

  private runReducersOnSingleEvent(
    currentState: MergedStateForSlices<Slices>,
    event: MergedEventForSlices<Slices>,
  ) {
    // First run built-in core reducer
    let newState = this.reduceCore(currentState, event) as MergedStateForSlices<Slices>;

    // Then every slice reducer
    for (const slice of this.slices) {
      const update = slice.reduce(newState, { ...this.deps, agentCore: this }, event);
      if (update) {
        newState = { ...newState, ...update };
      }
    }

    return deepCloneWithFunctionRefs(newState);
  }

  private reduceCore(state: CoreReducedState, event: AgentCoreEvent): CoreReducedState {
    const next: CoreReducedState = { ...state };

    // Any event with triggerLLMRequest: true sets the state flag to true
    // UNLESS we are paused
    if (event.triggerLLMRequest && !state.paused) {
      next.triggerLLMRequest = true;
    }

    if (!event.type.startsWith("CORE:")) {
      return next; // ignore slice events but keep triggerLLMRequest update
    }

    switch (event.type) {
      case "CORE:SET_SYSTEM_PROMPT":
        next.systemPrompt = event.data.prompt;
        break;

      case "CORE:ADD_CONTEXT_RULES": {
        next.contextRules = {
          ...next.contextRules,
          ...Object.fromEntries(event.data.rules.map((item) => [item.id, item])),
        };
        break;
      }

      case "CORE:SET_MODEL_OPTS":
        next.modelOpts = event.data;
        break;

      case "CORE:SET_METADATA":
        next.metadata = mergeDeep(next.metadata, event.data);
        break;

      case "CORE:LLM_INPUT_ITEM":
        if (event.data) {
          const item = event.data;
          // If it's an assistant message, ensure it has an id
          if (item.type === "message" && item.role === "assistant" && !item.id) {
            const itemWithId = {
              ...item,
            };
            // @ts-expect-error - TODO fix this
            next.inputItems = [...next.inputItems, itemWithId];
          } else {
            // @ts-expect-error - TODO fix this
            next.inputItems = [...next.inputItems, item];
          }
        }
        break;

      case "CORE:LLM_OUTPUT_ITEM":
        // LLM output items become input items next time
        // Special note about data.type == "reasoning" items
        // When using GPT-5, reasoning items are always linked to the immediately
        // next input item and we MUST NEVER make a subsequent LLM request with
        // just one of the two!
        next.inputItems.push(event.data);
        break;

      case "CORE:LLM_REQUEST_START":
        next.llmRequestStartedAtIndex = event.eventIndex;
        next.triggerLLMRequest = false; // Consume the trigger
        break;

      case "CORE:LOCAL_FUNCTION_TOOL_CALL": {
        // Add the function call itself and the result
        const res = event.data.result;
        let outputStr: string;
        if (res.success === true) {
          outputStr = typeof res.output === "string" ? res.output : JSON.stringify(res.output);
        } else {
          outputStr = res.error;
        }

        const callOutputItem = {
          type: "function_call_output",
          call_id: event.data.call.call_id,
          output: outputStr || "", // must be a string or openai barfs
        } satisfies OpenAI.Responses.ResponseInputItem;

        if (event.data.associatedReasoningItemId) {
          // To avoid the dreaded `Item 'fc_...' of type 'function_call' was provided without its required 'reasoning' item: 'rs_...'.` error,
          // we need to insert input items in the (undocumented) right order that OpenAI expects.
          // If you got [reasoning, function_call, function_call] in your last request, your next request must be
          //            [reasoning, function_call, function_call, function_call_output, function_call_output]
          // and NOT    [reasoning, function_call, function_call_output, function_call, function_call_output]
          // So search for the associated reasoning item's index, then set the sort score of the function call and output items to be just after it.
          // Use a small delta to ensure they go before whatever items are already in the array, and rely on stable sorting to make sure the function calls
          // are inserted in the right order.
          const reasoningIndex = next.inputItems.findIndex(
            (i) => i.type === "reasoning" && i.id === event.data.associatedReasoningItemId,
          );
          if (reasoningIndex === -1) {
            throw new Error(
              `CORE:LOCAL_FUNCTION_TOOL_CALL event ${event.data.call.id} missing associated reasoning item in input items, request would fail: ${event.data.associatedReasoningItemId}`,
            );
          }

          next.inputItems.push(
            { ...event.data.call, getSortScore: () => reasoningIndex + 0.1 },
            { ...callOutputItem, getSortScore: () => reasoningIndex + 0.2 },
          );
        } else {
          next.inputItems.push(event.data.call, callOutputItem);
        }
        break;
      }

      case "CORE:LLM_REQUEST_END":
        next.llmRequestStartedAtIndex = null;
        break;

      case "CORE:LLM_REQUEST_CANCEL":
        next.llmRequestStartedAtIndex = null;
        break;

      case "CORE:PAUSE_LLM_REQUESTS":
        next.paused = true;
        next.triggerLLMRequest = false; // Clear any pending trigger when pausing
        break;

      case "CORE:RESUME_LLM_REQUESTS":
        next.paused = false;
        // Note: If triggerLLMRequest is true when resuming, the next addEvents call
        // will handle starting the request
        break;

      case "CORE:FILE_SHARED": {
        const { direction, iterateFileId, originalFilename, mimeType, openAIFileId } = event.data;
        this.deps.console.log("FILE_SHARED", event);

        // Require OpenAI file ID for sharing files with the agent
        if (!openAIFileId) {
          throw new Error(
            `CORE:FILE_SHARED event missing required OpenAI file ID for file ${iterateFileId}`,
          );
        }

        // Determine content type based on file extension or MIME type
        const isImage =
          mimeType?.startsWith("image/") ||
          originalFilename?.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i);

        // Create appropriate content item based on file type
        const contentItem = isImage
          ? {
              type: "input_image" as const,
              file_id: openAIFileId,
              detail: "auto" as const,
            }
          : {
              type: "input_file" as const,
              file_id: openAIFileId,
            };

        // IFF the image was generated by openai using its builtin tool,
        // we need to store and then inject the original output item
        // Otherwise we might get an error, in case a linked reasoning
        // output item was produced just
        const inputFileMessage = event.data.openAIOutputItemWithoutResult || {
          type: "message" as const,
          role: "user" as const,
          content: [contentItem],
        };
        // Use the injected function or default implementation
        const downloadUrl = this.deps.turnFileIdIntoPublicURL
          ? this.deps.turnFileIdIntoPublicURL(iterateFileId)
          : `https://you-must-inject-this-into-agent-core.com/${iterateFileId}`;

        // build developer messages for both directions so that the agent can reference iterateFileId in subsequent tool calls
        const developerText = renderPromptFragment([
          direction === "from-agent-to-user"
            ? "Note: The previous file was something you created as the result of a tool call. Use the download URL below to share this file."
            : null,
          `The iterateFileId for the above file is ${iterateFileId}. You may need this when using the file in other tool calls. Download: ${downloadUrl}`,
        ]);

        const developerMessage = {
          type: "message" as const,
          role: "developer" as const,
          content: [
            {
              type: "input_text" as const,
              text: developerText,
            },
          ],
        };

        next.inputItems = [...next.inputItems, inputFileMessage, developerMessage];
        break;
      }

      case "CORE:PARTICIPANT_JOINED": {
        const { internalUserId, email, displayName, externalUserMapping } = event.data;
        const participant = {
          internalUserId,
          joinedAt: event.createdAt,
          lastActiveAt: event.createdAt,
          email,
          displayName,
          externalUserMapping,
        };
        next.participants = {
          ...next.participants,
          [internalUserId]: participant,
        };

        // Remove from mentioned participants if they were mentioned before joining
        if (next.mentionedParticipants[internalUserId]) {
          const { [internalUserId]: _, ...remainingMentioned } = next.mentionedParticipants;
          next.mentionedParticipants = remainingMentioned;
        }

        next.inputItems.push({
          type: "message" as const,
          role: "developer" as const,
          content: [
            {
              type: "input_text",
              text: `User ${displayName} (id: ${internalUserId}, email: ${email}) joined the conversation`,
            },
          ],
        });
        break;
      }

      case "CORE:PARTICIPANT_LEFT": {
        const { internalUserId } = event.data;
        const displayName = next.participants[internalUserId]?.displayName || "unknown name";
        const email = next.participants[internalUserId]?.email || "unknown";
        const { [internalUserId]: _, ...remaining } = next.participants;
        next.participants = remaining;
        next.inputItems.push({
          type: "message" as const,
          role: "developer" as const,
          content: [
            {
              type: "input_text",
              text: `User ${displayName} (id: ${internalUserId}, email: ${email}) left the conversation`,
            },
          ],
        });
        break;
      }

      case "CORE:PARTICIPANT_MENTIONED": {
        const { internalUserId, email, displayName, externalUserMapping } = event.data;
        // Don't add if already an active participant
        if (next.participants[internalUserId]) {
          break;
        }
        // Don't add if already mentioned
        if (next.mentionedParticipants[internalUserId]) {
          break;
        }

        const mentionedParticipant = {
          internalUserId,
          joinedAt: event.createdAt,
          lastActiveAt: event.createdAt,
          email,
          displayName,
          externalUserMapping,
        };
        next.mentionedParticipants = {
          ...next.mentionedParticipants,
          [internalUserId]: mentionedParticipant,
        };
        break;
      }

      case "CORE:INTERNAL_ERROR":
      case "CORE:INITIALIZED_WITH_EVENTS":
      case "CORE:LOG":
        // Just log, no state change needed
        break;

      default:
        event satisfies never;
        // Unknown event types are ignored (could be slice events)
        this.deps.console.warn(
          `[AgentCore] Unknown core event type: ${(event as AgentCoreEvent).type}`,
        );
        break;
    }

    return next;
  }

  // -------------------------------------------------------------------------
  // LLM execution – restored with proper error handling and cancellation checks.
  // -------------------------------------------------------------------------

  /**
   * Run an LLM request in the background with error handling
   */
  private runLLMRequestInBackground(requestIndex: number, params: ResponsesAPIParams): void {
    this.deps.background(async () => {
      try {
        await this.makeLLMRequest(requestIndex, params);
      } catch (err: any) {
        this.deps.console.error(`[AgentCore] LLM request ${requestIndex} failed`, err);
        // Only add error events if this request is still the active one
        if (this.llmRequestInProgress() && this._state.llmRequestStartedAtIndex === requestIndex) {
          await this.addEvents([
            {
              type: "CORE:INTERNAL_ERROR",
              data: { error: String(err.message ?? err), stack: String(err.stack ?? "") },
            },
            {
              type: "CORE:LLM_REQUEST_CANCEL",
              data: { reason: "error" },
            },
          ]);
        }
      }
    });
  }

  private getResponsesAPIParams(): ResponsesAPIParams {
    // openai uses tool_choice instead of toolChoice
    // so we need to copy the toolChoice value to tool_choice
    const { toolChoice, ...rest } = this._state.modelOpts;
    const modelOpts = {
      ...rest,
      tool_choice: toolChoice,
    };

    const unsortedInput: typeof this._state.inputItems = this._state.inputItems;

    return {
      ...modelOpts,
      instructions: renderPromptFragment([
        this._state.systemPrompt,
        // Ephemeral input items at the start to avoid the bug described here
        // https://iterate-com.slack.com/archives/C06LU7PGK0S/p1757362465658609
        // the cost of this is that if the matched context items change,
        // we bust the LLM cache and get a slower/more expensive response.
        ...Object.entries(this.state.ephemeralPromptFragments).map(([key, promptFragment]) =>
          renderPromptFragment({ tag: key, content: promptFragment }),
        ),
      ]),
      input: unsortedInput
        .map((item, index) => ({ item, score: item.getSortScore?.() ?? index }))
        .sort((a, b) => a.score - b.score)
        .map((x) => x.item),
      parallel_tool_calls: true,
      tools: this.state.runtimeTools,
    };
  }

  private async makeLLMRequest(
    thisRequestIndex: number,
    params: ResponsesAPIParams,
  ): Promise<void> {
    const openai = await this.deps.getOpenAIClient();
    if (this._state.llmRequestStartedAtIndex !== thisRequestIndex) {
      return; // Request cancelled, don't add any events
    }

    const stream = openai.responses.stream(params);

    const eventsFromStream: AgentCoreEventInput[] = [];
    for await (const evt of this.parseLLMResponseStreamToEvents(stream, thisRequestIndex)) {
      // Check if request has been cancelled before collecting more events
      if (this._state.llmRequestStartedAtIndex !== thisRequestIndex) {
        return; // Request cancelled, don't add any events
      }
      eventsFromStream.push(evt);
    }

    // Only add events if this request is still the active one
    if (this._state.llmRequestStartedAtIndex === thisRequestIndex) {
      await this.addEvents(eventsFromStream);
    }
  }

  private async *parseLLMResponseStreamToEvents(
    stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
    requestIndex: number,
  ): AsyncGenerator<AgentCoreEventInput> {
    /** Promises that will resolve to *lists* of events (since tool calls sometimes add extra events) */
    const eventPromises: Array<Promise<AgentCoreEventInput[]>> = [];
    const rawChunks: OpenAI.Responses.ResponseOutputItemDoneEvent[] = [];

    // Track parallel execution metadata
    let functionCallCount = 0;

    for await (const chunk of stream) {
      // Check if this request is still the active one
      if (this._state.llmRequestStartedAtIndex !== requestIndex) {
        return; // Request has been cancelled or superseded
      }

      if (this.deps.onLLMStreamResponseStreamingChunk) {
        // Add parallel execution context to streaming chunks
        const enhancedChunk = {
          ...chunk,
          parallelExecutionContext: {
            batchId: requestIndex.toString(),
            activeFunctionCalls: functionCallCount,
          },
        };
        this.deps.onLLMStreamResponseStreamingChunk(enhancedChunk);
      }

      if (chunk.type === "response.output_item.done") {
        rawChunks.push(chunk);
        const item = chunk.item;

        // single-use helper functions are kinda here just to make the diff more readable. if you are wondering if you can get rid of them, the answer is likely yes.

        const functionCallItemToEvents = async ({
          item,
          result,
          executionTimeMs,
        }: {
          item: Extract<typeof chunk.item, { type: "function_call" }>;
          result: Awaited<ReturnType<AgentCore<Slices>["tryInvokeLocalFunctionTool"]>>;
          executionTimeMs: number;
        }): Promise<AgentCoreEventInput[]> => {
          const lastNonFunctionCallItem = rawChunks.findLast(
            (c) => c.item.type !== "function_call",
          )?.item;
          const associatedReasoningItem =
            lastNonFunctionCallItem?.type === "reasoning" ? lastNonFunctionCallItem : undefined;
          const triggerLLMRequest = result.triggerLLMRequest !== false;
          const ev = {
            type: "CORE:LOCAL_FUNCTION_TOOL_CALL",
            data: {
              associatedReasoningItemId: associatedReasoningItem?.id,
              call: item,
              result: result.success
                ? { success: true, output: result.output }
                : { success: false, error: result.error },
              executionTimeMs,
              llmRequestStartEventIndex: requestIndex,
            },
            triggerLLMRequest,
          } satisfies AgentCoreEventInput;
          return [ev, ...(result.addEvents ?? [])];
        };

        const getNextEvent = async (item: OpenAI.Responses.ResponseOutputItemDoneEvent["item"]) => {
          const isCompletedImageGenerationCall =
            item.type === "image_generation_call" && item.status === "completed";
          if (isCompletedImageGenerationCall && !this.deps.uploadFile) {
            throw new Error("uploadFile dependency is required to handle image generation output");
          }
          // Handle image generation output
          if (isCompletedImageGenerationCall && this.deps.uploadFile && item.result) {
            // Convert base64 to ReadableStream
            const base64Data = item.result;
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }

            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            });

            // Extract additional properties that may be present in the actual response
            const itemData = item as any;
            const outputFormat = itemData.output_format || "png";
            // TODO figure out why openai call id is undefined
            const filename = `generated-image-${Date.now()}.${outputFormat}`;

            const imageCallOutputItemWithoutResult = {
              ...item,
              // result contains a huge base64 encoded image which we can't store in sqlite
              result: null,
            };

            // Upload the image
            const iterateFile = await this.deps.uploadFile({
              content: stream,
              filename,
              contentLength: bytes.length,
              mimeType: `image/${outputFormat}`,
              metadata: {
                openAIOutputItemWithoutResult: imageCallOutputItemWithoutResult,
              },
            });
            this.deps.console.log("iterateFile", iterateFile);
            // Yield file shared event
            return {
              type: "CORE:FILE_SHARED",
              data: {
                openAIOutputItemWithoutResult: imageCallOutputItemWithoutResult,
                direction: "from-agent-to-user",
                iterateFileId: iterateFile.fileId,
                openAIFileId: iterateFile.openAIFileId,
                originalFilename: filename,
                size: iterateFile.size,
                mimeType: `image/${outputFormat}`,
              },
            } satisfies AgentCoreEventInput;
          }
          return {
            type: "CORE:LLM_OUTPUT_ITEM",
            data: item,
          } satisfies AgentCoreEventInput;
        };
        if (item.type === "function_call") {
          const startTime = performance.now();
          functionCallCount++;

          eventPromises.push(
            this.tryInvokeLocalFunctionTool(item).then((result) => {
              const executionTimeMs = Math.round(performance.now() - startTime);
              return functionCallItemToEvents({ item, result, executionTimeMs });
            }),
          );
        } else {
          if (eventPromises.length > 0) {
            eventPromises.push(getNextEvent(item).then((ev) => (ev ? [ev] : [])));
          } else {
            const ev = await getNextEvent(item);
            if (ev) {
              if (this._state.llmRequestStartedAtIndex !== requestIndex) {
                return; // Request has been cancelled or superseded
              }
              yield ev;
            }
          }
        }
      } else if (chunk.type === "response.completed") {
        const ev = {
          type: "CORE:LLM_REQUEST_END",
          data: { rawResponse: chunk },
        } satisfies AgentCoreEventInput;
        if (eventPromises.length > 0) {
          eventPromises.push(Promise.resolve([ev]));
        } else {
          yield ev;
        }
      }
    }

    if (eventPromises.length) {
      if (this._state.llmRequestStartedAtIndex !== requestIndex) {
        return; // Request has been cancelled or superseded
      }
      const eventLists = await Promise.all(eventPromises);
      const flat = eventLists.flat();
      for (const ev of flat) {
        if (this._state.llmRequestStartedAtIndex !== requestIndex) {
          return; // Request has been cancelled or superseded
        }
        yield ev;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tool invocation helper (now public for agent.ts)
  // -------------------------------------------------------------------------

  async tryInvokeLocalFunctionTool(call: ResponseFunctionToolCall): Promise<
    | {
        success: true;
        output: JSONSerializable;
        triggerLLMRequest?: boolean;
        addEvents?: MergedEventInputForSlices<Slices>[];
      }
    | {
        success: false;
        error: string;
        triggerLLMRequest?: boolean;
        addEvents?: MergedEventInputForSlices<Slices>[];
      }
  > {
    const tools = this.state.runtimeTools;
    const tool = tools.find((t: RuntimeTool) => t.type === "function" && t.name === call.name);
    if (!tool || tool.type !== "function" || !("execute" in tool)) {
      this.deps.console.error("Tool not found or not local:", tool);
      this.deps.console.error("runtime tools:", tools);
      this.deps.console.error("tool", JSON.stringify(tool, null, 2));
      return { success: false, error: `Tool not found or not local: ${call.name}` };
    }
    try {
      const args = JSON.parse(call.arguments || "{}");
      const result = await tool.execute(call, args);
      return {
        success: true,
        output: stripNonSerializableProperties(result.toolCallResult),
        triggerLLMRequest: result.triggerLLMRequest,
        addEvents: result.addEvents,
      };
    } catch (err: any) {
      let errorMessage: string;

      if (err instanceof Error) {
        // Use built-in error formatting for standard errors
        errorMessage = `Error in tool ${call.name}: ${err.message}`;
        // Include a limited stack trace if available and the message is not about schema validation
        if (!err.message.includes("doesn't match schema") && err.stack) {
          const stackLines = err.stack.split("\n").slice(0, 3).join("\n");
          errorMessage += `\n${stackLines}`;
        }
      } else {
        // For any other type of error, use built-in JSON.stringify or String conversion
        errorMessage = `Error in tool ${call.name}: ${JSON.stringify(err, null, 2) || String(err)}`;
      }

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get the reduced state at a specific event index by replaying events.
   * This is useful for debugging and inspecting historical state.
   */
  getReducedStateAtEventIndex(eventIndex: number) {
    // TODO: Call this function from initializeWithEvents

    // Start with initial state
    let tempState = { ...CORE_INITIAL_REDUCED_STATE } as typeof this._state;

    // Add initial slice states
    for (const slice of this.slices) {
      if (slice.initialState) {
        tempState = { ...tempState, ...slice.initialState };
      }
    }

    // Replay events up to the specified index
    const eventsToReplay = this._events.slice(0, eventIndex + 1);
    for (const event of eventsToReplay) {
      tempState = this.runReducersOnSingleEvent(tempState, event);
    }

    return this.augmentState(tempState);
  }
}

// -----------------------------------------------------------------------------
// Helper conditional types exposed for slice authors
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Slice factory – supports declaring dependencies on other slices.
// -----------------------------------------------------------------------------

/**
 * Define an AgentCore slice that can reference state/dep types of other slices.
 *
 * When a slice depends on other slices, you can pass those slice definitions
 * via the `dependencies` generic. Their state and dep types will automatically
 * be made available on the `state` and `deps` parameters of the reducer – so
 * no unsafe casting is needed inside the reducer implementation.
 *
 * Example:
 * ```ts
 * export const childSlice = defineAgentCoreSlice<
 *   ChildState,
 *   typeof childEventSchema,
 *   ChildDeps,
 *   [typeof parentSlice] // <-- dependencies
 * >({
 *   name: "child-slice",
 *   eventSchema: childEventSchema,
 *   async reduce(state, deps, event) {
 *     // `state` now includes parentSlice's state in addition to core + own
 *   }
 * });
 * ```
 */
export function defineAgentCoreSlice<Spec extends AgentCoreSliceSpec>(def: {
  name: string;
  dependencies?: SliceDependsOnOf<Spec>;
  eventSchema: SliceEventSchemaOf<Spec>;
  eventInputSchema?: SliceEventInputSchemaOf<Spec>; // optional per rules – default later
  initialState?: SliceStateOf<Spec>;
  reduce: (
    state: Readonly<
      CoreReducedState<z.input<SliceEventInputSchemaOf<Spec>>> &
        SliceStateOf<Spec> &
        MergedStateForSlices<SliceDependsOnOf<Spec>, z.input<SliceEventInputSchemaOf<Spec>>>
    >,
    deps: AgentCoreDeps &
      SliceDepsOf<Spec> &
      MergedDepsForSlices<SliceDependsOnOf<Spec>> & { agentCore: AgentCoreMinimal<Spec> },
    event: AgentCoreEvent | z.infer<SliceEventSchemaOf<Spec>>,
  ) => Partial<
    CoreReducedState<z.input<SliceEventInputSchemaOf<Spec>>> &
      SliceStateOf<Spec> &
      MergedStateForSlices<SliceDependsOnOf<Spec>, z.input<SliceEventInputSchemaOf<Spec>>>
  > | void;
}): AgentCoreSlice<Spec> {
  const { eventSchema, eventInputSchema, initialState, reduce } = def;

  return {
    name: def.name,
    eventSchema,
    eventInputSchema: (eventInputSchema ?? eventSchema) as SliceEventInputSchemaOf<Spec>,
    initialState,
    reduce,
  };
}
