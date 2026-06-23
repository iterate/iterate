import { z } from "zod";
import type { Json, Stream, StreamEvent, StreamEventInput } from "./types-and-schemas.ts";

type EventDefinition = {
  payloadSchema: z.ZodType;
};

type EventCatalog = Record<string, EventDefinition>;

type ProcessorContract = {
  consumes: readonly string[];
  events: EventCatalog;
  stateSchema: z.ZodType;
};

type EventForDefinition<Definition, Type extends string> = Definition extends {
  payloadSchema: infer Payload extends z.ZodType;
}
  ? Omit<StreamEvent, "payload" | "type"> & {
      payload: z.output<Payload>;
      type: Type;
    }
  : never;

type ConsumedEventForType<
  Events extends EventCatalog,
  Type extends string,
> = Type extends keyof Events ? EventForDefinition<Events[Type], Type> : never;

export type ProofConsumedEvent<Contract> = Contract extends {
  consumes: infer Consumes extends readonly string[];
  events: infer Events extends EventCatalog;
}
  ? ConsumedEventForType<Events, Consumes[number]>
  : never;

export type ProofProcessorState<Contract> = Contract extends {
  stateSchema: infer State extends z.ZodType;
}
  ? z.output<State>
  : never;

export abstract class ProofStreamProcessor<Contract extends ProcessorContract> {
  abstract readonly contract: Contract;

  reduce(args: {
    event: ProofConsumedEvent<Contract>;
    state: ProofProcessorState<Contract>;
  }): ProofProcessorState<Contract> {
    return args.state;
  }

  ingest(args: { events: readonly StreamEvent[] }): ProofProcessorState<Contract> {
    let state = this.contract.stateSchema.parse(undefined) as ProofProcessorState<Contract>;
    for (const event of args.events) {
      if (!this.contract.consumes.includes(event.type)) continue;
      state = this.reduce({
        event: event as ProofConsumedEvent<Contract>,
        state,
      });
    }
    return state;
  }
}

export const ProofCounterContract = {
  consumes: ["events.iterate.com/proof/increment", "events.iterate.com/proof/label"] as const,
  events: {
    "events.iterate.com/proof/increment": {
      payloadSchema: z.object({ amount: z.number() }),
    },
    "events.iterate.com/proof/label": {
      payloadSchema: z.object({ text: z.string() }),
    },
  },
  stateSchema: z.object({ count: z.number().default(0), label: z.string().default("") }),
} satisfies ProcessorContract;

export class ProofCounterProcessor extends ProofStreamProcessor<typeof ProofCounterContract> {
  readonly contract = ProofCounterContract;

  override reduce(
    args: Parameters<ProofStreamProcessor<typeof ProofCounterContract>["reduce"]>[0],
  ): ProofProcessorState<typeof ProofCounterContract> {
    switch (args.event.type) {
      case "events.iterate.com/proof/increment":
        return { ...args.state, count: args.state.count + args.event.payload.amount };
      case "events.iterate.com/proof/label":
        return { ...args.state, label: args.event.payload.text };
    }
  }
}

export class ProofStreamDurableObject implements Stream {
  #events: StreamEvent[] = [];

  append(args: { event: StreamEventInput }): StreamEvent {
    return this.appendBatch({ events: [args.event] })[0]!;
  }

  appendBatch(args: { events: StreamEventInput[] }): StreamEvent[] {
    const committed = args.events.map(
      (event, index): StreamEvent => ({
        ...event,
        createdAt: new Date().toISOString(),
        offset: this.#events.length + index + 1,
      }),
    );
    this.#events.push(...committed);
    return committed;
  }

  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      limit?: number;
    } = {},
  ): StreamEvent[] {
    const afterOffset = args.afterOffset ?? 0;
    const beforeOffset = args.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.#events
      .filter((event) => event.offset > afterOffset && event.offset < beforeOffset)
      .slice(0, args.limit ?? Number.MAX_SAFE_INTEGER);
  }

  jsonRoundTrip(value: Json): Json {
    return value;
  }
}
