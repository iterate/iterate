import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
} from "./schemas.ts";
import { disposeIgnoredRpcResult } from "./rpc-lifecycle.ts";

type BaseStreamEvent = StreamEvent;
type BaseStreamEventInput = StreamEventInput;

// =============================================================================
// Stream processor contract model.
//
// This module is vendored into the stream domain and bound to this app's own
// event model (`src/types.ts` types + `domains/streams/schemas.ts` zod). The
// `TypedStreamEvent` / `TypedStreamEventInput` wrappers below re-expose the
// app's non-generic `StreamEvent` / `StreamEventInput` types with the
// `<Type, Payload>` generics the contract machinery needs.
// =============================================================================

export type EventDefinition<PayloadOutput = unknown, PayloadInput = PayloadOutput> = {
  description?: string;
  payloadSchema: z.ZodType<PayloadOutput, PayloadInput>;
};

export type EventCatalog = Record<string, EventDefinition<unknown, unknown>>;

/**
 * Type-level event lookup for string-keyed processor contracts.
 *
 * The event type string is not stored inside the event definition value. It is
 * the key of the event catalog object. These helper types recover "event type
 * string -> payload schema" from those keys.
 */
type EventCatalogFromObject<Value> = {
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
type ContractEventCatalog<ContractOrCatalog> = ContractOrCatalog extends {
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
type ResolvedEventType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = Extract<
  keyof EventCatalogFromObject<Events> | EventTypeFromProcessorDeps<ProcessorDeps>,
  string
>;

/**
 * Distributes over each item in `processorDeps` and collects its event keys.
 */
type EventTypeFromProcessorDeps<ProcessorDeps extends readonly unknown[]> =
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
  Definition extends EventDefinition<infer PayloadOutput, unknown>
    ? TypedStreamEvent<Type, PayloadOutput> & { payload: PayloadOutput }
    : never;

type InputFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<infer PayloadOutput, infer PayloadInput>
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
  ? [Exclude<Types[number], "*">] extends [never]
    ? BaseStreamEvent
    : EventFromType<Events, ProcessorDeps, Exclude<Types[number], "*">>
  : EventFromType<Events, ProcessorDeps, Types[number]>;

type InputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? InputFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
  : never;

type ParsedInputFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<infer PayloadOutput, unknown>
    ? TypedStreamEventInput<Type, PayloadOutput> & { payload: PayloadOutput }
    : never;

type ParsedInputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? ParsedInputFromDefinitionForType<EventDefinitionForType<Events, ProcessorDeps, Type>, Type>
  : never;

type ResolvedEventInput<Contract> = Contract extends {
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

type ConsumedEvent<Contract> = Contract extends {
  events: EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Consumes>
  : never;

type EmittedInput<Contract> = Contract extends {
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
   * slices can evolve safely. It must accept `{}` as input; defaults and
   * optional fields express the processor's empty fold.
   */
  stateSchema: StateSchema;
  processorDeps?: ProcessorDeps;
  events: Events;
  consumes: Consumes;
  emits: Emits;
};

type ProcessorContractBuildEvent<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = <
  const Event extends InputFromType<
    Events,
    ProcessorDeps,
    ResolvedEventType<Events, ProcessorDeps>
  > & { type: string },
>(
  event: Event,
) => Event;

type ProcessorContractParseEvent<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = {
  <const Type extends ResolvedEventType<Events, ProcessorDeps>>(
    type: Type,
    event: BaseStreamEvent,
  ): EventFromType<Events, ProcessorDeps, Type>;
  (
    event: BaseStreamEvent,
  ): EventFromType<Events, ProcessorDeps, ResolvedEventType<Events, ProcessorDeps>>;
};

/**
 * Same idea as `parseEvent`, but for append inputs that do not yet have an
 * offset or createdAt.
 *
 * This exists for stream-owned pre-commit policy. The Stream Durable Object has
 * to reject some contract-owned events before they become durable facts. The
 * motivating case is `events.iterate.com/stream/subscription-configured`: if a
 * bad configured subscriber target is only rejected later during the wake side
 * effect, the invalid event has already been appended and reduced into
 * `configuredSubscribersByKey`. The lifecycle tests named
 * "configured durable object subscribers must target the stream project",
 * "global streams reject project-scoped configured durable object subscribers",
 * and "global streams reject configured worker subscribers" all depend on this
 * parser: they assert both that append rejects and that no
 * `subscription-configured` fact is left behind.
 */
type ProcessorContractParseEventInput<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = {
  <const Type extends ResolvedEventType<Events, ProcessorDeps>>(
    type: Type,
    event: BaseStreamEventInput,
  ): ParsedInputFromType<Events, ProcessorDeps, Type>;
  (
    event: BaseStreamEventInput,
  ): ParsedInputFromType<Events, ProcessorDeps, ResolvedEventType<Events, ProcessorDeps>>;
};

type DefaultableObjectStateSchema<StateSchema extends z.ZodType> =
  z.output<StateSchema> extends Record<string, unknown>
    ? {} extends z.input<StateSchema>
      ? StateSchema
      : never
    : never;

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
  stateSchema: DefaultableObjectStateSchema<StateSchema>;
  processorDeps: ProcessorDeps;
  events: Events;
  consumes: Consumes & ResolvedConsumedEventTypesOnly<Events, ProcessorDeps, Consumes>;
  emits: Emits & ResolvedEventTypesOnly<Events, ProcessorDeps, Emits>;
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
  stateSchema: DefaultableObjectStateSchema<StateSchema>;
  processorDeps?: never;
  events: Events;
  consumes: Consumes & ResolvedConsumedEventTypesOnly<Events, readonly [], Consumes>;
  emits: Emits & ResolvedEventTypesOnly<Events, readonly [], Emits>;
};

type ProcessorDepsOf<Contract> = Contract extends {
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
function getEventSchema<const Type extends string, const PayloadSchema extends z.ZodType>(args: {
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

function getEventInputSchema<
  const Type extends string,
  const PayloadSchema extends z.ZodType,
>(args: {
  type: Type;
  payloadSchema: PayloadSchema;
}): z.ZodType<
  TypedStreamEventInput<Type, z.output<PayloadSchema>>,
  TypedStreamEventInput<Type, z.input<PayloadSchema>>
> {
  // This deliberately mirrors `getEventSchema(...)` without offset/createdAt.
  // It gives pre-append policy code the same payload validation as reducers,
  // without fabricating a committed event just to get at the typed payload. In
  // practice this keeps the Stream DO's validation for
  // `subscription-configured` tied to the contract schema instead of hand-coded
  // object checks that could drift from the event definition.
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

// =============================================================================
// Contract definition + reduce machinery.
// =============================================================================

/**
 * Validate an append input against the payload schema resolved from a contract's
 * local `events` plus its `processorDeps`. This is the free-standing form used
 * by call sites that hold a contract but not a processor instance; contracts
 * expose it pre-bound as `contract.buildEvent(...)`.
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
    const owner = args.contract.slug == null ? "contract" : `processor "${args.contract.slug}"`;
    throw new Error(`${owner} cannot build unresolved event "${args.event.type}".`);
  }
  return getEventInputSchema({
    type: args.event.type,
    payloadSchema: eventDefinition.payloadSchema,
  }).parse(args.event) as unknown as Event;
}

/**
 * Typed identity for processor contracts.
 *
 * This is a typed identity plus validation and one convenience method. It keeps
 * the contract object exactly where event ownership is declared while adding
 * `contract.buildEvent(...)`, which is just the pure `buildEvent({ contract,
 * event })` helper with the contract pre-bound, `contract.parseEvent(...)` for
 * committed stream events owned by this contract or its processor deps, and
 * `contract.parseEventInput(...)` for pre-commit append inputs.
 *
 * The overloads enforce the important invariants at authoring time:
 *
 * - `stateSchema` must parse `{}` to an object-shaped reduced state;
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
  "stateSchema" | "processorDeps" | "consumes" | "emits"
> & {
  stateSchema: StateSchema;
  processorDeps: ProcessorDeps;
  consumes: Consumes;
  emits: Emits;
  buildEvent: ProcessorContractBuildEvent<Events, ProcessorDeps>;
  parseEvent: ProcessorContractParseEvent<Events, ProcessorDeps>;
  parseEventInput: ProcessorContractParseEventInput<Events, ProcessorDeps>;
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
  "stateSchema" | "processorDeps" | "consumes" | "emits"
> & {
  stateSchema: StateSchema;
  consumes: Consumes;
  emits: Emits;
  buildEvent: ProcessorContractBuildEvent<Events, readonly []>;
  parseEvent: ProcessorContractParseEvent<Events, readonly []>;
  parseEventInput: ProcessorContractParseEventInput<Events, readonly []>;
};
export function defineProcessorContract(contract: unknown) {
  assertNoLocalProcessorDepEventConflicts(contract);
  assertDefaultStateSchema(contract);
  if (typeof contract !== "object" || contract === null) {
    throw new Error("Processor contract must be an object.");
  }
  if ("buildEvent" in contract) {
    throw new Error(`Processor "${getProcessorSlug(contract)}" must not define buildEvent.`);
  }
  if ("parseEvent" in contract) {
    throw new Error(`Processor "${getProcessorSlug(contract)}" must not define parseEvent.`);
  }
  if ("parseEventInput" in contract) {
    throw new Error(`Processor "${getProcessorSlug(contract)}" must not define parseEventInput.`);
  }
  const typedContract = contract as {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
  };
  return Object.assign(typedContract, {
    buildEvent(event: { type: string }) {
      return buildEvent({
        contract: typedContract,
        event: event as ResolvedEventInput<typeof typedContract> & { type: string },
      });
    },
    parseEvent(typeOrEvent: string | BaseStreamEvent, maybeEvent?: BaseStreamEvent) {
      const eventType = typeof typeOrEvent === "string" ? typeOrEvent : typeOrEvent.type;
      const event = typeof typeOrEvent === "string" ? maybeEvent : typeOrEvent;
      if (event === undefined) {
        throw new Error(`Processor "${getProcessorSlug(typedContract)}" parseEvent missing event.`);
      }
      const eventDefinition = getResolvedEventDefinition({
        contract: typedContract,
        eventType,
      });
      if (eventDefinition == null) {
        throw new Error(
          `Processor "${getProcessorSlug(typedContract)}" cannot parse unresolved event "${eventType}".`,
        );
      }
      return getEventSchema({
        type: eventType,
        payloadSchema: eventDefinition.payloadSchema,
      }).parse(event);
    },
    parseEventInput(typeOrEvent: string | BaseStreamEventInput, maybeEvent?: BaseStreamEventInput) {
      // Used by the Stream DO append gate. Keeping this next to parseEvent is
      // intentional: both methods resolve the payload schema from the contract
      // catalog, so a future edit to a core event schema automatically affects
      // both committed-event reduction and pre-commit validation.
      const eventType = typeof typeOrEvent === "string" ? typeOrEvent : typeOrEvent.type;
      const event = typeof typeOrEvent === "string" ? maybeEvent : typeOrEvent;
      if (event === undefined) {
        throw new Error(
          `Processor "${getProcessorSlug(typedContract)}" parseEventInput missing event.`,
        );
      }
      const eventDefinition = getResolvedEventDefinition({
        contract: typedContract,
        eventType,
      });
      if (eventDefinition == null) {
        throw new Error(
          `Processor "${getProcessorSlug(typedContract)}" cannot parse unresolved event "${eventType}".`,
        );
      }
      return getEventInputSchema({
        type: eventType,
        payloadSchema: eventDefinition.payloadSchema,
      }).parse(event);
    },
  });
}

/**
 * Enforces the invariant that reduced processor state is object-shaped (so
 * state slices can evolve safely and hooks never branch on primitive state).
 * Runners and the `StreamProcessor` class call this after every reduce.
 */
function assertObjectProcessorState(args: { processorSlug: string; value: unknown }) {
  if (typeof args.value === "object" && args.value !== null && !Array.isArray(args.value)) {
    return;
  }

  throw new Error(`Processor "${args.processorSlug}" state must be an object.`);
}

function assertDefaultStateSchema(contract: unknown): void {
  if (typeof contract !== "object" || contract === null) {
    throw new Error("Processor contract must be an object.");
  }
  const processorSlug = getProcessorSlug(contract);
  if (!("stateSchema" in contract) || !isZodSchema(contract.stateSchema)) {
    throw new Error(`Processor "${processorSlug}" must define stateSchema.`);
  }

  let defaultState: unknown;
  try {
    defaultState = contract.stateSchema.parse({});
  } catch (error) {
    throw new Error(`Processor "${processorSlug}" stateSchema must parse {}.`, {
      cause: error,
    });
  }

  assertObjectProcessorState({ processorSlug, value: defaultState });
}

/**
 * Resolve the payload schema a processor should use for an incoming event:
 * the named definition (from local `events` or `processorDeps`) when the type
 * is listed in `consumes`, a permissive `z.unknown()` definition when the
 * contract consumes `"*"`, and `undefined` when the event is not consumed at
 * all. This is the runtime counterpart of `ConsumedEvent<Contract>`.
 */
function getConsumedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
  };
  eventType: string;
}): EventDefinition | undefined {
  if (!args.contract.consumes.includes(args.eventType)) {
    // A `"*"` in consumes means "every event, validated permissively".
    if (args.contract.consumes.includes("*")) {
      return { payloadSchema: z.unknown() };
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

function getEmittedEventDefinition(args: {
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

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof value.parse === "function"
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

// =============================================================================
// Class-based stream processor runtime.
// =============================================================================

type MaybePromise<T> = T | Promise<T>;

/**
 * The structural slice of a processor contract that the class needs. Contracts
 * built with `defineProcessorContract(...)` satisfy this; the full contract
 * type flows through the `Contract` type parameter so event/state inference
 * reaches the hooks.
 */
export type StreamProcessorContract = {
  slug: string;
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  emits: readonly string[];
  buildEvent(event: { type: string }): { type: string };
  parseEvent(event: StreamEvent): StreamEvent;
};

/**
 * Host-provided constructor dependencies shared by every processor:
 * the stream append capability, optional checkpoint storage
 * (`readState`/`writeState`), and an optional `keepAliveWhile` hook for hosts
 * whose runtime would otherwise shut down while async work is in flight (e.g.
 * a Durable Object).
 */
export type StreamProcessorBaseDeps<Contract> = {
  stream: Stream;
  keepAliveWhile?: (work: () => Promise<unknown>) => void;
} & StreamProcessorStateStorage<ProcessorState<Contract>>;

// These arg shapes are intentionally not exported: subclass overrides annotate their
// args as `Parameters<StreamProcessor<Contract>["method"]>[0]` (enforced by the
// `iterate/stream-processor-override-args` lint rule) so there is exactly one spelling.
//
// State and events are passed by reference. Hooks must treat them as immutable:
// `reduce` returns a new state object instead of mutating its input.
type ReducedEvent<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

type ReduceArgs<Contract> = {
  event: ConsumedEvent<Contract>;
  state: ProcessorState<Contract>;
};

type SideEffectHelpers = {
  /** Hold the checkpoint (and the next batch) until this work completes. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** Fire-and-forget work; failures are caught and logged. */
  runInBackground: (work: () => Promise<unknown>) => void;
};

type EmitHelpers<Contract> = {
  /** Append one or more events listed in `contract.emits`. */
  append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
};

type ProcessEventArgs<Contract> = ReducedEvent<Contract> &
  SideEffectHelpers &
  EmitHelpers<Contract> & {
    streamMaxOffset: number;
    /**
     * The offset this batch will checkpoint through once all blocking work
     * completes — the last event offset in the batch, not this event's offset.
     */
    checkpointOffset: number;
  };

type ProcessEventBatchArgs<Contract> = SideEffectHelpers & {
  /** Append one or more events listed in `contract.emits`. */
  append: EmitHelpers<Contract>["append"];
  /** New events past the checkpoint, in stream order, consumed or not. */
  events: readonly StreamEvent[];
  /** The consumed subset of `events`, each with its reduction result. */
  reducedEvents: readonly ReducedEvent<Contract>[];
  /** Processor state when the batch started. */
  previousState: ProcessorState<Contract>;
  /** Processor state after every event in the batch has been reduced. */
  state: ProcessorState<Contract>;
  streamMaxOffset: number;
  checkpointOffset: number;
};

/**
 * A durable checkpoint: the reduced state plus the highest stream offset that
 * has been fully reduced and processed. Written atomically per batch.
 */
export type StreamProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

/**
 * A processor's inspectable live state. `snapshot` is the durable checkpoint:
 * reduced state at a known stream offset. `runtime` is for operational data
 * that is useful to UIs and operators but is not part of replay correctness.
 */
export type StreamProcessorRuntimeState<State> = {
  snapshot: StreamProcessorSnapshot<State>;
  runtime?: Record<string, unknown>;
};

type StateChangeCallback<State> = (state: State) => unknown;
type RetainedStateChangeCallback<State> = StateChangeCallback<State> & Disposable;

/** A pending `waitUntilEvent` waiter: the match predicate, the resolver to fire
 *  when a delivered event matches, and an optional timeout handle to clear on
 *  resolution (so a satisfied waiter never later rejects). */
type EventWaiter = {
  predicate: (event: StreamEvent) => boolean;
  reject: (error: unknown) => void;
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Where checkpoints live. Hosts inject these; when omitted the processor keeps
 * an in-memory snapshot, which is enough for tests and stateless experiments.
 * `readState` is called once, lazily, before the first batch; `writeState` is
 * called after each successful batch.
 */
export type StreamProcessorStateStorage<State> = {
  readState?: () => MaybePromise<StreamProcessorSnapshot<State> | undefined>;
  writeState?: (snapshot: StreamProcessorSnapshot<State>) => MaybePromise<void>;
};

/**
 * Constructor args are the base deps plus the subclass's own `Deps` flattened
 * into one object, e.g. `new BrowserRawEventsProcessor({ stream, sql,
 * readState, writeState })`.
 */
export type StreamProcessorConstructorArgs<
  Contract extends StreamProcessorContract,
  Deps extends object,
> = StreamProcessorBaseDeps<Contract> & Deps;

/**
 * Class-based stream processor.
 *
 * The model in one sentence: the host feeds ordered event batches into
 * `ingest`, the base reduces each new event into state, hands the batch to the
 * `process*` hooks for side effects, and checkpoints state + offset once all
 * blocking work has completed.
 *
 * `ingest` is host plumbing; the `process*` family is the authoring surface.
 * Subclasses override up to three hooks:
 *
 * - `reduce` — pure projection of one consumed event into the next state
 * - `processEvent` — synchronous per-event side effects; what most processors
 *   implement
 * - `processEventBatch` — batch-level side effects (e.g. one SQLite
 *   transaction); the default implementation calls `processEvent` once per
 *   reduced event
 *
 * plus an optional one-time `prepare` for setup that must land before the
 * checkpoint is first read (e.g. schema migrations that reset it).
 *
 * Every hook runs inside the serialized batch section: a later batch never
 * starts until the previous one has completed or failed, and the checkpoint is
 * only written after the hooks (plus any `blockProcessorWhile` work) succeed.
 * `ingest` itself must not be overridden.
 */
export abstract class StreamProcessor<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> extends RpcTarget {
  abstract readonly contract: Contract;
  protected readonly stream: Stream;
  protected readonly deps: Deps;

  #checkpointOffset = 0;
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: #loadState reads and assigns this via ??=.
  #loaded: Promise<void> | undefined;
  #processing: Promise<void> = Promise.resolve();
  #state: ProcessorState<Contract> | undefined;
  #memorySnapshot: StreamProcessorSnapshot<ProcessorState<Contract>> | undefined;
  readonly #keepAliveWhile: ((work: () => Promise<unknown>) => void) | undefined;
  readonly #readState: () => MaybePromise<
    StreamProcessorSnapshot<ProcessorState<Contract>> | undefined
  >;
  readonly #writeState: (
    snapshot: StreamProcessorSnapshot<ProcessorState<Contract>>,
  ) => MaybePromise<void>;
  readonly #stateChangeCallbacks = new Set<RetainedStateChangeCallback<ProcessorState<Contract>>>();
  readonly #eventWaiters = new Set<EventWaiter>();

  constructor(args: StreamProcessorConstructorArgs<Contract, Deps>) {
    super();
    // Base deps are destructured out; everything else is the subclass's Deps.
    const { stream, keepAliveWhile, readState, writeState, ...deps } = args;
    this.stream = stream;
    this.deps = deps as Deps;
    this.#keepAliveWhile = keepAliveWhile;
    this.#readState = readState ?? (() => this.#memorySnapshot);
    this.#writeState =
      writeState ??
      ((snapshot) => {
        this.#memorySnapshot = snapshot;
      });
  }

  /** Current reduced state. Initial state until the first batch loads/reduces. */
  get state(): ProcessorState<Contract> {
    return this.#getState();
  }

  /** Highest stream offset this processor has durably processed through. */
  get checkpointOffset(): number {
    return this.#checkpointOffset;
  }

  /** Loads (once) and returns the current checkpoint. Hosts use the offset as the replay cursor. */
  async snapshot(): Promise<StreamProcessorSnapshot<ProcessorState<Contract>>> {
    await this.#loadState();
    return {
      offset: this.#checkpointOffset,
      state: this.#getState(),
    };
  }

  /** Returns the broad processor runtime view; subclasses may add operational `runtime` data. */
  async getRuntimeState(): Promise<StreamProcessorRuntimeState<ProcessorState<Contract>>> {
    return { snapshot: await this.snapshot() };
  }

  /**
   * The host-facing sink. Batches are serialized in memory: a later batch never
   * starts until the previous one completed or failed. Do not override this —
   * extend `processEventBatch` instead.
   */
  async ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void> {
    const next = this.#processing.then(() => this.#ingest(args));
    this.#processing = next.catch(() => undefined);
    return await next;
  }

  async onStateChange(
    cb: StateChangeCallback<ProcessorState<Contract>>,
  ): Promise<(() => void) & Disposable> {
    await this.#loadState();
    const retained = retainStateChangeCallback(cb);
    this.#stateChangeCallbacks.add(retained);

    let disposed = false;
    const unsubscribe = Object.assign(
      () => {
        if (disposed) return;
        disposed = true;
        this.#stateChangeCallbacks.delete(retained);
        retained[Symbol.dispose]();
      },
      { [Symbol.dispose]: () => unsubscribe() },
    );

    try {
      this.#callStateChangeCallback(retained, this.#getState());
    } catch (error) {
      unsubscribe();
      throw error;
    }

    return unsubscribe;
  }

  /**
   * Resolve once the processor INGESTS an event matching `predicate` — or, with
   * the `{ offset }` form, once the fold has caught up to that stream offset.
   *
   * The promise settles inside the serialized ingest section AFTER the batch is
   * durably checkpointed, so by the time it resolves `this.state` already
   * reflects the matched event. That is what makes the `{ offset }` form a
   * read-your-writes barrier: append an event, then `await
   * waitUntilEvent({ offset })` on the offset `append` returned, and your next
   * read is guaranteed to see your write. It replaces the usual spin-poll on
   * `checkpointOffset`.
   *
   * `{ offset }` is implemented in terms of `{ predicate }`: it short-circuits
   * when the checkpoint is already at/past the offset, otherwise it waits for
   * the first delivered event at or beyond it. The predicate form only observes
   * FUTURE deliveries (it does not scan history), so the offset form is what can
   * also answer "this already happened". Keying on the delivered event — not on
   * a state change — matters: the checkpoint advances for every event including
   * ones `reduce` ignores, so this resolves even when the matched event produced
   * no state change (where waiting on `onStateChange` would hang).
   *
   * `predicate` runs on every newly delivered event (consumed or not). If it
   * throws, only that waiter rejects; the already-checkpointed ingest continues.
   *
   * `timeoutMs` bounds the wait: if no matching event is delivered in time the
   * promise REJECTS (and the waiter is dropped), turning an indefinitely-stalled
   * subscription into a loud, catchable error instead of a hang. Omit it to wait
   * forever. A waiter that resolves normally clears its timer, so it can never
   * both resolve and later reject.
   */
  waitUntilEvent(args: {
    predicate: (event: StreamEvent) => boolean;
    timeoutMs?: number;
  }): Promise<void>;
  waitUntilEvent(args: { offset: number; timeoutMs?: number }): Promise<void>;
  async waitUntilEvent(
    args:
      | { predicate: (event: StreamEvent) => boolean; timeoutMs?: number }
      | { offset: number; timeoutMs?: number },
  ): Promise<void> {
    if ("offset" in args) {
      await this.#loadState();
      if (this.#checkpointOffset >= args.offset) return;
      const { offset, timeoutMs } = args;
      // No await between the check above and registering the waiter below, so a
      // batch cannot advance the checkpoint past `offset` in the gap and be missed.
      return await this.waitUntilEvent({ predicate: (event) => event.offset >= offset, timeoutMs });
    }
    const { predicate, timeoutMs } = args;
    await new Promise<void>((resolve, reject) => {
      const waiter: EventWaiter = { predicate, reject, resolve };
      this.#eventWaiters.add(waiter);
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.#eventWaiters.delete(waiter);
          reject(new Error(`waitUntilEvent timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /**
   * One-time async setup, run before the checkpoint is first read — whether
   * that happens via `snapshot()` or the first ingested batch. Override for
   * work that can invalidate the stored checkpoint, such as schema migrations
   * that reset projection tables, so it always lands before the resume cursor
   * is decided. Failures reject the triggering call and retry on the next one.
   */
  protected async prepare(): Promise<void> {}

  /** Build and validate an append input for any event resolvable by this processor contract. */
  protected buildEvent(
    event: ResolvedEventInput<Contract> & { type: string },
  ): ResolvedEventInput<Contract> & { type: string } {
    return this.contract.buildEvent(event) as ResolvedEventInput<Contract> & { type: string };
  }

  /** Build and validate an append input for an event listed in `contract.emits`. */
  protected buildEmittedEvent(event: EmittedInput<Contract>): EmittedInput<Contract> {
    return this.#parseEventInput({
      event,
      eventDefinition: getEmittedEventDefinition({
        contract: this.contract,
        eventType: event.type,
      }),
      kind: "emitted",
    }) as EmittedInput<Contract>;
  }

  /**
   * Pure projection of one consumed event into the next state. Defaults to
   * identity; returning `null`/`undefined` also keeps the current state.
   */
  protected reduce(args: ReduceArgs<Contract>): ProcessorState<Contract> | null | undefined {
    return args.state;
  }

  /** Synchronous per-event side-effect hook, called by the default `processEventBatch`. */
  protected processEvent(_args: ProcessEventArgs<Contract>): undefined {}

  /**
   * Batch-level side-effect hook. Runs inside the serialized section, after the
   * whole batch has been reduced and before the checkpoint is written, so an
   * override can e.g. commit all projection writes in one SQLite transaction.
   * Call `super.processEventBatch(args)` to keep the per-event `processEvent` calls.
   */
  protected async processEventBatch(args: ProcessEventBatchArgs<Contract>): Promise<void> {
    for (const reducedEvent of args.reducedEvents) {
      this.processEvent({
        ...reducedEvent,
        streamMaxOffset: args.streamMaxOffset,
        checkpointOffset: args.checkpointOffset,
        blockProcessorWhile: args.blockProcessorWhile,
        runInBackground: args.runInBackground,
        append: args.append,
      });
    }
  }

  /**
   * Reduce one raw stream event against explicit state, without touching the
   * processor's own state or checkpoint. Returns `undefined` for events this
   * processor does not consume. Private: only the batch loop calls it.
   */
  #reduceRawEvent(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ReducedEvent<Contract> | undefined {
    const eventDefinition = getConsumedEventDefinition({
      contract: this.contract,
      eventType: args.event.type,
    });
    if (eventDefinition === undefined) return undefined;

    // Rebuilding the parser from the catalog key and payload schema keeps replay
    // and live delivery on the same validation path.
    const event = getEventSchema({
      type: args.event.type,
      payloadSchema: eventDefinition.payloadSchema,
    }).parse(args.event) as ConsumedEvent<Contract>;

    const state = this.reduce({ event, state: args.state }) ?? args.state;
    assertObjectProcessorState({ processorSlug: this.contract.slug, value: state });

    return { event, previousState: args.state, state };
  }

  /** Fire-and-forget async work backed by the host's keep-alive, with failures logged. */
  protected runInBackground(work: () => Promise<unknown>): void {
    this.#runKeepAliveBackedWork(work).catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }

  async #ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void> {
    await this.#loadState();

    const previousState = this.#getState();
    let state = previousState;
    let checkpointOffset = this.#checkpointOffset;
    const events: StreamEvent[] = [];
    const reducedEvents: ReducedEvent<Contract>[] = [];

    for (const event of args.events) {
      if (event.offset <= checkpointOffset) continue;
      events.push(event);
      checkpointOffset = event.offset;

      const reduction = this.#reduceRawEvent({ event, state });
      if (reduction === undefined) continue;
      reducedEvents.push(reduction);
      state = reduction.state;
    }

    if (events.length === 0) return;

    const blockingWork: Promise<unknown>[] = [];
    try {
      await this.processEventBatch({
        events,
        reducedEvents,
        previousState,
        state,
        streamMaxOffset: args.streamMaxOffset,
        checkpointOffset,
        append: (...input) => this.#appendEmitted(...input),
        blockProcessorWhile: (work) => {
          blockingWork.push(this.#runKeepAliveBackedWork(work));
        },
        runInBackground: (work) => this.runInBackground(work),
      });
      await Promise.all(blockingWork);
    } catch (error) {
      // A failed batch must still settle work it already registered so nothing
      // rejects unobserved. The checkpoint is not written, so the batch stays
      // retryable — the host re-handshakes from the checkpoint on failure and
      // the stream replays it (see createStreamProcessorHost).
      await Promise.allSettled(blockingWork);
      throw error;
    }

    // Persist before advancing in-memory state. If the durable write fails, the
    // batch must stay retryable: the redelivered batch re-reduces from the old
    // state and tries the write again. Advancing #state/#checkpointOffset first
    // would make the retry a silent no-op (every event filtered out, nothing
    // re-saved), so a transient write failure would lose the batch durably.
    await this.#writeState({ offset: checkpointOffset, state });
    this.#state = state;
    this.#checkpointOffset = checkpointOffset;
    if (!Object.is(previousState, state)) this.#notifyStateChange(state);
    this.#resolveEventWaiters(events);
  }

  #appendEmitted(...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    const events = input.map((event) => this.buildEmittedEvent(event) as StreamEventInput);
    return this.stream.append(...events);
  }

  #parseEventInput(args: {
    event: { type: string };
    eventDefinition: EventDefinition | undefined;
    kind: string;
  }) {
    if (args.eventDefinition === undefined) {
      throw new Error(
        `Processor "${this.contract.slug}" cannot build ${args.kind} event "${args.event.type}".`,
      );
    }

    return getEventInputSchema({
      type: args.event.type,
      payloadSchema: args.eventDefinition.payloadSchema,
    }).parse(args.event);
  }

  // Settle `waitUntilEvent` waiters whose predicate matches a just-delivered
  // event. Runs after the durable write + checkpoint advance, so `this.state` is
  // current when a waiter's promise resolves (the read-your-writes guarantee).
  #resolveEventWaiters(events: readonly StreamEvent[]): void {
    for (const waiter of this.#eventWaiters) {
      let matched = false;
      try {
        matched = events.some(waiter.predicate);
      } catch (error) {
        this.#eventWaiters.delete(waiter);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(error);
        continue;
      }
      if (matched) {
        this.#eventWaiters.delete(waiter);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  #notifyStateChange(state: ProcessorState<Contract>): void {
    for (const callback of [...this.#stateChangeCallbacks]) {
      try {
        this.#callStateChangeCallback(callback, state);
      } catch (error) {
        this.#stateChangeCallbacks.delete(callback);
        callback[Symbol.dispose]();
        console.error("stream processor state change callback failed", error);
      }
    }
  }

  #callStateChangeCallback(
    callback: StateChangeCallback<ProcessorState<Contract>>,
    state: ProcessorState<Contract>,
  ): void {
    disposeIgnoredRpcResult(callback(state));
  }

  // keepAliveWhile is fire-and-forget from the host's point of view (it only
  // keeps the runtime alive while the work runs), so this bridges the work's
  // result/failure back into a promise the batch loop can await.
  async #runKeepAliveBackedWork(work: () => Promise<unknown>): Promise<unknown> {
    if (this.#keepAliveWhile === undefined) return await work();

    return await new Promise<unknown>((resolve, reject) => {
      this.#keepAliveWhile!(async () => {
        try {
          const result = await work();
          resolve(result);
          return result;
        } catch (error) {
          reject(error);
          throw error;
        }
      });
    });
  }

  async #loadState(): Promise<void> {
    this.#loaded ??= (async () => {
      await this.prepare();
      const snapshot = await this.#readState();
      if (snapshot === undefined) {
        this.#state ??= this.contract.stateSchema.parse({}) as ProcessorState<Contract>;
        return;
      }
      this.#state = this.contract.stateSchema.parse(snapshot.state) as ProcessorState<Contract>;
      this.#checkpointOffset = snapshot.offset;
    })().catch((error: unknown) => {
      // Clear the memoized load so a later batch retries the snapshot read
      // instead of replaying this rejection forever.
      this.#loaded = undefined;
      throw error;
    });
    await this.#loaded;
  }

  #getState(): ProcessorState<Contract> {
    this.#state ??= this.contract.stateSchema.parse({}) as ProcessorState<Contract>;
    return this.#state;
  }
}

function retainStateChangeCallback<State>(
  cb: StateChangeCallback<State>,
): RetainedStateChangeCallback<State> {
  const retainable = cb as StateChangeCallback<State> &
    Partial<Disposable> & {
      dup?(): RetainedStateChangeCallback<State>;
    };
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  return Object.assign((state: State) => retained(state), {
    [Symbol.dispose]() {
      dispose?.();
    },
  });
}
