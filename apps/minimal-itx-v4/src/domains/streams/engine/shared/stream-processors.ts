import { z } from "zod";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
} from "../../schemas.ts";
import type {
  StreamEvent as BaseStreamEvent,
  StreamEventInput as BaseStreamEventInput,
} from "../../../../types.ts";

// =============================================================================
// Stream processor contract model.
//
// This module is vendored into the stream domain and bound to this app's own
// event model (`src/types.ts` types + `domains/streams/schemas.ts` zod). The
// `TypedStreamEvent` / `TypedStreamEventInput` wrappers below re-expose the
// app's non-generic `StreamEvent` / `StreamEventInput` types with the
// `<Type, Payload>` generics the contract machinery needs.
// =============================================================================

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

type NoInferValue<Value> = [Value][Value extends unknown ? 0 : never];

type EventDefinitionWithPayloadExamples<Value> = Value extends {
  payloadSchema: infer PayloadSchema extends z.ZodType;
}
  ? Value extends { examples: infer Examples }
    ? Examples extends readonly EventExample<z.input<PayloadSchema>>[]
      ? Value
      : never
    : Value
  : never;

type EventCatalogWithPayloadExamples<Events extends EventCatalog> = {
  [Key in keyof Events]: EventDefinitionWithPayloadExamples<Events[Key]>;
};

/**
 * Type-level event lookup for string-keyed processor contracts.
 *
 * The event type string is not stored inside the event definition value. It is
 * the key of the event catalog object. These helper types recover "event type
 * string -> payload schema" from those keys.
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
type EventDefinitionFromProcessorDep<
  ProcessorDep,
  Type extends string,
> = ProcessorDep extends unknown
  ? Type extends keyof ContractEventCatalog<ProcessorDep>
    ? ContractEventCatalog<ProcessorDep>[Type]
    : never
  : never;

type EventDefinitionFromProcessorDeps<
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = EventDefinitionFromProcessorDep<ProcessorDeps[number], Type>;

/**
 * Resolve a string event type to the event definition that owns it.
 *
 * Local events win over dependency events in the type-level lookup, but runtime
 * validation rejects duplicate ownership.
 */
type EventDefinitionForType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : EventDefinitionFromProcessorDeps<ProcessorDeps, Type>;

// =============================================================================
// App-bound event-shape types.
//
// These re-express the shared package's `StreamEvent<Type, Payload>` /
// `StreamEventInput<Type, Payload>` shapes on top of this app's non-generic
// `StreamEvent` / `StreamEventInput` types from `src/types.ts`.
// =============================================================================

type TypedStreamEventInput<Type extends string = string, Payload = Record<string, unknown>> = Omit<
  BaseStreamEventInput,
  "payload" | "type"
> & {
  type: Type;
  payload?: Payload;
};

type TypedStreamEvent<Type extends string = string, Payload = Record<string, unknown>> = Omit<
  BaseStreamEvent,
  "payload" | "type"
> &
  TypedStreamEventInput<Type, Payload>;

type EventFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<string, infer PayloadOutput, unknown>
    ? TypedStreamEvent<Type, PayloadOutput> & { payload: PayloadOutput }
    : never;

type InputFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<string, infer PayloadOutput, infer PayloadInput>
    ? TypedStreamEventInput<Type, PayloadOutput | PayloadInput>
    : never;

type EventFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
  : never;

type EventFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number]
  ? Exclude<Types[number], "*"> extends never
    ? BaseStreamEvent
    : EventFromType<Events, ProcessorDeps, Exclude<Types[number], "*">> | WildcardConsumedEvent
  : EventFromType<Events, ProcessorDeps, Types[number]>;

type InputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? InputFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
  : never;

export type ResolvedEventInput<Contract> = Contract extends {
  events: EventCatalog;
}
  ? InputFromType<
      ContractEventCatalog<Contract>,
      ProcessorDepsOf<Contract>,
      ResolvedEventType<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>>
    >
  : never;

type InputFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = InputFromType<Events, ProcessorDeps, Types[number]>;

type ConsumedInputFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number] ? BaseStreamEventInput : InputFromTypes<Events, ProcessorDeps, Types>;

type WildcardConsumedEvent = TypedStreamEvent<"*", unknown> & { payload: unknown };

export type ConsumedEvent<Contract> = Contract extends {
  events: EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Consumes>
  : never;

export type ConsumedInput<Contract> = Contract extends {
  events: EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? ConsumedInputFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Consumes>
  : never;

export type EmittedInput<Contract> = Contract extends {
  events: EventCatalog;
  emits: infer Emits extends readonly string[];
}
  ? InputFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Emits>
  : never;

// =============================================================================
// Processor contract shape and authoring-time input types.
// =============================================================================

type ProcessorContractShape<
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

type UnresolvedEventTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = Exclude<Types[number], ResolvedEventType<Events, ProcessorDeps>>;

type UnresolvedConsumedEventTypes<
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
type ResolvedEventTypesOnly<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = [UnresolvedEventTypes<Events, ProcessorDeps, Types>] extends [never] ? unknown : never;

type ResolvedConsumedEventTypesOnly<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = [UnresolvedConsumedEventTypes<Events, ProcessorDeps, Types>] extends [never] ? unknown : never;

type ProcessorContractInput<
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

type ProcessorContractInputWithoutDeps<
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

// =============================================================================
// Runtime event parsers (bound to this app's event schemas).
// =============================================================================

/**
 * Runtime stream-event parser for a string-keyed event definition.
 *
 * Processor contracts author event definitions as plain
 * `{ description, payloadSchema }` values keyed by the event type string. The
 * key is the durable event type; the value does not repeat it. Runners rebuild
 * the concrete Zod envelope from the catalog key plus `payloadSchema` whenever
 * they validate stream events.
 */
export function getEventSchema<
  const Type extends string,
  const PayloadSchema extends z.ZodType,
>(args: {
  type: Type;
  payloadSchema: PayloadSchema;
}): z.ZodType<
  TypedStreamEvent<Type, z.output<PayloadSchema>>,
  TypedStreamEvent<Type, z.input<PayloadSchema>>
> {
  return z.looseObject({
    type: z.literal(args.type),
    payload: args.payloadSchema,
    metadata: StreamEventSchema.shape.metadata,
    source: StreamEventSchema.shape.source,
    idempotencyKey: StreamEventSchema.shape.idempotencyKey,
    offset: StreamEventSchema.shape.offset,
    createdAt: StreamEventSchema.shape.createdAt,
  }) as unknown as z.ZodType<
    TypedStreamEvent<Type, z.output<PayloadSchema>>,
    TypedStreamEvent<Type, z.input<PayloadSchema>>
  >;
}

export function getEventInputSchema<
  const Type extends string,
  const PayloadSchema extends z.ZodType,
>(args: {
  type: Type;
  payloadSchema: PayloadSchema;
}): z.ZodType<
  TypedStreamEventInput<Type, z.output<PayloadSchema>>,
  TypedStreamEventInput<Type, z.input<PayloadSchema>>
> {
  return z
    .object({
      type: z.literal(args.type),
      payload: args.payloadSchema,
      metadata: StreamEventInputSchema.shape.metadata,
      source: StreamEventInputSchema.shape.source,
      idempotencyKey: StreamEventInputSchema.shape.idempotencyKey,
    })
    .strict() as unknown as z.ZodType<
    TypedStreamEventInput<Type, z.output<PayloadSchema>>,
    TypedStreamEventInput<Type, z.input<PayloadSchema>>
  >;
}

/**
 * Build and validate an append input for any event type resolvable by a
 * processor contract's local `events` catalog or `processorDeps`.
 *
 * This is intentionally pure: it performs contract lookup and Zod parsing only.
 * Callers that need stricter "only consumed" or "only emitted" gates should
 * check `contract.consumes` / `contract.emits` before calling it.
 */
export function buildEvent<
  const Contract extends {
    slug?: string;
    events: EventCatalog;
    processorDeps?: readonly unknown[];
  },
  const Event extends ResolvedEventInput<Contract> & { type: string },
>(args: { contract: Contract; event: Event }): Event {
  const eventDefinition = getResolvedEventDefinition({
    contract: args.contract,
    eventType: args.event.type,
  });

  if (eventDefinition === undefined) {
    const processor = args.contract.slug == null ? "contract" : `processor "${args.contract.slug}"`;
    throw new Error(`${processor} cannot build unresolved event "${args.event.type}".`);
  }

  return getEventInputSchema({
    type: args.event.type,
    payloadSchema: eventDefinition.payloadSchema,
  }).parse(args.event) as Event;
}

// =============================================================================
// Contract definition + reduce machinery.
// =============================================================================

/**
 * Typed identity for processor contracts.
 *
 * This is intentionally not a builder. It returns the exact object it receives
 * and does not rewrite event definitions, inject constants, or generate append
 * helpers. The overloads enforce the important invariants at authoring time:
 *
 * - `stateSchema` must parse to an object-shaped reduced state;
 * - `initialState`, when present, must be valid input for `stateSchema`;
 * - every string in `consumes` and `emits` must resolve against local `events`
 *   plus `processorDeps`;
 * - local `events` must not redefine an event already owned by a
 *   `processorDeps` contract. Event ownership is intentionally one processor
 *   deep: a processor can depend on another owner, but it cannot shadow that
 *   owner's public event type with a second payload schema.
 * - `consumes` and `emits` are contextually typed as the resolved event string
 *   union, so editors can autocomplete event types from owned events and
 *   processor deps while still preserving the literal tuple for reducer and
 *   append inference.
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
  assertNoLocalProcessorDepEventConflicts(contract);
  return contract;
}

export function getInitialProcessorState<
  const Contract extends {
    stateSchema: z.ZodType;
    initialState?: unknown;
  },
>(contract: Contract): ProcessorState<Contract> {
  return contract.stateSchema.parse(contract.initialState) as ProcessorState<Contract>;
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

export function getEmittedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    emits: readonly string[];
  };
  eventType: string;
}): EventDefinition | undefined {
  if (!args.contract.emits.includes(args.eventType)) return undefined;

  const eventDefinition = getResolvedEventDefinition({
    contract: args.contract,
    eventType: args.eventType,
  });

  if (eventDefinition == null) {
    throw new Error(`Unresolved stream processor emits event type "${args.eventType}".`);
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
  if (localEventDefinition != null) return localEventDefinition;

  for (const dependency of args.contract.processorDeps ?? []) {
    const dependencyEvents = getDependencyEvents(dependency);
    const dependencyEventDefinition = dependencyEvents?.[args.eventType];
    if (dependencyEventDefinition != null) return dependencyEventDefinition;
  }

  return undefined;
}

function getDependencyEvents(dependency: unknown): EventCatalog | undefined {
  if (isEventCatalog(dependency)) return dependency;

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

function assertNoLocalProcessorDepEventConflicts(contract: unknown): void {
  if (typeof contract !== "object" || contract === null || !("events" in contract)) return;
  if (!isEventCatalog(contract.events)) return;

  const processorSlug = getProcessorSlug(contract);
  const processorDeps =
    "processorDeps" in contract && Array.isArray(contract.processorDeps)
      ? contract.processorDeps
      : [];

  for (const dependency of processorDeps) {
    const dependencyEvents = getDependencyEvents(dependency);
    if (dependencyEvents === undefined) continue;

    for (const type of Object.keys(contract.events)) {
      if (!Object.prototype.hasOwnProperty.call(dependencyEvents, type)) continue;
      throw new Error(
        `Processor "${processorSlug}" defines event "${type}" that is already owned by processor dependency "${getProcessorSlug(dependency)}".`,
      );
    }
  }
}

function isEventCatalog(value: unknown): value is EventCatalog {
  if (typeof value !== "object" || value === null) return false;
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
