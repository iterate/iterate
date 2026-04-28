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

export type EventDefinition<
  Type extends string = string,
  PayloadOutput = unknown,
  PayloadInput = PayloadOutput,
> = {
  type: Type;
  description?: string;
  payloadSchema: z.ZodType<PayloadOutput, PayloadInput>;
  input: z.ZodType<StreamEventInput<Type, PayloadOutput>, StreamEventInput<Type, PayloadInput>>;
  event: z.ZodType<StreamEvent<Type, PayloadOutput>, StreamEvent<Type, PayloadInput>>;
  createInput(args: {
    payload: PayloadInput;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    offset?: number;
  }): StreamEventInput<Type, PayloadOutput>;
};

export type EventCatalog = Record<string, EventDefinition<string, unknown, unknown>>;

export type NoInferValue<Value> = [Value][Value extends unknown ? 0 : never];
export type ProcessorStateObject = Record<string, unknown>;

export type EventCatalogFromObject<Value> = {
  [Key in keyof Value as Value[Key] extends EventDefinition ? Key : never]: Value[Key];
};

export type ContractEventCatalog<ContractOrCatalog> = ContractOrCatalog extends {
  events: infer Events;
}
  ? EventCatalogFromObject<Events>
  : EventCatalogFromObject<ContractOrCatalog>;

export type ResolvedEventType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
> = Extract<keyof Events | EventTypeFromProcessorDeps<ProcessorDeps>, string>;

export type EventTypeFromProcessorDeps<ProcessorDeps extends readonly unknown[]> =
  ProcessorDeps[number] extends infer ProcessorDep
    ? ProcessorDep extends unknown
      ? keyof ContractEventCatalog<ProcessorDep>
      : never
    : never;

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

export type EventDefinitionForType<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : EventDefinitionFromProcessorDeps<ProcessorDeps, Type>;

export type EventFromDefinition<Definition> =
  Definition extends EventDefinition<infer Type, infer PayloadOutput, unknown>
    ? StreamEvent<Type, PayloadOutput>
    : never;

export type InputFromDefinition<Definition> =
  Definition extends EventDefinition<infer Type, infer PayloadOutput, infer PayloadInput>
    ? StreamEventInput<Type, PayloadOutput | PayloadInput>
    : never;

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
  ? EventFromDefinition<EventDefinitionForType<Events, ProcessorDeps, Type>>
  : never;

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
  ? InputFromDefinition<EventDefinitionForType<Events, ProcessorDeps, Type>>
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
   * Serializable reduced state schema. Processor state must be object-shaped
   * so slices can evolve safely over time and hooks never have to branch on
   * primitive state values.
   *
   * Stateless processors should use `z.object({}).default({})`. Keeping state
   * required avoids generic host code falling back to `{}` or `unknown`.
   */
  state: StateSchema;
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

export type ResolvedEventTypesOnly<
  Events extends EventCatalog,
  ProcessorDeps extends readonly unknown[],
  Types extends readonly string[],
> = [UnresolvedEventTypes<Events, ProcessorDeps, Types>] extends [never] ? unknown : never;

export type ProcessorDepsOf<Contract> = Contract extends {
  processorDeps?: infer ProcessorDeps;
}
  ? ProcessorDeps extends readonly unknown[]
    ? ProcessorDeps
    : readonly []
  : readonly [];

export type ProcessorState<Contract> = Contract extends {
  state: infer State extends z.ZodType;
}
  ? z.output<State>
  : never;

export type ConsumedEvent<Contract> = Contract extends {
  events: infer Events extends EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventFromTypes<Events, ProcessorDepsOf<Contract>, Consumes>
  : never;

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
   * `streamPath`, the host should use this path. Relative method paths are
   * resolved by the host against this bound path; absolute paths target that
   * absolute stream directly.
   */
  streamPath?: string;
};

export type ProcessorStreamApi<Contract> = {
  append(args: { event: EmittedInput<Contract>; streamPath?: string }): Promise<StreamEvent>;
  read(args?: {
    streamPath?: string;
    afterOffset?: number;
    beforeOffset?: number;
  }): Promise<StreamEvent[]>;
  subscribe(args?: {
    streamPath?: string;
    afterOffset?: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamEvent>;
};

export type ProcessorReduction<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

export type ProcessorImplementation<Contract> = {
  /**
   * Runs after the host has loaded or replayed reduced state, but before live
   * post-append processing begins. Use this to materialize runtime-only state
   * such as HTTP clients, MCP connections, subscriptions, or timers.
   */
  onStart?(args: {
    state: ProcessorState<Contract>;
    streamApi: ProcessorStreamApi<Contract>;
    signal: AbortSignal;
  }): Promise<void> | void;
  /**
   * Runs for live committed events after the host has reduced and persisted the
   * processor state for that event. Historical catch-up is reduce-only by
   * default so side effects are not replayed accidentally.
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
