import { z } from "zod";
import type {
  BuiltinProcessor,
  BuiltinProcessorImplementation,
  ConsumedEvent,
  EventCatalog,
  EventDefinition,
  Processor,
  ProcessorContractShape,
  ProcessorHostState,
  ProcessorImplementation,
  ProcessorReduction,
  ProcessorState,
  ProcessorStreamApi,
  ResolvedEventTypesOnly,
  StreamEvent,
  StreamEventInput,
} from "./types.ts";

const Metadata = z.record(z.string(), z.unknown());
const EventOffset = z.number().int().positive();
const CreatedAt = z.iso.datetime({ offset: true });

/**
 * Creates a one-key event catalog entry.
 *
 * Prefer inline event catalogs for new processors. This helper remains useful
 * in tests and for mechanically generated event catalogs.
 */
export function createEvent<
  const Type extends string,
  const PayloadSchema extends z.ZodType,
>(args: {
  type: Type;
  description?: string;
  payloadSchema: PayloadSchema;
}): {
  [Key in Type]: EventDefinition<Type, z.output<PayloadSchema>, z.input<PayloadSchema>>;
} {
  return {
    [args.type]: {
      ...(args.description == null ? {} : { description: args.description }),
      payloadSchema: args.payloadSchema,
    },
  } as unknown as {
    [Key in Type]: EventDefinition<Type, z.output<PayloadSchema>, z.input<PayloadSchema>>;
  };
}

/**
 * Runtime append-input parser for a string-keyed event definition.
 *
 * Most processor authors should not call this directly. `streamApi.append(...)`
 * is typed from `contract.emits`, so ordinary object literals are the ergonomic
 * path. Hosts can use this helper at the append boundary when they need to
 * validate that a raw event input matches the payload schema for its `type`.
 */
export function getEventInputSchema<
  const Type extends string,
  const PayloadSchema extends z.ZodType,
>(args: {
  type: Type;
  payloadSchema: PayloadSchema;
}): z.ZodType<
  StreamEventInput<Type, z.output<PayloadSchema>>,
  StreamEventInput<Type, z.input<PayloadSchema>>
> {
  return z.strictObject({
    type: z.literal(args.type),
    payload: args.payloadSchema,
    metadata: Metadata.optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    offset: EventOffset.optional(),
  }) as unknown as z.ZodType<
    StreamEventInput<Type, z.output<PayloadSchema>>,
    StreamEventInput<Type, z.input<PayloadSchema>>
  >;
}

/**
 * Runtime committed-event parser for a string-keyed event definition.
 *
 * Processor contracts intentionally author event definitions as plain
 * `{ description, payloadSchema }` values keyed by the event type string. The
 * key is the durable event type; the value does not repeat it. Hosts therefore
 * rebuild the concrete Zod envelope from the catalog key plus `payloadSchema`
 * whenever they validate append input or committed stream events.
 *
 * The cast is local to this helper because Zod's object inference cannot keep
 * the generic literal `Type` and generic `PayloadSchema` relationship through
 * `z.strictObject(...)`. The runtime schema still exactly matches
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
  return z.strictObject({
    streamPath: z.string().trim().min(1),
    type: z.literal(args.type),
    payload: args.payloadSchema,
    metadata: Metadata.optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    offset: EventOffset,
    createdAt: CreatedAt,
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
 *   plus `processorDeps`.
 *
 * `initialState` is optional. If it is omitted, hosts initialize by parsing
 * `undefined` through `stateSchema`. If it is present, hosts initialize by
 * parsing `initialState` through `stateSchema`.
 */
export function defineProcessorContract<
  const StateSchema extends z.ZodType,
  const Events extends EventCatalog,
  const ProcessorDeps extends readonly unknown[],
  const Consumes extends readonly string[] = readonly [],
  const Emits extends readonly string[] = readonly [],
>(
  contract: Omit<
    ProcessorContractShape<StateSchema, Events, ProcessorDeps, Consumes, Emits>,
    "stateSchema" | "initialState" | "processorDeps" | "consumes" | "emits"
  > & {
    stateSchema: z.output<StateSchema> extends Record<string, unknown> ? StateSchema : never;
    initialState?: z.input<StateSchema>;
    processorDeps: ProcessorDeps;
    consumes: Consumes & ResolvedEventTypesOnly<Events, ProcessorDeps, Consumes>;
    emits: Emits & ResolvedEventTypesOnly<Events, ProcessorDeps, Emits>;
  },
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
  const Consumes extends readonly string[] = readonly [],
  const Emits extends readonly string[] = readonly [],
>(
  contract: Omit<
    ProcessorContractShape<StateSchema, Events, readonly [], Consumes, Emits>,
    "stateSchema" | "initialState" | "processorDeps" | "consumes" | "emits"
  > & {
    stateSchema: z.output<StateSchema> extends Record<string, unknown> ? StateSchema : never;
    initialState?: z.input<StateSchema>;
    processorDeps?: never;
    consumes: Consumes & ResolvedEventTypesOnly<Events, readonly [], Consumes>;
    emits: Emits & ResolvedEventTypesOnly<Events, readonly [], Emits>;
  },
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

export function implementProcessor<const Contract>(
  contract: Contract,
  implementation: ProcessorImplementation<Contract>,
): Processor<Contract> {
  return { contract, implementation };
}

export function implementBuiltinProcessor<const Contract>(
  contract: Contract,
  implementation: BuiltinProcessorImplementation<Contract>,
): BuiltinProcessor<Contract> {
  return { contract, implementation };
}

export function validateProcessorContract(contract: {
  slug: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly ({ slug?: string; events: EventCatalog } | EventCatalog)[];
  consumes: readonly string[];
  emits: readonly string[];
}) {
  assertObjectProcessorState({
    processorSlug: contract.slug,
    value: getInitialProcessorState(contract),
  });

  const resolvedEvents = new Map<string, { owner: string; event: EventDefinition }>();
  for (const dependency of contract.processorDeps ?? []) {
    const events = isProcessorContractDependency(dependency) ? dependency.events : dependency;
    const owner = isProcessorContractDependency(dependency)
      ? (dependency.slug ?? "processor dependency")
      : "event catalog";

    for (const [eventType, event] of Object.entries(events)) {
      addResolvedEvent({
        resolvedEvents,
        eventType,
        event,
        owner,
      });
    }
  }

  for (const [eventType, event] of Object.entries(contract.events)) {
    addResolvedEvent({ resolvedEvents, eventType, event, owner: contract.slug });
  }

  assertResolvedEventTypes({
    field: "consumes",
    resolvedEvents,
    eventTypes: contract.consumes,
  });
  assertResolvedEventTypes({
    field: "emits",
    resolvedEvents,
    eventTypes: contract.emits,
  });
}

export function getProcessorStateSchema(contract: {
  slug: string;
  stateSchema: z.ZodType;
}): z.ZodType {
  return contract.stateSchema;
}

export function getInitialProcessorState<
  const Contract extends {
    stateSchema: z.ZodType;
    initialState?: unknown;
  },
>(contract: Contract): ProcessorState<Contract> {
  return contract.stateSchema.parse(contract.initialState) as ProcessorState<Contract>;
}

export function createProcessorHostState<const Contract extends { stateSchema: z.ZodType }>(args: {
  contract: Contract;
  state?: ProcessorState<Contract>;
  reducedThroughOffset?: number;
  afterAppendCompletedThroughOffset?: number;
}): ProcessorHostState<Contract> {
  return {
    state: args.state === undefined ? getInitialProcessorState(args.contract) : args.state,
    reducedThroughOffset: args.reducedThroughOffset ?? 0,
    afterAppendCompletedThroughOffset: args.afterAppendCompletedThroughOffset ?? 0,
  };
}

export function runProcessorReduce<
  const Contract extends {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
    reduce?: (args: {
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

export function reduceProcessorEvents<
  const Contract extends {
    slug: string;
    stateSchema: z.ZodType;
    initialState?: unknown;
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
    reduce?: (args: {
      state: ProcessorState<Contract>;
      event: ConsumedEvent<Contract>;
    }) => ProcessorState<Contract> | null | undefined;
  },
>(args: {
  contract: Contract;
  events: readonly StreamEvent[];
  state?: ProcessorState<Contract>;
}): ProcessorState<Contract> {
  let state = args.state ?? getInitialProcessorState(args.contract);

  for (const event of args.events) {
    const reduction = runProcessorReduce({
      processor: { contract: args.contract },
      event,
      state,
    });
    state = reduction?.state ?? state;
  }

  return state;
}

export async function runProcessorOnStart<const Contract>(args: {
  processor: { contract: Contract; implementation: ProcessorImplementation<Contract> };
  state: ProcessorState<Contract>;
  streamApi: ProcessorStreamApi<Contract>;
  signal: AbortSignal;
}): Promise<void> {
  await args.processor.implementation.onStart?.({
    state: args.state,
    streamApi: args.streamApi,
    signal: args.signal,
  });
}

export async function runProcessorAfterAppend<const Contract>(args: {
  processor: { contract: Contract; implementation: ProcessorImplementation<Contract> };
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
  streamApi: ProcessorStreamApi<Contract>;
  signal: AbortSignal;
}): Promise<void> {
  await args.processor.implementation.afterAppend?.({
    event: args.event,
    previousState: args.previousState,
    state: args.state,
    streamApi: args.streamApi,
    signal: args.signal,
  });
}

function assertObjectProcessorState(args: { processorSlug: string; value: unknown }) {
  if (typeof args.value === "object" && args.value !== null && !Array.isArray(args.value)) {
    return;
  }

  throw new Error(`Processor "${args.processorSlug}" state must be an object.`);
}

function getConsumedEventDefinition(args: {
  contract: {
    events: EventCatalog;
    processorDeps?: readonly unknown[];
    consumes: readonly string[];
  };
  eventType: string;
}): EventDefinition | undefined {
  if (!args.contract.consumes.includes(args.eventType)) {
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

function addResolvedEvent(args: {
  resolvedEvents: Map<string, { owner: string; event: EventDefinition }>;
  eventType: string;
  owner: string;
  event: EventDefinition;
}) {
  const existing = args.resolvedEvents.get(args.eventType);
  if (existing != null && existing.event !== args.event) {
    throw new Error(
      `Duplicate stream processor event type "${args.eventType}" owned by both "${existing.owner}" and "${args.owner}".`,
    );
  }
  args.resolvedEvents.set(args.eventType, {
    event: args.event,
    owner: args.owner,
  });
}

function assertResolvedEventTypes(args: {
  field: "consumes" | "emits";
  resolvedEvents: Map<string, { owner: string; event: EventDefinition }>;
  eventTypes: readonly string[];
}) {
  for (const eventType of args.eventTypes) {
    if (args.resolvedEvents.has(eventType)) {
      continue;
    }
    throw new Error(`Unresolved stream processor ${args.field} event type "${eventType}".`);
  }
}

function isProcessorContractDependency(
  dependency: { slug?: string; events: EventCatalog } | EventCatalog,
): dependency is { slug?: string; events: EventCatalog } {
  return (
    "events" in dependency && typeof dependency.events === "object" && dependency.events != null
  );
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

export type {
  BuiltinProcessor,
  BuiltinProcessorImplementation,
  ConsumedEvent,
  EmittedInput,
  EventCatalog,
  EventDefinition,
  Processor,
  ProcessorContractShape,
  ProcessorHostState,
  ProcessorImplementation,
  ProcessorReduction,
  ProcessorState,
  ProcessorStateObject,
  ProcessorStreamApi,
  ProcessorStreamApiProps,
  StreamEvent,
  StreamEventInput,
} from "./types.ts";
