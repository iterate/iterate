import { z } from "zod";
import type {
  BuiltinProcessor,
  BuiltinProcessorImplementation,
  EventCatalog,
  EventDefinition,
  Processor,
  ProcessorContractShape,
  ProcessorImplementation,
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
 * of truth for initial state. `validateProcessorContract()` checks the same
 * invariant at runtime.
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
    state: undefined extends z.input<StateSchema> ? StateSchema : never;
    processorDeps?: ProcessorDeps;
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
    state: undefined extends z.input<StateSchema> ? StateSchema : never;
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
  contract.state.parse(undefined);

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
  ProcessorStreamApi,
  StreamEvent,
  StreamEventInput,
} from "./types.ts";
