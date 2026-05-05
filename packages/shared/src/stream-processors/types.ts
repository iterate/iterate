import type { z } from "zod";

export type StreamEventInput<Type extends string = string, Payload = unknown> = {
  type: Type;
  payload: Payload;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: number;
};

export type StreamEvent<Type extends string = string, Payload = unknown> = StreamEventInput<
  Type,
  Payload
> & {
  streamPath: string;
  offset: number;
  createdAt: string;
};

export type DerivedIdempotencyKeyArgs = {
  /**
   * Processor or helper that owns the derived append. This should usually be
   * the processor contract's `slug`.
   */
  slug: string;
  /**
   * Human-readable name for the derivation, for example
   * `render-webchat-message` or `codemode-result-to-agent-input`.
   */
  purpose: string;
  /**
   * Committed source event that caused the derived append.
   */
  event: Pick<StreamEvent, "streamPath" | "offset">;
};

export type EventDefinition<
  _Type extends string = string,
  PayloadOutput = unknown,
  PayloadInput = PayloadOutput,
> = {
  description?: string;
  payloadSchema: z.ZodType<PayloadOutput, PayloadInput>;
};

export type EventCatalog = Record<string, EventDefinition<string, unknown, unknown>>;

export type NoInferValue<Value> = [Value][Value extends unknown ? 0 : never];
export type ProcessorStateObject = Record<string, unknown>;

/**
 * Type-level event lookup for string-keyed processor contracts.
 *
 * This section is the main "type-fu" in the stream processor prototype. The
 * requirements behind it are recorded in
 * `tasks/agents-processor-composition-requirements.md`, especially:
 *
 * - processor authors want inline event definitions keyed by the durable wire
 *   event type:
 *
 *   ```ts
 *   events: {
 *     "events.iterate.com/agent/input-added": {
 *       description: "...",
 *       payloadSchema: z.object({ ... }),
 *     },
 *   }
 *   ```
 *
 * - `consumes` and `emits` should stay as visible string arrays in the
 *   contract, not hidden behind helper constants;
 * - a processor may consume or emit events owned by `processorDeps`;
 * - reducers and `afterAppend` should receive a union of only consumed events;
 * - `streamApi.append(...)` should accept ordinary object literals, but only
 *   for event types listed in `emits`, with the matching payload shape.
 *
 * The consequence is that the event type string is not stored inside the event
 * definition value. It is the key of the event catalog object. These helper
 * types recover "event type string -> payload schema" from those keys.
 */
export type EventCatalogFromObject<Value> = {
  [Key in keyof Value as string extends Key
    ? never
    : number extends Key
      ? never
      : Value[Key] extends EventDefinition
        ? Key
        : never]: Value[Key];
};

/**
 * Accept either a full processor contract (`{ events: ... }`) or a standalone
 * event catalog. `processorDeps` deliberately supports both so a processor can
 * depend on another processor's full contract or on a small shared catalog.
 */
export type ContractEventCatalog<ContractOrCatalog> = ContractOrCatalog extends {
  events: infer Events;
}
  ? EventCatalogFromObject<Events>
  : EventCatalogFromObject<ContractOrCatalog>;

/**
 * All event type strings resolvable from local `events` plus `processorDeps`.
 *
 * `defineProcessorContract(...)` uses this to make typos in `consumes` and
 * `emits` fail at the contract definition site. Runtime validation still does
 * the same check for dynamically assembled contracts.
 */
export type ResolvedEventType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = Extract<
  keyof EventCatalogFromObject<Events> | EventTypeFromProcessorDeps<ProcessorDeps>,
  string
>;

/**
 * Distributes over each item in `processorDeps` and collects its event keys.
 *
 * The `ProcessorDep extends unknown` branch is intentional: it makes TypeScript
 * distribute over unions, which is how an array like
 * `[CoreProcessorContract, AgentProcessorContract]` turns into the union of all
 * event strings owned by both contracts.
 */
export type EventTypeFromProcessorDeps<ProcessorDeps extends readonly unknown[]> =
  ProcessorDeps[number] extends infer ProcessorDep
    ? ProcessorDep extends unknown
      ? keyof ContractEventCatalog<ProcessorDep>
      : never
    : never;

/**
 * Looks up one event definition by string key from one processor dependency.
 */
export type EventDefinitionFromProcessorDep<
  ProcessorDep,
  Type extends string,
> = ProcessorDep extends unknown
  ? Type extends keyof ContractEventCatalog<ProcessorDep>
    ? ContractEventCatalog<ProcessorDep>[Type]
    : never
  : never;

export type EventDefinitionFromProcessorDeps<
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = EventDefinitionFromProcessorDep<ProcessorDeps[number], Type>;

/**
 * Resolve a string event type to the event definition that owns it.
 *
 * Local events win over dependency events in the type-level lookup, but runtime
 * validation rejects duplicate ownership. Duplicate event ownership is a
 * contract error because otherwise a string such as
 * `"events.iterate.com/agent/input-added"` could map to two payload schemas.
 */
export type EventDefinitionForType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : EventDefinitionFromProcessorDeps<ProcessorDeps, Type>;

/**
 * Turn an event definition plus its catalog key into a stream event.
 *
 * The catalog key is passed separately because authored event definitions are
 * plain `{ description, payloadSchema }` values and intentionally do not repeat
 * the event type inside the value.
 */
export type EventFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<string, infer PayloadOutput, unknown>
    ? StreamEvent<Type, PayloadOutput>
    : never;

/**
 * Turn an event definition plus its catalog key into append input.
 *
 * We accept both Zod input and output payload shapes. That lets authors use
 * Zod defaults/transforms in payload schemas without forcing append callers to
 * provide already-parsed output. Runners still validate at the append boundary.
 */
export type InputFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<string, infer PayloadOutput, infer PayloadInput>
    ? StreamEventInput<Type, PayloadOutput | PayloadInput>
    : never;

/**
 * Build the union of stream events corresponding to a `consumes` string
 * array. This is what makes reducer/`afterAppend` narrowing work:
 *
 * ```ts
 * reduce({ event }) {
 *   if (event.type === "events.iterate.com/agent/input-added") {
 *     event.payload.content; // correctly typed
 *   }
 * }
 * ```
 */
export type EventFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = EventFromType<Events, ProcessorDeps, Types[number]>;

export type EventFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
  : never;

/**
 * Build the union of append inputs corresponding to an `emits` string array.
 * This is what makes raw object-literal appends work without generated
 * `.createInput(...)` helpers:
 *
 * ```ts
 * await streamApi.append({
 *   event: {
 *     type: "events.iterate.com/agent/input-added",
 *     payload: { content: "hello" },
 *   },
 * });
 * ```
 */
export type InputFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = InputFromType<Events, ProcessorDeps, Types[number]>;

export type InputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? InputFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
  : never;

export type ProcessorContractShape<
  StateSchema extends z.ZodType = z.ZodType,
  Events extends EventCatalog = EventCatalog,
  ProcessorDeps extends readonly unknown[] = readonly unknown[],
  Consumes extends readonly string[] = readonly string[],
  Emits extends readonly string[] = readonly string[],
> = {
  slug: string;
  version: string;
  description: string;
  /**
   * Serializable reduced state schema. Processor state must be object-shaped so
   * slices can evolve safely and hooks never have to branch on primitive state.
   */
  stateSchema: StateSchema;
  /**
   * Optional initial reduced state. Runners parse this through `stateSchema`
   * before using it. If omitted, runners parse `undefined`, which is useful for
   * tiny processors that prefer Zod defaults.
   */
  initialState?: z.input<StateSchema>;
  processorDeps?: ProcessorDeps;
  events: Events;
  consumes: Consumes;
  emits: Emits;
  /**
   * Optional pure projection from current state + consumed event to next state.
   *
   * Omitted reduce means identity reduction. This keeps side-effect-only
   * processors lightweight while preserving the same catch-up/checkpoint path.
   */
  reduce?(args: {
    /**
     * The current processor contract. This is passed by the runner so reusable
     * reducer fragments can inspect processor identity and event metadata
     * without each processor copying `slug` / `version` into helper calls.
     */
    contract: {
      slug: string;
      version: string;
      description: string;
      events: NoInferValue<Events>;
      processorDeps?: NoInferValue<ProcessorDeps>;
      consumes: NoInferValue<Consumes>;
      emits: NoInferValue<Emits>;
    };
    state: z.output<NoInferValue<StateSchema>>;
    event: ConsumedEvent<{
      state: NoInferValue<StateSchema>;
      events: NoInferValue<Events>;
      processorDeps?: NoInferValue<ProcessorDeps>;
      consumes: NoInferValue<Consumes>;
    }>;
  }): z.output<NoInferValue<StateSchema>> | null | undefined;
};

export type UnresolvedEventTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = Exclude<Types[number], ResolvedEventType<Events, ProcessorDeps>>;

/**
 * Compile-time typo guard for `consumes` and `emits`.
 *
 * If every string in `Types` can be resolved from local events plus
 * `processorDeps`, this returns `unknown` and the contract argument remains
 * unchanged. If any string is unresolved, this returns `never`, causing the
 * `defineProcessorContract(...)` call to fail where the bad string is written.
 */
export type ResolvedEventTypesOnly<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = [UnresolvedEventTypes<Events, ProcessorDeps, Types>] extends [never] ? unknown : never;

export type ProcessorContractInput<
  StateSchema extends z.ZodType,
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Consumes extends readonly string[],
  Emits extends readonly string[],
> = {
  slug: string;
  version: string;
  description: string;
  stateSchema: z.output<StateSchema> extends Record<string, unknown> ? StateSchema : never;
  initialState?: z.input<StateSchema>;
  processorDeps: ProcessorDeps;
  events: Events;
  consumes: Consumes & ResolvedEventTypesOnly<Events, ProcessorDeps, Consumes>;
  emits: Emits & ResolvedEventTypesOnly<Events, ProcessorDeps, Emits>;
  reduce?: ProcessorContractShape<StateSchema, Events, ProcessorDeps, Consumes, Emits>["reduce"];
};

export type ProcessorContractInputWithoutDeps<
  StateSchema extends z.ZodType,
  Events extends EventCatalog,
  Consumes extends readonly string[],
  Emits extends readonly string[],
> = {
  slug: string;
  version: string;
  description: string;
  stateSchema: z.output<StateSchema> extends Record<string, unknown> ? StateSchema : never;
  initialState?: z.input<StateSchema>;
  processorDeps?: never;
  events: Events;
  consumes: Consumes & ResolvedEventTypesOnly<Events, readonly [], Consumes>;
  emits: Emits & ResolvedEventTypesOnly<Events, readonly [], Emits>;
  reduce?: ProcessorContractShape<StateSchema, Events, readonly [], Consumes, Emits>["reduce"];
};

export type ProcessorDepsOf<Contract> = Contract extends {
  processorDeps?: infer ProcessorDeps;
}
  ? ProcessorDeps extends readonly unknown[]
    ? ProcessorDeps
    : readonly []
  : readonly [];

export type ProcessorState<Contract> = Contract extends {
  stateSchema: infer State extends z.ZodType;
}
  ? z.output<State>
  : never;

/**
 * The stream event union visible to a processor implementation.
 *
 * This intentionally depends on `contract.consumes`, not on every resolvable
 * event. A processor can depend on a contract for append permission or schema
 * lookup without receiving all of that contract's events in `reduce` and
 * `afterAppend`.
 */
export type ConsumedEvent<Contract> = Contract extends {
  events: infer Events extends EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventFromTypes<Events, ProcessorDepsOf<Contract>, Consumes>
  : never;

/**
 * The append input union allowed for `streamApi.append(...)`.
 *
 * This intentionally depends on `contract.emits`. It enforces the requirement
 * from the design discussion that a processor gets a type error if it appends
 * an event it did not declare in `emits`, while still letting authors pass
 * plain object literals.
 */
export type EmittedInput<Contract> = Contract extends {
  events: infer Events extends EventCatalog;
  emits: infer Emits extends readonly string[];
}
  ? InputFromTypes<Events, ProcessorDepsOf<Contract>, Emits>
  : never;

/**
 * Props for a scoped stream API service.
 *
 * The intended Cloudflare shape is a WorkerEntrypoint exported from the script
 * and instantiated with `ctx.exports.StreamApi({ props: { streamPath } })`.
 * Method-level `streamPath` overrides let processors append/read/subscribe to
 * another stream without creating another service instance.
 */
export type ProcessorStreamApiProps = {
  /**
   * Bound stream path for this API instance. If an operation omits
   * `streamPath`, the runner should use this path. Relative method paths are
   * resolved by the runner against this bound path; absolute paths target that
   * absolute stream directly.
   */
  streamPath?: string;
};

export type ProcessorStreamApi<Contract> = {
  append(args: { event: EmittedInput<Contract>; streamPath?: string }): Promise<StreamEvent>;
  read(args?: {
    streamPath?: string;
    afterOffset?: number | "start" | "end";
    beforeOffset?: number | "start" | "end";
  }): Promise<StreamEvent[]>;
  subscribe(args?: {
    streamPath?: string;
    afterOffset?: number | "start" | "end";
    signal?: AbortSignal;
  }): AsyncIterable<StreamEvent>;
};

export type ProcessorReduction<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * Runner-owned durable progress for one processor bound to one stream.
 *
 * `reducedThroughOffset` and `afterAppendCompletedThroughOffset` are separate
 * on purpose. A runner may successfully reduce and persist state for an event,
 * then fail while running `afterAppend`. Keeping both offsets lets the runner
 * retry live side effects without replaying reducer state from scratch.
 *
 * This is not part of the processor contract. It is runner bookkeeping: the
 * processor owns `state`, while the runner owns stream progress and side-effect
 * delivery policy.
 */
export type StoredProcessorState<Contract> = {
  state: ProcessorState<Contract>;
  /**
   * Whether this runner has finished its first attachment to the stream. Before
   * this flips to true, the runner may apply `firstAttachAfterAppend` to a
   * recent historical lookback window. After it flips, backlog events are not
   * "ancient"; they are missed live events from an already-attached processor.
   */
  hasCompletedFirstAttach: boolean;
  /**
   * Offset boundary captured during first attach. Events above this offset are
   * live from the processor's perspective. Events at or below it are historical
   * unless a first-attach lookback policy deliberately treats them as live-ish.
   */
  liveAfterOffset: number;
  reducedThroughOffset: number;
  afterAppendCompletedThroughOffset: number;
};

/**
 * Runner policy for the very first time a processor is attached to an existing
 * stream.
 *
 * Historical replay is reduce-only except for a short default lookback window.
 * That default covers processors installed just after stream creation, where a
 * very recent event such as stream initialization should still run side
 * effects. Override this only when that default is confusing or unsafe for a
 * processor. This policy is deliberately backend-only: frontend projections
 * import contracts/reducers and should never decide when side effects run.
 */
export type FirstAttachAfterAppendPolicy =
  | { mode: "none" }
  | { mode: "lookback"; milliseconds: number }
  | { mode: "all" };

export type ProcessorImplementation<Contract> = {
  /**
   * First-attach side-effect policy for runners. Leave this unset for the
   * standard short lookback default; set `{ mode: "none" }` only for processors
   * where even recent first-attach side effects are surprising or unsafe. A
   * specific runner deployment may override this. Keep this off the contract so
   * frontend code can import contracts without learning backend lifecycle
   * policy.
   */
  firstAttachAfterAppend?: FirstAttachAfterAppendPolicy;
  /**
   * Runs after the runner has loaded or replayed reduced state, but before live
   * post-append processing begins. Use this to materialize runtime-only state
   * such as HTTP clients, MCP connections, subscriptions, or timers.
   */
  onStart?(args: {
    state: ProcessorState<Contract>;
    streamApi: ProcessorStreamApi<Contract>;
    signal: AbortSignal;
  }): Promise<void> | void;
  /**
   * Runs for live stream events after the runner has reduced and persisted the
   * processor state for that event. Historical catch-up is otherwise
   * reduce-only, except for the first-attach lookback policy.
   */
  afterAppend?(args: {
    event: ConsumedEvent<Contract>;
    previousState: ProcessorState<Contract>;
    state: ProcessorState<Contract>;
    streamApi: ProcessorStreamApi<Contract>;
    signal: AbortSignal;
  }): Promise<void> | void;
};

export type BuiltinProcessorImplementation<Contract> = ProcessorImplementation<Contract> & {
  beforeAppend?(args: {
    event: StreamEventInput;
    state: ProcessorState<Contract>;
  }): Promise<void> | void;
};

export type Processor<Contract> = {
  contract: Contract;
  implementation: ProcessorImplementation<Contract>;
};

export type BuiltinProcessor<Contract> = {
  contract: Contract;
  implementation: BuiltinProcessorImplementation<Contract>;
};
