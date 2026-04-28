import { z } from "zod";
import type {
  BuiltinProcessor,
  BuiltinProcessorImplementation,
  ConsumedEvent,
  EventCatalog,
  EventDefinition,
  Processor,
  ProcessorContractShape,
  ProcessorImplementation,
  ProcessorState,
  ProcessorStreamApi,
  ProcessorReduction,
  StreamEvent,
} from "./types.ts";

const Metadata = z.record(z.string(), z.unknown());
const EventOffset = z.number().int().positive();
const CreatedAt = z.iso.datetime({ offset: true });

/**
 * Creates a single event definition as a one-key catalog entry.
 *
 * Returning `{ [type]: definition }` lets processor contracts keep event
 * definitions inline while making the durable wire event type the catalog key:
 *
 * ```ts
 * events: {
 *   ...createEvent({
 *     type: "agent-input-added",
 *     payloadSchema: AgentInputAddedPayload,
 *   }),
 * }
 * ```
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
  const type = z.literal(args.type);
  const input = z.strictObject({
    type,
    payload: args.payloadSchema,
    metadata: Metadata.optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    offset: EventOffset.optional(),
  });
  const event = z.strictObject({
    streamPath: z.string().trim().min(1),
    ...input.shape,
    offset: EventOffset,
    createdAt: CreatedAt,
  });

  return {
    [args.type]: {
      type: args.type,
      ...(args.description == null ? {} : { description: args.description }),
      payloadSchema: args.payloadSchema,
      input,
      event,
      createInput(inputArgs: {
        payload: z.input<PayloadSchema>;
        metadata?: Record<string, unknown>;
        idempotencyKey?: string;
        offset?: number;
      }) {
        return input.parse({
          type: args.type,
          ...inputArgs,
        });
      },
    },
  } as unknown as {
    [Key in Type]: EventDefinition<Type, z.output<PayloadSchema>, z.input<PayloadSchema>>;
  };
}

/**
 * Typed identity for processor contracts.
 *
 * The state schema must accept `undefined` so the schema is the single source
 * of truth for initial state. Even stateless processors declare
 * `z.object({}).default({})` for now; requiring state keeps generic host code
 * from falling back to `{}` or `unknown`.
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
    "state" | "processorDeps" | "consumes" | "emits"
  > & {
    state: undefined extends z.input<StateSchema>
      ? z.output<StateSchema> extends Record<string, unknown>
        ? StateSchema
        : never
      : never;
    processorDeps: ProcessorDeps;
    consumes: Consumes;
    emits: Emits;
  },
): Omit<
  ProcessorContractShape<StateSchema, Events, ProcessorDeps, Consumes, Emits>,
  "state" | "processorDeps" | "consumes" | "emits"
> & {
  state: StateSchema;
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
    "state" | "processorDeps" | "consumes" | "emits"
  > & {
    state: undefined extends z.input<StateSchema>
      ? z.output<StateSchema> extends Record<string, unknown>
        ? StateSchema
        : never
      : never;
    processorDeps?: never;
    consumes: Consumes;
    emits: Emits;
  },
): Omit<
  ProcessorContractShape<StateSchema, Events, readonly [], Consumes, Emits>,
  "state" | "processorDeps" | "consumes" | "emits"
> & {
  state: StateSchema;
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
  state: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly ({ slug?: string; events: EventCatalog } | EventCatalog)[];
  consumes: readonly string[];
  emits: readonly string[];
}) {
  assertObjectProcessorState({
    processorSlug: contract.slug,
    value: getProcessorStateSchema(contract).parse(undefined),
  });

  const resolvedEvents = new Map<string, { owner: string; event: EventDefinition }>();
  for (const dependency of contract.processorDeps ?? []) {
    const events = isProcessorContractDependency(dependency) ? dependency.events : dependency;
    const owner = isProcessorContractDependency(dependency)
      ? (dependency.slug ?? "processor dependency")
      : "event catalog";

    for (const event of Object.values(events)) {
      addResolvedEvent({
        resolvedEvents,
        event,
        owner,
      });
    }
  }

  for (const event of Object.values(contract.events)) {
    addResolvedEvent({ resolvedEvents, event, owner: contract.slug });
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

export function getProcessorStateSchema(contract: { slug: string; state: z.ZodType }): z.ZodType {
  return contract.state;
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

  const event = eventDefinition.event.parse(args.event) as ConsumedEvent<Contract>;
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

export async function runProcessorOnStart<const Contract>(args: {
  processor: { implementation: ProcessorImplementation<Contract> };
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
  processor: { implementation: ProcessorImplementation<Contract> };
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
  owner: string;
  event: EventDefinition;
}) {
  const existing = args.resolvedEvents.get(args.event.type);
  if (existing != null && existing.event !== args.event) {
    throw new Error(
      `Duplicate stream processor event type "${args.event.type}" owned by both "${existing.owner}" and "${args.owner}".`,
    );
  }
  args.resolvedEvents.set(args.event.type, {
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
    "type" in value &&
    typeof value.type === "string" &&
    "event" in value &&
    "input" in value &&
    "createInput" in value &&
    typeof value.createInput === "function"
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
  ProcessorImplementation,
  ProcessorState,
  ProcessorStateObject,
  ProcessorStreamApi,
  ProcessorStreamApiProps,
  ProcessorReduction,
  StreamEvent,
  StreamEventInput,
} from "./types.ts";
