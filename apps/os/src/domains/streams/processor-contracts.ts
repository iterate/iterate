import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
} from "./schemas.ts";

/**
 * Merge one processor configuration patch into its current configuration.
 *
 * Configuration patches recurse only through plain JSON objects. Arrays,
 * scalars, and `null` replace the previous value wholesale; omitted keys are
 * retained. Processors validate the merged result with their own complete
 * configuration schema before storing it in reduced state.
 */
export function mergeProcessorConfig(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(patchValue)
        ? mergeProcessorConfig(baseValue, patchValue)
        : patchValue;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// =============================================================================
// Processor contracts.
//
// A contract declares a processor's identity (slug/version/description), its
// reduced-state schema, the events it owns (`events`, keyed by the durable
// event type string), the events it `consumes` and `emits`, and optional
// `processorDeps` — other contracts whose events it may consume/emit without
// owning them. `defineProcessorContract(...)` validates the declaration and
// attaches typed `buildEvent` / `parseEvent` / `parseEventInput` helpers.
//
// The type-level machinery below exists for one purpose: resolving an event
// type STRING to the payload schema that owns it (local `events` first, then
// `processorDeps`), so reducers, emit helpers, and append call sites all infer
// payload types from the same declaration and typos fail at the definition site.
// =============================================================================

/**
 * One documented example payload for an owned event, rendered on the public
 * event docs site (events.iterate.com). The payload must parse against the
 * event's `payloadSchema` — enforced by the event-docs unit tests rather than
 * at module load, so a bad example fails CI instead of bricking a worker boot.
 */
export type EventExample = {
  /** What this example shows, e.g. "Push delivery to another stream's acceptCrossPost". */
  description: string;
  /** The example payload, in the payload schema's input shape. */
  payload: unknown;
};

/** One owned event: its payload schema plus optional human description and examples. */
export type EventDefinition<PayloadOutput = unknown, PayloadInput = PayloadOutput> = {
  description?: string;
  payloadSchema: z.ZodType<PayloadOutput, PayloadInput>;
  examples?: readonly EventExample[];
};

/** A contract's owned events, keyed by the durable event type string. */
export type EventCatalog = Record<string, EventDefinition<unknown, unknown>>;

/** The string-keyed event definitions of a catalog object (index signatures excluded). */
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
 * A `processorDeps` entry may be a full contract (`{ events: ... }`) or a
 * standalone event catalog, so a processor can depend on another processor's
 * contract or on a small shared catalog.
 */
type ContractEventCatalog<ContractOrCatalog> = ContractOrCatalog extends {
  events: infer Events;
}
  ? EventCatalogFromObject<Events>
  : EventCatalogFromObject<ContractOrCatalog>;

/** All event type strings resolvable from local `events` plus `processorDeps`. */
type ResolvedEventType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = Extract<
  keyof EventCatalogFromObject<Events> | EventTypeFromProcessorDeps<ProcessorDeps>,
  string
>;

/** Union of every event type string owned by any `processorDeps` entry. */
type EventTypeFromProcessorDeps<ProcessorDeps extends readonly unknown[]> =
  ProcessorDeps[number] extends infer ProcessorDep
    ? ProcessorDep extends unknown
      ? keyof ContractEventCatalog<ProcessorDep>
      : never
    : never;

/**
 * Resolve a string event type to the definition that owns it. Local events win
 * in the type-level lookup; runtime validation rejects duplicate ownership.
 */
type EventDefinitionForType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : ProcessorDeps[number] extends infer ProcessorDep
    ? ProcessorDep extends unknown
      ? Type extends keyof ContractEventCatalog<ProcessorDep>
        ? ContractEventCatalog<ProcessorDep>[Type]
        : never
      : never
    : never;

// -----------------------------------------------------------------------------
// Event shapes: the app's non-generic `StreamEvent` / `StreamEventInput` from
// `./schemas.ts`, re-expressed with `<Type, Payload>` generics for inference.
// -----------------------------------------------------------------------------

/** `StreamEventInput` with `type`/`payload` narrowed to one event definition. */
export type TypedStreamEventInput<
  Type extends string = string,
  Payload = Record<string, unknown>,
> = Omit<StreamEventInput, "payload" | "type"> & {
  type: Type;
  payload?: Payload;
};

/** `StreamEvent` with `type`/`payload` narrowed to one event definition. */
type TypedStreamEvent<Type extends string = string, Payload = Record<string, unknown>> = Omit<
  StreamEvent,
  "payload" | "type"
> &
  TypedStreamEventInput<Type, Payload>;

/** Committed event for one resolved type (payload parsed, so required). */
type EventFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventDefinitionForType<Events, ProcessorDeps, Type> extends EventDefinition<
      infer PayloadOutput,
      unknown
    >
    ? TypedStreamEvent<Type, PayloadOutput> & { payload: PayloadOutput }
    : never
  : never;

/** Union of committed-event shapes for a `consumes` tuple; `"*"` alone means any `StreamEvent`. */
type EventFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number]
  ? [Exclude<Types[number], "*">] extends [never]
    ? StreamEvent
    : EventFromType<Events, ProcessorDeps, Exclude<Types[number], "*">>
  : EventFromType<Events, ProcessorDeps, Types[number]>;

/** Append input for one resolved type (payload accepts the schema's input shape). */
type InputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventDefinitionForType<Events, ProcessorDeps, Type> extends EventDefinition<
      infer PayloadOutput,
      infer PayloadInput
    >
    ? TypedStreamEventInput<Type, PayloadOutput | PayloadInput>
    : never
  : never;

/** Public append input for one consumed type, before its payload schema parses. */
type ConsumedInputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventDefinitionForType<Events, ProcessorDeps, Type> extends EventDefinition<
      unknown,
      infer PayloadInput
    >
    ? TypedStreamEventInput<Type, PayloadInput>
    : never
  : never;

/** Union of append-input shapes for a `consumes` tuple; `"*"` means any input. */
type InputFromTypes<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number]
  ? StreamEventInput
  : ConsumedInputFromType<Events, ProcessorDeps, Types[number]>;

/** Parsed append input for one resolved type (payload validated, so required). */
type ParsedInputFromType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? EventDefinitionForType<Events, ProcessorDeps, Type> extends EventDefinition<
      infer PayloadOutput,
      unknown
    >
    ? TypedStreamEventInput<Type, PayloadOutput> & { payload: PayloadOutput }
    : never
  : never;

/** Union of committed-event shapes a contract's `consumes` list can deliver to `reduce`. */
export type ConsumedEvent<Contract> = Contract extends {
  events: EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Consumes>
  : never;

/** Union of append-input shapes for the events in a contract's `consumes` list. */
export type ConsumedInput<Contract> = Contract extends {
  events: EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? InputFromTypes<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Consumes>
  : never;

/** Union of append-input shapes a contract's `emits` list allows a processor to append. */
export type EmittedInput<Contract> = Contract extends {
  events: EventCatalog;
  emits: infer Emits extends readonly string[];
}
  ? InputFromType<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>, Emits[number]>
  : never;

/** A contract's `processorDeps` tuple, defaulting to empty when absent. */
type ProcessorDepsOf<Contract> = Contract extends {
  processorDeps?: infer ProcessorDeps;
}
  ? ProcessorDeps extends readonly unknown[]
    ? ProcessorDeps
    : readonly []
  : readonly [];

/** A contract's reduced-state type, inferred from its `stateSchema`. */
export type ProcessorState<Contract> = Contract extends {
  stateSchema: infer State extends z.ZodType;
}
  ? z.output<State>
  : never;

// -----------------------------------------------------------------------------
// Authoring-time validation types for defineProcessorContract.
// -----------------------------------------------------------------------------

/** Reduced state must be object-shaped and must accept `{}` (the empty fold). */
type DefaultableObjectStateSchema<StateSchema extends z.ZodType> =
  z.output<StateSchema> extends Record<string, unknown>
    ? {} extends z.input<StateSchema>
      ? StateSchema
      : never
    : never;

/**
 * Compile-time typo guard for `consumes` / `emits`: resolves to `unknown` when
 * every string in `Types` is resolvable (leaving the contract argument
 * unchanged), `never` when one is not — failing the call where the bad string
 * is written. `AllowStar` admits the `"*"` wildcard (consumes only).
 */
type ResolvedEventTypesOnly<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
  AllowStar extends string = never,
> = [Exclude<Exclude<Types[number], AllowStar>, ResolvedEventType<Events, ProcessorDeps>>] extends [
  never,
]
  ? unknown
  : never;

/** `contract.buildEvent(...)`: validate an append input against the resolved payload schema. */
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

/** `contract.parseEvent(...)`: validate a committed event, optionally narrowed by an explicit type string. */
type ProcessorContractParseEvent<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = {
  <const Type extends ResolvedEventType<Events, ProcessorDeps>>(
    type: Type,
    event: StreamEvent,
  ): EventFromType<Events, ProcessorDeps, Type>;
  (
    event: StreamEvent,
  ): EventFromType<Events, ProcessorDeps, ResolvedEventType<Events, ProcessorDeps>>;
};

/**
 * Same as `parseEvent`, but for append inputs that do not yet have an offset or
 * createdAt. This exists for stream-owned pre-commit policy: the Stream Durable
 * Object must reject some contract-owned events BEFORE they become durable
 * facts (see `validateAppend` in stream-durable-object.ts) — validating them
 * later, in the wake side effect, would leave the invalid event committed and
 * reduced into durable state. The lifecycle e2e tests assert both the rejection
 * and that nothing was committed.
 */
type ProcessorContractParseEventInput<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = {
  <const Type extends ResolvedEventType<Events, ProcessorDeps>>(
    type: Type,
    event: StreamEventInput,
  ): ParsedInputFromType<Events, ProcessorDeps, Type>;
  (
    event: StreamEventInput,
  ): ParsedInputFromType<Events, ProcessorDeps, ResolvedEventType<Events, ProcessorDeps>>;
};

// =============================================================================
// Runtime event parsers (bound to this app's event schemas).
// =============================================================================

/**
 * Rebuild the concrete Zod envelope for one committed event from its catalog
 * key plus `payloadSchema`. Contracts author event definitions as plain
 * `{ description, payloadSchema }` values keyed by the event type string, so
 * replay and live delivery share one validation path.
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
    ephemeral: StreamEventSchema.shape.ephemeral,
    offset: StreamEventSchema.shape.offset,
    createdAt: StreamEventSchema.shape.createdAt,
    path: StreamEventSchema.shape.path,
  }) as unknown as z.ZodType<
    TypedStreamEvent<Type, z.output<PayloadSchema>>,
    TypedStreamEvent<Type, z.input<PayloadSchema>>
  >;
}

/**
 * `getEventSchema` without offset/createdAt (and strict, so an accidental
 * `offset` key on an append input fails loudly). Gives pre-append policy code
 * the same payload validation as reducers, without fabricating a committed
 * event just to get at the typed payload.
 */
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
      ephemeral: StreamEventInputSchema.shape.ephemeral,
    })
    .strict() as unknown as z.ZodType<
    TypedStreamEventInput<Type, z.output<PayloadSchema>>,
    TypedStreamEventInput<Type, z.input<PayloadSchema>>
  >;
}

// =============================================================================
// Contract definition + resolution machinery.
// =============================================================================

/**
 * Validate an append input against the payload schema resolved from a contract's
 * local `events` plus its `processorDeps`. Used by call sites that hold a
 * contract but not a processor instance (e.g. subscription-configured event
 * builders in `utils.ts`); contracts expose it pre-bound as
 * `contract.buildEvent(...)`.
 */

/**
 * Memoized twins of {@link getEventSchema} / {@link getEventInputSchema} for
 * hot paths. Constructing the zod wrapper per call costs ~20µs (~50x the
 * parse itself), and the reduce/append paths run once per event. Keyed by
 * payload-schema identity, then event type: catalog entries are module
 * constants, so the WeakMap never grows past the contract surface.
 */
const eventSchemaCache = new WeakMap<z.ZodType, Map<string, z.ZodType>>();

function cachedSchema(
  cache: WeakMap<z.ZodType, Map<string, z.ZodType>>,
  build: (args: { type: string; payloadSchema: z.ZodType }) => z.ZodType,
  args: { type: string; payloadSchema: z.ZodType },
): z.ZodType {
  let byType = cache.get(args.payloadSchema);
  if (byType === undefined) {
    byType = new Map();
    cache.set(args.payloadSchema, byType);
  }
  let schema = byType.get(args.type);
  if (schema === undefined) {
    schema = build(args);
    byType.set(args.type, schema);
  }
  return schema;
}

/** Memoized {@link getEventSchema} (see {@link eventSchemaCache}). */
export function cachedEventSchema(args: { type: string; payloadSchema: z.ZodType }): z.ZodType {
  return cachedSchema(eventSchemaCache, getEventSchema, args);
}

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

/** Union of append-input shapes for every event a contract can resolve (own + deps). */
type ResolvedEventInput<Contract> = Contract extends {
  events: EventCatalog;
}
  ? InputFromType<
      ContractEventCatalog<Contract>,
      ProcessorDepsOf<Contract>,
      ResolvedEventType<ContractEventCatalog<Contract>, ProcessorDepsOf<Contract>>
    >
  : never;

/**
 * Typed identity for processor contracts: validation plus the pre-bound
 * `buildEvent` / `parseEvent` / `parseEventInput` helpers.
 *
 * The signature enforces the important invariants at authoring time:
 *
 * - `stateSchema` must parse `{}` to an object-shaped reduced state;
 * - every string in `consumes` and `emits` must resolve against local `events`
 *   plus `processorDeps` (and both are contextually typed for autocomplete);
 * - local `events` must not redefine an event already owned by a
 *   `processorDeps` contract. Event ownership is intentionally one processor
 *   deep: a processor can depend on another owner, but it cannot shadow that
 *   owner's public event type with a second payload schema.
 */
export function defineProcessorContract<
  const StateSchema extends z.ZodType,
  const Events extends EventCatalog,
  const Consumes extends readonly (ResolvedEventType<Events, ProcessorDeps> | "*")[],
  const Emits extends readonly ResolvedEventType<Events, ProcessorDeps>[],
  const ProcessorDeps extends readonly unknown[] = readonly [],
>(contract: {
  slug: string;
  version: string;
  description: string;
  stateSchema: DefaultableObjectStateSchema<StateSchema>;
  processorDeps?: ProcessorDeps;
  events: Events;
  consumes: Consumes & ResolvedEventTypesOnly<Events, ProcessorDeps, Consumes, "*">;
  emits: Emits & ResolvedEventTypesOnly<Events, ProcessorDeps, Emits>;
}): {
  slug: string;
  version: string;
  description: string;
  stateSchema: StateSchema;
  processorDeps?: ProcessorDeps;
  events: Events;
  consumes: Consumes;
  emits: Emits;
  buildEvent: ProcessorContractBuildEvent<Events, ProcessorDeps>;
  parseEvent: ProcessorContractParseEvent<Events, ProcessorDeps>;
  parseEventInput: ProcessorContractParseEventInput<Events, ProcessorDeps>;
};
// The implementation is intentionally untyped (`any` return): the single typed
// overload above carries the whole contract type; TS cannot relate the
// generic helper-method shapes to the runtime Object.assign result.
export function defineProcessorContract(contract: unknown): any {
  assertNoLocalProcessorDepEventConflicts(contract);
  assertDefaultStateSchema(contract);
  if (typeof contract !== "object" || contract === null) {
    throw new Error("Processor contract must be an object.");
  }
  for (const method of ["buildEvent", "parseEvent", "parseEventInput"] as const) {
    if (method in contract) {
      throw new Error(`Processor "${getProcessorSlug(contract)}" must not define ${method}.`);
    }
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
    parseEvent: makeContractEventParser(typedContract, "parseEvent", getEventSchema),
    parseEventInput: makeContractEventParser(typedContract, "parseEventInput", getEventInputSchema),
  });
}

/**
 * Shared runtime body of `contract.parseEvent(...)` and
 * `contract.parseEventInput(...)`: both resolve the payload schema from the
 * contract catalog, so an edit to a core event schema automatically affects
 * committed-event reduction and pre-commit validation together.
 */
function makeContractEventParser(
  contract: { events: EventCatalog; processorDeps?: readonly unknown[] },
  name: "parseEvent" | "parseEventInput",
  schemaFor: (args: { type: string; payloadSchema: z.ZodType }) => {
    parse(value: unknown): unknown;
  },
) {
  const parserCache = new Map<string, { parse(value: unknown): unknown }>();
  return (typeOrEvent: string | { type: string }, maybeEvent?: { type: string }) => {
    const eventType = typeof typeOrEvent === "string" ? typeOrEvent : typeOrEvent.type;
    const event = typeof typeOrEvent === "string" ? maybeEvent : typeOrEvent;
    if (event === undefined) {
      throw new Error(`Processor "${getProcessorSlug(contract)}" ${name} missing event.`);
    }
    const eventDefinition = getResolvedEventDefinition({ contract, eventType });
    if (eventDefinition == null) {
      throw new Error(
        `Processor "${getProcessorSlug(contract)}" cannot parse unresolved event "${eventType}".`,
      );
    }
    // Memoized: contract.parseEventInput runs inside the synchronous append
    // turn (core policy validation), where per-call schema construction was
    // measurable.
    let schema = parserCache.get(eventType);
    if (schema === undefined) {
      schema = schemaFor({ type: eventType, payloadSchema: eventDefinition.payloadSchema });
      parserCache.set(eventType, schema);
    }
    return schema.parse(event);
  };
}

/**
 * Enforces the invariant that reduced processor state is object-shaped (so
 * state slices can evolve safely and hooks never branch on primitive state).
 */
export function assertObjectProcessorState(args: { processorSlug: string; value: unknown }) {
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
 * the named definition when the type is listed in `consumes`, a permissive
 * `z.unknown()` definition when the contract consumes `"*"`, and `undefined`
 * when the event is not consumed at all. Runtime counterpart of
 * `ConsumedEvent<Contract>`.
 */
export function getConsumedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
  };
  eventType: string;
}): EventDefinition | undefined {
  if (!args.contract.consumes.includes(args.eventType)) {
    if (args.contract.consumes.includes("*")) return { payloadSchema: z.unknown() };
    return undefined;
  }
  const eventDefinition = getResolvedEventDefinition(args);
  if (eventDefinition == null) {
    throw new Error(`Unresolved stream processor consumes event type "${args.eventType}".`);
  }
  return eventDefinition;
}

export function getResolvedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
  };
  eventType: string;
}): EventDefinition | undefined {
  const localEventDefinition = args.contract.events[args.eventType];
  if (localEventDefinition != null) return localEventDefinition;

  for (const dependency of args.contract.processorDeps ?? []) {
    const dependencyEventDefinition = getDependencyEvents(dependency)?.[args.eventType];
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
        `Processor "${getProcessorSlug(contract)}" defines event "${type}" that is already owned by processor dependency "${getProcessorSlug(dependency)}".`,
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
