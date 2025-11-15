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

import * as R from "remeda";
import { Mutex } from "async-mutex";
import jsonata from "@mmkal/jsonata/sync";
import type { OpenAI } from "openai";
import type {
  ResponseFunctionToolCall,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.mjs";
import { z } from "zod";
import { mergeDeep } from "remeda";
import dedent from "dedent";
import { stripNonSerializableProperties } from "../utils/schema-helpers.ts";
import type { JSONSerializable } from "../utils/type-helpers.ts";
import { logger } from "../tag-logger.ts";
import { deepCloneWithFunctionRefs } from "./deep-clone-with-function-refs.ts";
import {
  AgentCoreEvent,
  type ApprovalKey,
  type AugmentedCoreReducedState,
  CORE_INITIAL_REDUCED_STATE,
  type CoreReducedState,
  type ToolCallApprovalEvent,
  type ToolCallApprovalState,
} from "./agent-core-schemas.js";
import { renderPromptFragment } from "./prompt-fragments.js";
import { type LocalFunctionRuntimeTool, type RuntimeTool, type ToolSpec } from "./tool-schemas.ts";
import { evaluateContextRuleMatchers } from "./context.ts";
import { generateTypes } from "./codemode.ts";

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
  setupCodemode: (functions: Record<string, Function>) => {
    eval: (
      code: string,
      statusIndicatorText: string,
    ) => Promise<{
      dynamicWorkerCode: string;
      result: unknown;
      toolCalls: {
        tool: string;
        input: unknown;
        output: Awaited<ReturnType<typeof executeLocalFunctionTool>>;
      }[];
    }>;
    [Symbol.dispose]: () => Promise<void>;
  };
  /** Persist the full event array whenever it changes – safe to store by ref */
  storeEvents(events: ReadonlyArray<AgentCoreEvent>): void;
  /** Run a background task */
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
  onEventAdded?: (payload: { event: AgentCoreEvent; reducedState: CoreReducedState }) => void;
  /**
   * Optional hook to collect context items (prompts and tools) that should be
   * included in LLM requests. Called right before making each LLM request.
   */
  getRuleMatchData: (state: CoreReducedState) => unknown;
  /**
   * Optional hook to get the final redirect URL for any authorization flows.
   */
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
  requestApprovalForToolCall?: (payload: {
    toolName: string;
    args: JSONSerializable;
    toolCallId: string;
  }) => Promise<ApprovalKey>;
  onToolCallApproved?: (params: {
    data: ToolCallApprovalEvent["data"];
    state: ToolCallApprovalState;
    replayToolCall: () => Promise<void>;
  }) => Promise<void>;
}

export type AgentCoreState = CoreReducedState;
// Re-export event types from schemas for convenience
export type { AgentCoreEvent };

// ---------------------------------------------------------------------------
// Updated AgentCoreSlice interface -----------------------------------------
// ---------------------------------------------------------------------------

export interface AgentCoreSlice<Spec extends AgentCoreSliceSpec = AgentCoreSliceSpec> {
  name: string;
  /** Optional slice-local initial state */
  initialState?: SliceStateOf<Spec>;
  /** Zod schema for stored events (required when slice defines events) */
  eventSchema: SliceEventSchemaOf<Spec>;
  /** Reducer returning partial state updates */
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
  Events = AgentCoreEvent,
> = CoreReducedState<Events> & UnionToIntersection<SliceStateOf<SliceSpecOf<Sls[number]>>>;

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

export type MergedEventForSlices<Sls extends readonly AgentCoreSlice[]> =
  | AgentCoreEvent
  | (Sls[number] extends infer T
      ? T extends AgentCoreSlice<any>
        ? z.infer<SliceEventSchemaOf<SliceSpecOf<T>>>
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

type ResponsesAPIParams = Parameters<OpenAI["responses"]["stream"]>[0] & {
  input: OpenAI.Responses.ResponseInput;
};

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

  private augmentState(
    inputState: typeof this._state,
  ): MergedStateForSlices<Slices> & MergedStateForSlices<CoreSlices> & AugmentedCoreReducedState {
    const next: AugmentedCoreReducedState = {
      ...inputState,
      enabledContextRules: [],
      runtimeTools: [],
      ephemeralPromptFragments: {},
      toolSpecs: [],
      mcpServers: [],
      codemodeEnabledTools: [],
      rawKeys: Object.keys(inputState),
    };

    const setEnabledContextRules = () => {
      const enabledContextRules = Object.values(next.contextRules).filter((contextRule) => {
        const matchAgainst = this.deps.getRuleMatchData(next);
        return evaluateContextRuleMatchers({ contextRule, matchAgainst });
      });
      next.enabledContextRules = enabledContextRules;
      // Include prompts from enabled context rules as ephemeral prompt fragments so they are rendered
      // into the LLM instructions for this request. These are ephemeral and recomputed per request.
      next.ephemeralPromptFragments = {
        ...next.ephemeralPromptFragments,
        ...Object.fromEntries(
          enabledContextRules.flatMap((r) => (r.prompt ? [[r.key, r.prompt] as const] : [])),
        ),
      };
      const updatedContextRulesTools = enabledContextRules.flatMap((rule) => rule.tools || []);
      next.groupedRuntimeTools = {
        ...next.groupedRuntimeTools,
        "context-rule": this.deps.toolSpecsToImplementations(updatedContextRulesTools),
      };
      next.toolSpecs = [...next.toolSpecs, ...updatedContextRulesTools];
      next.mcpServers = [...next.mcpServers];
    };

    next.ephemeralPromptFragments = {};

    setEnabledContextRules();

    // todo: figure out how to deduplicate these in case of name collisions?
    next.runtimeTools = Object.values(next.groupedRuntimeTools).flat();

    const codemodeified = this.codemodeifyState(next);

    if (codemodeified.modified) {
      setEnabledContextRules();
    }

    return next as MergedStateForSlices<Slices> &
      MergedStateForSlices<CoreSlices> &
      AugmentedCoreReducedState;
  }

  /** modifies the state to swap out tools for a codemode tool, if applicable */
  private codemodeifyState(state: AugmentedCoreReducedState) {
    const flatRuntimeTools = state.runtimeTools;

    const policies = state.enabledContextRules.flatMap((rule) => rule.toolPolicies || []);
    const codemodeGrouped = R.groupBy(state.runtimeTools, (tool) => {
      let codemodeEnabled = false;
      for (const policy of policies.filter((p) => p.codemode !== undefined)) {
        const evaluator = jsonata(policy.matcher || "true");
        const result = evaluator.evaluate(tool);
        if (result) {
          codemodeEnabled = policy.codemode!;
        }
      }
      return codemodeEnabled ? ("codemode" as const) : ("normal" as const);
    });

    if (!codemodeGrouped.codemode?.length) return { modified: false };

    const toolTypes = generateTypes(state.runtimeTools, {
      blocklist:
        codemodeGrouped.normal?.flatMap((tool) => ("name" in tool && tool.name) || []) || [],
      outputSamples:
        state.recordedToolCalls &&
        R.pipe(
          state.recordedToolCalls,
          R.groupBy((call) => call.tool),
          R.mapValues((calls) => calls.map((call) => call.output)),
        ),
    });
    const codemodeTool: (typeof state.runtimeTools)[number] = {
      type: "function",
      name: "codemode",
      description: "codemode: a tool that can generate code to achieve a goal",
      strict: true,
      parameters: {
        type: "object",
        required: ["functionCode", "statusIndicatorText"],
        additionalProperties: false,
        properties: {
          functionCode: {
            type: "string",
            description: "The javascript code for the async function named 'codemode'",
          },
          statusIndicatorText: {
            type: "string",
            description:
              "The text to display in the status indicator while the generated code is executed - a very short human-readable description, less than six words. Sacrifice grammar for brevity.",
          },
        },
      },
      execute: async (params) => {
        const { functionCode, statusIndicatorText } = JSON.parse(params.arguments) as {
          functionCode: string;
          statusIndicatorText: string;
        };

        const functions = Object.fromEntries(
          flatRuntimeTools.flatMap((tool): [] | [[string, Function]] => {
            if (tool.type !== "function") return [];
            const fn = async (input: unknown) => {
              const call: ResponseFunctionToolCall = {
                type: "function_call",
                call_id: params.call_id + "-codemode" + Date.now() + String(Math.random()),
                name: tool.name,
                arguments: JSON.stringify(input),
                status: "in_progress",
              };
              const toolWithApproval = this.approvify(call, tool);
              return executeLocalFunctionTool(toolWithApproval, call, input);
            };
            return [[tool.name, fn]];
          }),
        );

        using cm = this.deps.setupCodemode(functions);
        const output = await cm.eval(functionCode, statusIndicatorText);
        const triggerLLMRequestValues = output.toolCalls.flatMap((call) =>
          "triggerLLMRequest" in call.output ? call.output.triggerLLMRequest : [],
        );
        const triggerLLMRequest =
          triggerLLMRequestValues.find(Boolean) ?? // if any are true, we need to trigger
          triggerLLMRequestValues.find((v) => typeof v === "boolean"); // try to faithfully report `false` rather than `undefined` if some tool call specified `false`
        return {
          type: "function_call_output",
          call_id: "codemode",
          output,
          toolCallResult: output.result,
          triggerLLMRequest,
          addEvents: [
            {
              type: "CORE:CODEMODE_TOOL_CALLS",
              data: output.toolCalls.map((call) => ({
                ...call,
                output: call.output.toolCallResult,
              })),
            },
            ...output.toolCalls.flatMap((call) => call.output.addEvents ?? []),
          ],
        };
      },
    };
    state.runtimeTools = [...toolTypes.unavailable, codemodeTool];
    state.codemodeEnabledTools = toolTypes.available.map((tool) => tool.name);
    state.ephemeralPromptFragments.codemode = dedent`
      Note: the following functions are available to you via codemode. If asked to use one of these as a "tool", use via the "codemode" tool
  
      \`\`\`typescript
      __codemode_tool_types__
      \`\`\`
  
      When using codemode, generate an async function called "codemode" that achieves the goal. This async function doesn't accept any arguments. Parameters must be hard-coded into the individual function calls inside the codemode() function. Don't do any processing on the return values from helper functions unless specifically requested to, or you need to pass them into another helper function. Just await/return them. Don't use try/catch at all - instead, allow errors to be thrown, there will be an opportunity to fix the code next time. We should always use the return value from each helper function, don't ever call as a side-effect.
  
      Example if the user asks you to name Christopher Nolan movies:
  
      \`\`\`javascript
      async function codemode() {
        return await searchWeb({ query: "Christopher Nolan movies" });
      }
      \`\`\`

      BAD example of a side-effect:

      \`\`\`javascript
      async function codemode() {
        await addSlackReaction({ messageTs: "1231231231.878289", name: "grimacing" }); // BAD! this is a side-effect
        return await searchWeb({ query: "Christopher Nolan movies" });
      }
      \`\`\`

      GOOD example of using the return value:

      \`\`\`javascript
      async function codemode() {
        const [reaction, search] = await Promise.all([
          addSlackReaction({ messageTs: "1231231231.878289", name: "grimacing" }), // GOOD! tracking the result via Promise.all
          searchWeb({ query: "Christopher Nolan movies" }),
        ]);
        return {reaction, search} // GOOD! returning both results for the tool call output
      }
      \`\`\`

      If you're called two functions in one go, but you got a failure, figure out which one failed, and next time, call them separately via parallel tool calls.
    `.replace("__codemode_tool_types__", toolTypes.typescript());

    return { modified: true };
  }

  get state() {
    return this.augmentState(this._state);
  }

  // Event log ---------------------------------------------------------------
  private _events: (MergedEventForSlices<Slices> & { eventIndex: number; createdAt: string })[] =
    [];
  get events(): ReadonlyArray<MergedEventForSlices<Slices>> {
    return this._events;
  }

  // Dependencies & slices ---------------------------------------------------
  readonly deps: MergedDepsForSlices<Slices>;
  private readonly slices: Readonly<Slices>;

  private readonly _mutex = new Mutex();

  // Combined Zod schema for validating any incoming event
  private readonly combinedEventSchema: z.ZodType<AgentCoreEvent>;

  // Track initialization state
  private _initialized = false;

  // Track seen idempotency keys for deduplication
  private readonly _seenIdempotencyKeys = new Set<string>();

  constructor(options: AgentCoreConstructorOptions<Slices, MergedDepsForSlices<Slices>>) {
    const { slices, deps } = options;

    this.deps = { ...deps };
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

      logger.debug(`[AgentCore] Initializing with ${existing.length} existing events`);

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
          const _validated = this.combinedEventSchema.parse(event);
          if (_validated.eventIndex === undefined || !_validated.createdAt) {
            throw new Error(`eventIndex and createdAt are required: ${JSON.stringify(event)}`);
          }
          const validated = _validated as MergedEventForSlices<Slices> & {
            eventIndex: number;
            createdAt: string;
          };

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
        logger.warn(
          `[AgentCore] Resuming interrupted LLM request at index ${requestIndex} - indicates DO crash during request`,
        );

        this.runLLMRequestInBackground(requestIndex, this.getResponsesAPIParams());
      }
    }
  }

  /** btw this returns an array */
  addEvent(
    event: MergedEventForSlices<Slices> | MergedEventForSlices<CoreSlices>,
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
    events: MergedEventForSlices<Slices>[] | MergedEventForSlices<CoreSlices>[],
  ): { eventIndex: number }[] {
    // Check if initialized
    if (!this._initialized) {
      const eventNames = events
        .map((e): string => e.type)
        .flatMap((e, i) => (i < 3 ? e : i === 3 ? "..." : []))
        .join(",");
      throw new Error(
        `[AgentCore] Cannot add events before calling initializeWithEvents. Tried to add: ${eventNames}`,
      );
    }

    try {
      const originalEvents = [...this._events];
      const originalState = { ...this._state };
      const eventsAddedThisBatch: Array<{
        event: MergedEventForSlices<Slices> & { eventIndex: number; createdAt: string };
        reducedState: MergedStateForSlices<Slices>;
      }> = [];

      try {
        // Parse all events first
        for (const ev of events) {
          // Check for idempotency key deduplication
          if (ev.idempotencyKey && this._seenIdempotencyKeys.has(ev.idempotencyKey)) {
            logger.warn(
              `[AgentCore] Skipping duplicate event with idempotencyKey: ${ev.idempotencyKey}`,
            );
            continue; // Skip this event
          }

          const parsed = {
            ...this.combinedEventSchema.parse(ev),
            eventIndex: this._events.length,
            createdAt: ev.createdAt ?? new Date().toISOString(),
            triggerLLMRequest: ev.triggerLLMRequest ?? false,
          };

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

      const responsesAPIParams = this.getResponsesAPIParams();

      const maybeTriggerLLMRequest = () => {
        if (!this._state.triggerLLMRequest) return;

        if (this._state.paused) {
          logger.warn("[AgentCore] LLM request trigger ignored - requests are paused");
          return;
        }

        // Hard-coded failsafe - if the agent is in an infinite loop, we need to pause it
        // I don't know why this was sometimes happening with codemode and the original prompt, but it was
        const lastUserActionIndex = responsesAPIParams.input.findLastIndex(
          (item) =>
            item.type === "message" &&
            item.role === "developer" &&
            Array.isArray(item.content) &&
            item.content[0]?.type === "input_text" &&
            item.content[0].text.trimStart().match(/^User (mentioned|message)/),
        );

        const messagesSinceLastUserAction = responsesAPIParams.input.filter(
          (item, index) =>
            index > lastUserActionIndex &&
            item.type === "function_call" &&
            item.name === "sendSlackMessage",
        );

        if (messagesSinceLastUserAction.length >= 10) {
          const pauseEvent = {
            type: "CORE:PAUSE_LLM_REQUESTS",
            eventIndex: this._events.length,
            createdAt: new Date().toISOString(),
            triggerLLMRequest: false,
            data: {
              reason: `Too many messages since last user action. Agent may be in an infinite loop`,
            },
          } satisfies AgentCoreEvent;

          // TODO: This pattern of push-then-update could be cleaned up to match addEvents pattern
          this._events.push(pauseEvent);
          this._state = this.runReducersOnSingleEvent(this._state, pauseEvent);

          // Invoke callback for cancel event
          if (this.deps.onEventAdded) {
            this.deps.onEventAdded({ event: pauseEvent, reducedState: { ...this._state } });
          }
        }

        // Handle LLM request triggering if needed

        // This happens after processing all events in the batch, so if a batch contains
        // both a trigger event and an LLM_REQUEST_END event (like when makeLLMRequest
        // processes a tool call), the llmRequestStartedAtIndex will already be cleared
        // and we won't cancel. This is intentional - when an LLM request returns a tool call,
        // makeLLMRequest adds all events for that request as one batch (output event,
        // tool call input/output, and LLM request end), so we don't want to cancel.
        if (this.llmRequestInProgress()) {
          logger.warn("[AgentCore] Cancelling in-flight request – new trigger received");
          // Add a cancel event
          const cancelEvent = {
            type: "CORE:LLM_REQUEST_CANCEL",
            data: {
              reason: `#${this._state.llmRequestStartedAtIndex} superseded by #${this._events.length}`,
            },
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
        const startEvent = {
          type: "CORE:LLM_REQUEST_START",
          eventIndex: this._events.length,
          createdAt: new Date().toISOString(),
          data: { rawRequest: responsesAPIParams },
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
      };

      maybeTriggerLLMRequest();

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
    event: MergedEventForSlices<Slices> & { eventIndex: number; createdAt: string },
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

  private reduceCore(
    state: CoreReducedState,
    event: AgentCoreEvent & { eventIndex: number; createdAt: string },
  ): CoreReducedState {
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
      case "CORE:CODEMODE_TOOL_CALLS": {
        next.recordedToolCalls ||= [];
        next.recordedToolCalls.push(...event.data);
        break;
      }
      case "CORE:SET_SYSTEM_PROMPT":
        next.systemPrompt = event.data.prompt;
        break;

      case "CORE:ADD_CONTEXT_RULES": {
        next.contextRules = {
          ...next.contextRules,
          ...Object.fromEntries(event.data.rules.map((item) => [item.key, item])),
        };
        break;
      }

      case "CORE:SET_MODEL_OPTS":
        next.modelOpts = event.data;
        break;

      case "CORE:SET_METADATA":
        next.metadata = mergeDeep(next.metadata, event.data);
        break;

      case "CORE:ADD_LABEL": {
        const existingLabels = Array.isArray(next.metadata.labels) ? next.metadata.labels : [];
        if (!existingLabels.includes(event.data.label)) {
          next.metadata = {
            ...next.metadata,
            labels: [...existingLabels, event.data.label],
          };
        }
        break;
      }

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

        const isPdf = mimeType === "application/pdf" || originalFilename?.match(/\.pdf$/i);

        const isSoraVideo = Boolean(event.metadata?.openaiSoraVideoId);

        // TODO: Find a way to make non-binary text files (e.g. .txt, .md, .csv, .json, etc.)
        // directly available to the LLM without going through the file API.

        const downloadUrl = this.deps.turnFileIdIntoPublicURL
          ? this.deps.turnFileIdIntoPublicURL(iterateFileId)
          : `https://you-must-inject-this-into-agent-core.com/${iterateFileId}`;

        // Handle images and PDFs - these can be shown to the LLM
        if (isImage || isPdf) {
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

          // build developer messages for both directions so that the agent can reference iterateFileId in subsequent tool calls
          const developerText = renderPromptFragment([
            direction === "from-agent-to-user"
              ? "Note: The previous file was something you created as the result of a tool call."
              : null,
            `Use either of the following identifiers to use this file in other tools:`,
            `iterateFileId: ${iterateFileId}.`,
            `Public URL: ${downloadUrl}.`,
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
        } else if (isSoraVideo) {
          // Handle Sora videos - add developer message only (videos can't be shown to LLM yet)
          const developerText = renderPromptFragment([
            `A video has been shared with the user.`,
            `OpenAI Video ID: ${event.metadata?.openaiSoraVideoId}.`,
            `iterate File ID: ${iterateFileId}.`,
            `Public URL: ${downloadUrl}.`,
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

          next.inputItems = [...next.inputItems, developerMessage];
        } else {
          // Handle other file types - add developer message only
          logger.warn(
            `[AgentCore] File ${iterateFileId} (${originalFilename}) cannot be shown to LLM - only images and PDFs are currently supported`,
          );

          const developerText = renderPromptFragment([
            `A file has been shared but could not be shown to the LLM yet.`,
            `Filename: ${originalFilename || "unknown"}`,
            `iterate File ID: ${iterateFileId}.`,
            `OpenAI File ID: ${openAIFileId}.`,
            `Public URL: ${downloadUrl}.`,
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

          next.inputItems = [...next.inputItems, developerMessage];
        }

        break;
      }

      case "CORE:MESSAGE_FROM_AGENT": {
        const { fromAgentName, message } = event.data;
        next.inputItems.push({
          type: "message" as const,
          role: "developer" as const,
          content: [
            {
              type: "input_text" as const,
              text: `Message from agent ${fromAgentName}: ${message}`,
            },
          ],
        });
        break;
      }

      case "CORE:PARTICIPANT_JOINED": {
        const { internalUserId, email, displayName, externalUserMapping, role } = event.data;
        const participant = {
          internalUserId,
          joinedAt: event.createdAt,
          lastActiveAt: event.createdAt,
          email,
          displayName,
          externalUserMapping,
          role,
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
              text: `User ${displayName} (id: ${internalUserId}, email: ${email}, role: ${role}) joined the conversation`,
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
        const { internalUserId, email, displayName, externalUserMapping, role } = event.data;
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
          role,
        };
        next.mentionedParticipants = {
          ...next.mentionedParticipants,
          [internalUserId]: mentionedParticipant,
        };
        break;
      }

      case "CORE:TOOL_CALL_APPROVAL_REQUESTED": {
        const { data } = event;
        next.toolCallApprovals = {
          ...next.toolCallApprovals,
          [data.approvalKey]: {
            ...event.data,
            status: "pending",
          },
        };
        next.inputItems.push({
          type: "message" as const,
          role: "developer" as const,
          content: [
            {
              type: "input_text" as const,
              text: `A tool call has been requested: ${data.toolName} with args: ${JSON.stringify(data.args)}. Awaiting approval from the user.`,
            },
          ],
        });
        break;
      }

      case "CORE:TOOL_CALL_APPROVED": {
        const { data } = event;
        const found = next.toolCallApprovals[data.approvalKey];
        if (!found) {
          next.inputItems.push({
            type: "message" as const,
            role: "developer" as const,
            content: [
              {
                type: "input_text" as const,
                text: `Tool call approval not found for key: ${data.approvalKey}. This should not have happened. Existing approval keys: ${Object.keys(next.toolCallApprovals).join(", ")}`,
              },
            ],
          });
          break;
        }
        if (found.status !== "pending") {
          // already approved/rejected. ignore.
          break;
        }
        next.toolCallApprovals = {
          ...next.toolCallApprovals,
          [data.approvalKey]: {
            ...next.toolCallApprovals[data.approvalKey],
            status: data.approved ? "approved" : "rejected",
          },
        };
        next.inputItems.push({
          type: "message" as const,
          role: "developer" as const,
          content: [
            {
              type: "input_text" as const,
              text: `Tool call ${found.toolName} with args: ${JSON.stringify(found.args)} has been ${data.approved ? "approved" : "rejected"}.`,
            },
          ],
        });
        next.triggerLLMRequest = true;
        break;
      }

      case "CORE:INTERNAL_ERROR":
      case "CORE:INITIALIZED_WITH_EVENTS":
      case "CORE:LOG":
      case "CORE:BACKGROUND_TASK_PROGRESS":
        // Just log, no state change needed
        break;

      default:
        event satisfies never;
        // Unknown event types are ignored (could be slice events)
        logger.warn(`[AgentCore] Unknown core event type: ${(event as AgentCoreEvent).type}`);
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
        logger.error(err);
        // Only add error events if this request is still the active one
        if (this.llmRequestInProgress() && this._state.llmRequestStartedAtIndex === requestIndex) {
          this.addEvents([
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

    const instructions = renderPromptFragment([
      this._state.systemPrompt,
      // Ephemeral input items at the start to avoid the bug described here
      // https://iterate-com.slack.com/archives/C06LU7PGK0S/p1757362465658609
      // the cost of this is that if the matched context items change,
      // we bust the LLM cache and get a slower/more expensive response.
      ...Object.entries(this.state.ephemeralPromptFragments).map(([key, promptFragment]) =>
        renderPromptFragment({ tag: key, content: promptFragment }),
      ),
    ]);

    return {
      ...modelOpts,
      instructions,
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

    const eventsFromStream: AgentCoreEvent[] = [];
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
  ): AsyncGenerator<AgentCoreEvent> {
    /** Promises that will resolve to *lists* of events (since tool calls sometimes add extra events) */
    const eventPromises: Array<Promise<AgentCoreEvent[]>> = [];
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
        }): Promise<AgentCoreEvent[]> => {
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
          } satisfies AgentCoreEvent;
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
            logger.info("iterateFile", iterateFile);
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
            } satisfies AgentCoreEvent;
          }
          return {
            type: "CORE:LLM_OUTPUT_ITEM",
            data: item,
          } satisfies AgentCoreEvent;
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
        } satisfies AgentCoreEvent;
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
        addEvents?: MergedEventForSlices<Slices>[];
      }
    | {
        success: false;
        error: string;
        triggerLLMRequest?: boolean;
        addEvents?: MergedEventForSlices<Slices>[];
      }
  > {
    const tools = this.state.runtimeTools;
    let tool = tools.find((t: RuntimeTool) => t.type === "function" && t.name === call.name);

    if (!tool || tool.type !== "function" || !("execute" in tool)) {
      const err = new Error(`Tool not found or not local: ${call.name}`);
      logger.error(err.message, {
        stack: err.stack,
        tool,
        runtimeTools: tools,
        toolString: JSON.stringify(tool, null, 2),
      });
      return { success: false, error: err.message };
    }

    try {
      tool = this.approvify(call, tool);

      const args = JSON.parse(call.arguments || "{}");
      const result = await executeLocalFunctionTool(tool, call, args);
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

  // TODO: don't accept `call`, all we really need is the call id
  private approvify(call: ResponseFunctionToolCall, tool: LocalFunctionRuntimeTool) {
    const policies = this.state.enabledContextRules.flatMap((rule) => rule.toolPolicies || []);
    let needsApproval = false;
    for (const policy of policies.filter((p) => p.approvalRequired !== undefined)) {
      const evaluator = jsonata(policy.matcher || "true");
      const result = evaluator.evaluate(call);
      if (result) {
        needsApproval = policy.approvalRequired!;
      }
    }
    if (call.call_id.startsWith("injected-")) needsApproval = false;

    if (!needsApproval) return tool;

    const wrappers = tool.wrappers?.slice() || []; // slice to avoid mutating the original array
    wrappers.push((_next) => async (call, args) => {
      const approvalKey = await this.deps.requestApprovalForToolCall!({
        toolName: call.name,
        args: args as {},
        toolCallId: call.call_id,
      }).catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        error.message = `Failed to request approval: ${error.message}`;
        throw error;
      });
      return {
        toolCallResult: {
          success: true,
          output: { message: "Tool call needs approval" },
        },
        triggerLLMRequest: false,
        addEvents: [
          {
            type: "CORE:TOOL_CALL_APPROVAL_REQUESTED",
            data: {
              approvalKey,
              toolName: call.name,
              args,
              toolCallId: call.call_id,
            },
          },
        ],
      };
    });
    return { ...tool, wrappers };
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

  /**
   * Get the final redirect URL for authorization flows.
   */
  async getFinalRedirectUrl(payload: {
    durableObjectInstanceName: string;
  }): Promise<string | undefined> {
    return this.deps.getFinalRedirectUrl?.(payload);
  }
}

/**
 * Calls `tool.execute` after applying all wrappers in the correct order.
 * This utility function also gets rid of the stupid string from the type to protect against calling `.execute` directly by mistake.
 */
export const executeLocalFunctionTool = async (
  tool: LocalFunctionRuntimeTool,
  call: ResponseFunctionToolCall,
  args: unknown,
) => {
  tool.execute satisfies Function | `wrapper_usage_type_error: ${string}`;
  if (typeof tool.execute !== "function") throw new Error("Tool execute is not a function");
  tool.execute satisfies Function;
  const wrapped = (tool.wrappers || []).toReversed().reduce(
    (acc, wrapper) => wrapper((call, args) => acc(call, args)), //
    tool.execute,
  );
  return wrapped(call, args);
};

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
  const { eventSchema, initialState, reduce } = def;

  return {
    name: def.name,
    eventSchema,
    initialState,
    reduce,
  };
}
