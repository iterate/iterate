import { z } from "zod";
import type { StreamEventInput } from "../../types.ts";
import { StreamEventInput as StreamEventInputSchema } from "./schemas.ts";

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

/**
 * Type-level event lookup for string-keyed processor contracts.
 *
 * A contract owns event types by object key. The event definition only carries
 * the payload schema, so shared event-building and processor inference both
 * use these types to resolve "event type string -> payload schema" from local
 * `events` plus processor dependencies.
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
 * event catalog. Processor dependencies deliberately support both shapes.
 */
export type ContractEventCatalog<ContractOrCatalog> = ContractOrCatalog extends {
  events: infer Events;
}
  ? EventCatalogFromObject<Events>
  : EventCatalogFromObject<ContractOrCatalog>;

export type ProcessorDepsOf<Contract> = Contract extends {
  processorDeps?: infer ProcessorDeps;
}
  ? ProcessorDeps extends readonly unknown[]
    ? ProcessorDeps
    : readonly []
  : readonly [];

/**
 * All event type strings resolvable from local `events` plus `processorDeps`.
 */
export type ResolvedEventType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = Extract<
  keyof EventCatalogFromObject<Events> | EventTypeFromProcessorDeps<ProcessorDeps>,
  string
>;

type EventTypeFromProcessorDeps<ProcessorDeps extends readonly unknown[]> =
  ProcessorDeps[number] extends infer ProcessorDep
    ? ProcessorDep extends unknown
      ? keyof ContractEventCatalog<ProcessorDep>
      : never
    : never;

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
 * Local events win over dependency events in the type-level lookup, while
 * `defineProcessorContract(...)` rejects duplicate ownership at runtime.
 */
export type EventDefinitionForType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : EventDefinitionFromProcessorDeps<ProcessorDeps, Type>;

type TypedStreamEventInput<Type extends string = string, Payload = Record<string, unknown>> = Omit<
  StreamEventInput,
  "payload" | "type"
> & {
  type: Type;
  payload?: Payload;
};

type InputFromDefinitionForType<Definition, Type extends string> =
  Definition extends EventDefinition<string, infer PayloadOutput, infer PayloadInput>
    ? TypedStreamEventInput<Type, PayloadOutput | PayloadInput>
    : never;

export type InputFromType<
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

/**
 * Pure event builder for processor contracts.
 *
 * This lives outside `stream-processor.ts` so `defineProcessorContract` can add
 * `contract.buildEvent(...)` without making stream utilities and core contract
 * initialization point back at each other. Runtime dependencies stay one-way:
 * stream processors may import this helper, and higher-level stream utilities
 * may import both this helper and concrete contracts.
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

  return z
    .object({
      type: z.literal(args.event.type),
      payload: eventDefinition.payloadSchema,
      metadata: StreamEventInputSchema.shape.metadata,
      source: StreamEventInputSchema.shape.source,
      idempotencyKey: StreamEventInputSchema.shape.idempotencyKey,
    })
    .strict()
    .parse(args.event) as unknown as Event;
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
