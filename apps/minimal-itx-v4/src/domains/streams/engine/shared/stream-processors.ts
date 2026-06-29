import { z } from "zod";
import type {
  ContractEventCatalog,
  EventCatalog,
  EventDefinition,
  EventDefinitionForType,
  ProcessorDepsOf,
} from "@iterate-com/shared/streams/stream-processors";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
} from "../../schemas.ts";
import type {
  StreamEvent as BaseStreamEvent,
  StreamEventInput as BaseStreamEventInput,
} from "../../types.ts";

export * from "@iterate-com/shared/streams/stream-processors";

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

export type ProcessorEventInput<Contract> = ConsumedInput<Contract> | EmittedInput<Contract>;

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
