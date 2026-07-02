// Vendored from packages/shared/src/streams/stream-processors.ts at the
// itx-v4 cutover — see stream-event.ts in this folder.
import { z } from "zod";
import {
  streamEventCreatedAtIsoSchema,
  streamEventIdempotencyKeySchema,
  StreamEventMetadata,
  streamEventOffsetSchema,
  StreamEventSourceSchema,
  type StreamEvent,
} from "./stream-event.ts";

export type { StreamEvent, StreamEventInput } from "./stream-event.ts";

export type ProcessorIdempotencyKeyProcessor =
  | string
  | { slug: string }
  | { contract: { slug: string } };

export type ProcessorIdempotencyKeyArgs = {
  processor: ProcessorIdempotencyKeyProcessor;
  key: string;
  sourceEvent?: Pick<StreamEvent, "offset">;
};

export type EventExample<Payload = unknown> = {
  description: string;
  payload: Payload;
};

export type EventDefinition<
  _Type extends string = string,
  PayloadOutput = unknown,
  PayloadInput = PayloadOutput,
> = {
  description?: string;
  examples?: readonly EventExample<PayloadInput>[];
  payloadSchema: z.ZodType<PayloadOutput, PayloadInput>;
};

export type EventCatalog = Record<string, EventDefinition<string, unknown, unknown>>;

export type NoInferValue<Value> = [Value][Value extends unknown ? 0 : never];
export type ProcessorStateObject = Record<string, unknown>;

type EventDefinitionWithPayloadExamples<Value> = Value extends {
  payloadSchema: infer PayloadSchema extends z.ZodType;
}
  ? Value extends { examples: infer Examples }
    ? Examples extends readonly EventExample<z.input<PayloadSchema>>[]
      ? Value
      : never
    : Value
  : never;

export type EventCatalogWithPayloadExamples<Events extends EventCatalog> = {
  [Key in keyof Events]: EventDefinitionWithPayloadExamples<Events[Key]>;
};

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
 * - reducers and processor hooks should receive a union of only consumed events;
 * - processor hooks should receive a union of only consumed events.
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
    ? StreamEvent<Type, PayloadOutput> & { payload: PayloadOutput }
    : never;

/**
 * An event delivered through the `"*"` wildcard that is not individually named
 * in `consumes`. Its `type` is typed as the literal `"*"` — mirroring the
 * contract entry it matched — so that narrowing over named consumed events
 * stays exact and the fallthrough branch is reachable instead of `never`:
 *
 * ```ts
 * switch (event.type) {
 *   case "events.iterate.com/stream/paused":
 *     event.payload.reason; // fully typed
 *     break;
 *   default:
 *     event.payload; // unknown — wildcard event, runtime type string varies
 * }
 * ```
 *
 * At runtime `type` holds the actual event type string; the `"*"` literal is a
 * type-level marker only. To compare against a specific event type, name it in
 * `consumes` instead of string-matching inside the wildcard branch.
 */
export type WildcardConsumedEvent = StreamEvent<"*", unknown> & { payload: unknown };

/**
 * Build the union of stream events corresponding to a `consumes` string
 * array. This is what makes reducer and hook narrowing work:
 *
 * ```ts
 * reduce({ event }) {
 *   if (event.type === "events.iterate.com/agent/input-added") {
 *     event.payload.content; // correctly typed
 *   }
 * }
 * ```
 *
 * `consumes` semantics by shape:
 * - named only — exact union of those events; exhaustive switches can end in
 *   `assertNever(event)`;
 * - `["*"]` only — plain `StreamEvent` (real `type` string, `unknown` payload);
 * - `["*", ...named]` — named union plus {@link WildcardConsumedEvent} for
 *   everything else.
 */
export type EventFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number]
  ? Exclude<Types[number], "*"> extends never
    ? StreamEvent
    : EventFromType<Events, ProcessorDeps, Exclude<Types[number], "*">> | WildcardConsumedEvent
  : EventFromType<Events, ProcessorDeps, Types[number]>;

export type EventFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
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
  /**
   * Explicit runner escape hatch for processors that must observe every
   * committed event on a stream and decide at runtime whether it matters.
   *
   * Most processors should leave this unset and declare concrete `consumes`.
   */
  consumesAllEvents?: true;
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

export type UnresolvedConsumedEventTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = Exclude<Exclude<Types[number], "*">, ResolvedEventType<Events, ProcessorDeps>>;

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

export type ResolvedConsumedEventTypesOnly<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = [UnresolvedConsumedEventTypes<Events, ProcessorDeps, Types>] extends [never] ? unknown : never;

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
  events: Events & EventCatalogWithPayloadExamples<Events>;
  consumes: Consumes & ResolvedConsumedEventTypesOnly<Events, ProcessorDeps, Consumes>;
  consumesAllEvents?: true;
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
  events: Events & EventCatalogWithPayloadExamples<Events>;
  consumes: Consumes & ResolvedConsumedEventTypesOnly<Events, readonly [], Consumes>;
  consumesAllEvents?: true;
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
 * `processEvent`.
 */
export type ConsumedEvent<Contract> = Contract extends {
  events: EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? Contract extends { consumesAllEvents: true }
    ? EventFromTypes<
        ContractEventCatalog<Contract>,
        ProcessorDepsOf<Contract>,
        readonly ["*", ...Consumes]
      >
    : EventFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Consumes>
  : never;

export type ProcessorReduction<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * Runtime stream-event parser for a string-keyed event definition.
 *
 * Processor contracts intentionally author event definitions as plain
 * `{ description, payloadSchema }` values keyed by the event type string. The
 * key is the durable event type; the value does not repeat it. Runners therefore
 * rebuild the concrete Zod envelope from the catalog key plus `payloadSchema`
 * whenever they validate append input or stream events.
 *
 * The cast is local to this helper because Zod's object inference cannot keep
 * the generic literal `Type` and generic `PayloadSchema` relationship through
 * `z.looseObject(...)`. The runtime schema still exactly matches
 * `StreamEvent<Type, z.output<PayloadSchema>>`.
 */
export function getEventSchema<
  const Type extends string,
  const PayloadSchema extends z.ZodType,
>(args: {
  type: Type;
  payloadSchema: PayloadSchema;
}): z.ZodType<
  StreamEvent<Type, z.output<PayloadSchema>>,
  StreamEvent<Type, z.input<PayloadSchema>>
> {
  // Loose: served events may carry transport-added envelope keys (e.g. the OS
  // API tags events with `streamPath`). Append input validation is a separate,
  // strict schema, so nothing writes unknown keys into a stream.
  return z.looseObject({
    type: z.literal(args.type),
    payload: args.payloadSchema,
    metadata: StreamEventMetadata.optional(),
    source: StreamEventSourceSchema.optional(),
    idempotencyKey: streamEventIdempotencyKeySchema.optional(),
    offset: streamEventOffsetSchema,
    createdAt: streamEventCreatedAtIsoSchema,
  }) as unknown as z.ZodType<
    StreamEvent<Type, z.output<PayloadSchema>>,
    StreamEvent<Type, z.input<PayloadSchema>>
  >;
}

/**
 * Typed identity for processor contracts.
 *
 * This is intentionally not a builder. It returns the exact object it receives
 * and does not rewrite event definitions, inject constants, or generate append
 * helpers. That keeps the contract shape aligned with the design requirements
 * in `tasks/agents-processor-composition-requirements.md`:
 *
 * ```ts
 * events: {
 *   "events.iterate.com/agent/input-added": {
 *     description: "...",
 *     payloadSchema: z.object({ ... }),
 *   },
 * },
 * consumes: ["events.iterate.com/agent/input-added"],
 * emits: ["events.iterate.com/agent/input-added"],
 * ```
 *
 * The overloads still enforce the important invariants at authoring time:
 *
 * - `stateSchema` must parse to an object-shaped reduced state;
 * - `initialState`, when present, must be valid input for `stateSchema`;
 * - every string in `consumes` and `emits` must resolve against local `events`
 *   plus `processorDeps`;
 * - `consumes` and `emits` are contextually typed as the resolved event string
 *   union, so editors can autocomplete event types from owned events and
 *   processor deps while still preserving the literal tuple for reducer and
 *   append inference.
 *
 * `initialState` is optional. If it is omitted, runners initialize by parsing
 * `undefined` through `stateSchema`. If it is present, runners initialize by
 * parsing `initialState` through `stateSchema`.
 */
export function defineProcessorContract<
  const StateSchema extends z.ZodType,
  const Events extends EventCatalog,
  const ProcessorDeps extends readonly unknown[],
  const Consumes extends readonly (ResolvedEventType<Events, ProcessorDeps> | "*")[],
  const Emits extends readonly ResolvedEventType<Events, ProcessorDeps>[],
>(
  contract: ProcessorContractInput<StateSchema, Events, ProcessorDeps, Consumes, Emits>,
): Omit<
  ProcessorContractShape<StateSchema, Events, ProcessorDeps, Consumes, Emits>,
  "stateSchema" | "initialState" | "processorDeps" | "consumes" | "emits"
> & {
  stateSchema: StateSchema;
  initialState?: z.input<StateSchema>;
  processorDeps: ProcessorDeps;
  consumes: Consumes;
  emits: Emits;
};
export function defineProcessorContract<
  const StateSchema extends z.ZodType,
  const Events extends EventCatalog,
  const Consumes extends readonly (ResolvedEventType<Events, readonly []> | "*")[],
  const Emits extends readonly ResolvedEventType<Events, readonly []>[],
>(
  contract: ProcessorContractInputWithoutDeps<StateSchema, Events, Consumes, Emits>,
): Omit<
  ProcessorContractShape<StateSchema, Events, readonly [], Consumes, Emits>,
  "stateSchema" | "initialState" | "processorDeps" | "consumes" | "emits"
> & {
  stateSchema: StateSchema;
  initialState?: z.input<StateSchema>;
  consumes: Consumes;
  emits: Emits;
};
export function defineProcessorContract(contract: unknown) {
  return contract;
}

/**
 * Compile-time exhaustiveness guard for discriminated unions.
 *
 * Use this at the end of `switch (event.type)` in reducers and `processEvent`
 * hooks when the processor should deliberately handle every event in
 * `contract.consumes`.
 *
 * ```ts
 * switch (event.type) {
 *   case "events.iterate.com/agent/input-added":
 *     return nextState;
 *   case "events.iterate.com/agent/status-updated":
 *     return state; // deliberately ignored by the reducer
 *   default:
 *     return assertNever(event);
 * }
 * ```
 *
 * If a new consumed event type is added without a matching `case`, `event` will
 * no longer be `never` in the default branch and TypeScript will fail the
 * build. This is especially useful for processor contracts because
 * `ConsumedEvent<Contract>` is inferred directly from `contract.consumes`.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}

export function buildProcessorIdempotencyKey(args: ProcessorIdempotencyKeyArgs): string {
  const key = `${getProcessorIdempotencySlug(args.processor)}/${args.key}`;
  if (args.sourceEvent == null) return key;
  return `${key}@${args.sourceEvent.offset}`;
}

export function getInitialProcessorState<
  const Contract extends {
    stateSchema: z.ZodType;
    initialState?: unknown;
  },
>(contract: Contract): ProcessorState<Contract> {
  return contract.stateSchema.parse(contract.initialState) as ProcessorState<Contract>;
}

export function runProcessorReduce<
  const Contract extends {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
    reduce?: (args: {
      contract: Contract;
      state: ProcessorState<Contract>;
      event: ConsumedEvent<Contract>;
    }) => ProcessorState<Contract> | null | undefined;
  },
>(args: {
  event: StreamEvent;
  processor: { contract: Contract };
  state: ProcessorState<Contract>;
}): ProcessorReduction<Contract> | undefined {
  const previousState = args.state;
  const eventDefinition = getConsumedEventDefinition({
    contract: args.processor.contract,
    eventType: args.event.type,
  });

  if (eventDefinition == null) {
    return undefined;
  }

  // `eventDefinition` was resolved by string lookup across local `events` and
  // `processorDeps`. Rebuilding the parser from the string key and payload
  // schema keeps replay and live delivery on the same validation path.
  const event = getEventSchema({
    type: args.event.type,
    payloadSchema: eventDefinition.payloadSchema,
  }).parse(args.event) as ConsumedEvent<Contract>;
  const nextState =
    args.processor.contract.reduce?.({
      contract: args.processor.contract,
      state: args.state,
      event,
    }) ?? args.state;

  assertObjectProcessorState({
    processorSlug: getProcessorSlug(args.processor.contract),
    value: nextState,
  });

  return {
    event,
    previousState,
    state: nextState,
  };
}

/**
 * Enforces the invariant that reduced processor state is object-shaped (so
 * state slices can evolve safely and hooks never branch on primitive state).
 * Runners and the `StreamProcessor` class call this after every reduce.
 */
export function assertObjectProcessorState(args: { processorSlug: string; value: unknown }) {
  if (typeof args.value === "object" && args.value !== null && !Array.isArray(args.value)) {
    return;
  }

  throw new Error(`Processor "${args.processorSlug}" state must be an object.`);
}

/**
 * Resolve the payload schema a processor should use for an incoming event:
 * the named definition (from local `events` or `processorDeps`) when the type
 * is listed in `consumes`, a permissive `z.unknown()` definition when the
 * contract consumes `"*"`, and `undefined` when the event is not consumed at
 * all. This is the runtime counterpart of `ConsumedEvent<Contract>`.
 */
export function getConsumedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
    consumesAllEvents?: true;
  };
  eventType: string;
}): EventDefinition | undefined {
  if (!args.contract.consumes.includes(args.eventType)) {
    if (args.contract.consumes.includes("*") || args.contract.consumesAllEvents === true) {
      return {
        payloadSchema: z.unknown(),
      };
    }
    return undefined;
  }

  const eventDefinition = getResolvedEventDefinition({
    contract: args.contract,
    eventType: args.eventType,
  });

  if (eventDefinition == null) {
    throw new Error(`Unresolved stream processor consumes event type "${args.eventType}".`);
  }

  return eventDefinition;
}

function getResolvedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
  };
  eventType: string;
}): EventDefinition | undefined {
  const localEventDefinition = args.contract.events[args.eventType];
  if (localEventDefinition != null) {
    return localEventDefinition;
  }

  for (const dependency of args.contract.processorDeps ?? []) {
    const dependencyEvents = getDependencyEvents(dependency);
    const dependencyEventDefinition = dependencyEvents?.[args.eventType];
    if (dependencyEventDefinition != null) {
      return dependencyEventDefinition;
    }
  }

  return undefined;
}

function getDependencyEvents(dependency: unknown): EventCatalog | undefined {
  if (isEventCatalog(dependency)) {
    return dependency;
  }

  if (
    typeof dependency === "object" &&
    dependency !== null &&
    "events" in dependency &&
    isEventCatalog(dependency.events)
  ) {
    return dependency.events;
  }

  return undefined;
}

function isEventCatalog(value: unknown): value is EventCatalog {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).every(isEventDefinition);
}

function isEventDefinition(value: unknown): value is EventDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "payloadSchema" in value &&
    typeof value.payloadSchema === "object" &&
    value.payloadSchema !== null
  );
}

function getProcessorSlug(contract: unknown): string {
  if (
    typeof contract === "object" &&
    contract !== null &&
    "slug" in contract &&
    typeof contract.slug === "string"
  ) {
    return contract.slug;
  }

  return "unknown";
}

function getProcessorIdempotencySlug(processor: ProcessorIdempotencyKeyProcessor): string {
  if (typeof processor === "string") return processor;
  if ("contract" in processor) return processor.contract.slug;
  return processor.slug;
}
