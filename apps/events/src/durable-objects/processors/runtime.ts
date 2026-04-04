import type { Event, EventInput } from "@iterate-com/events-contract";
import { circuitBreakerProcessor } from "~/durable-objects/circuit-breaker.ts";
import type { BuiltinProcessor } from "~/durable-objects/define-processor.ts";
import { jsonataTransformerProcessor } from "~/durable-objects/jsonata-transformer.ts";
import { schedulingProcessor } from "~/durable-objects/processors/scheduling/index.ts";
import type { ReducedStreamState } from "~/durable-objects/reduced-stream-state.ts";

type AppendFn = (event: EventInput) => Promise<Event>;

type ProcessorRuntimeArgs = {
  append: AppendFn;
  ctx: DurableObjectState;
  event: Event;
  instance: object;
  state: ReducedStreamState;
};

export type StreamProcessor = {
  slug: string;
  ensureSchema?(ctx: DurableObjectState): void;
  hydrate?(args: { ctx: DurableObjectState; reducedState: ReducedStreamState }): void;
  applyProjectionSync?(args: { ctx: DurableObjectState; event: Event }): void;
  reduce?(args: { event: Event; state: ReducedStreamState }): ReducedStreamState | void;
  afterCommit?(args: ProcessorRuntimeArgs): Promise<void> | void;
  alarm?(args: {
    append: AppendFn;
    ctx: DurableObjectState;
    instance: object;
    state: ReducedStreamState;
  }): Promise<void> | void;
};

type ProcessorSlugKey = keyof ReducedStreamState["processors"];

const sliceProcessors: BuiltinProcessor[] = [circuitBreakerProcessor, jsonataTransformerProcessor];
const streamProcessors: StreamProcessor[] = [schedulingProcessor];

function getProcessorState(state: ReducedStreamState, slug: string) {
  return state.processors[slug as ProcessorSlugKey];
}

export function createBuiltinProcessorInitialState(): ReducedStreamState["processors"] {
  return Object.fromEntries(
    sliceProcessors.map((processor) => [processor.slug, structuredClone(processor.initialState)]),
  ) as ReducedStreamState["processors"];
}

export function ensureBuiltinProcessorSchema(ctx: DurableObjectState) {
  for (const processor of streamProcessors) {
    processor.ensureSchema?.(ctx);
  }
}

export function hydrateBuiltinProcessors(args: {
  ctx: DurableObjectState;
  reducedState: ReducedStreamState;
}) {
  for (const processor of streamProcessors) {
    processor.hydrate?.(args);
  }
}

export function applyBuiltinProcessorProjectionSync(args: {
  ctx: DurableObjectState;
  event: Event;
}) {
  for (const processor of streamProcessors) {
    processor.applyProjectionSync?.(args);
  }
}

export function runBuiltinProcessorBeforeAppend(args: {
  event: EventInput;
  instance: object;
  state: ReducedStreamState;
}) {
  for (const processor of sliceProcessors) {
    processor.beforeAppend?.({
      event: args.event,
      state: getProcessorState(args.state, processor.slug),
    });
  }
}

export function reduceBuiltinProcessorState(args: {
  event: Event;
  state: ReducedStreamState;
}): ReducedStreamState {
  let nextState = args.state;

  for (const processor of sliceProcessors) {
    if (processor.reduce == null) {
      continue;
    }

    const nextSlice = processor.reduce({
      event: args.event,
      state: getProcessorState(nextState, processor.slug),
    });
    nextState = {
      ...nextState,
      processors: { ...nextState.processors, [processor.slug]: nextSlice },
    };
  }

  for (const processor of streamProcessors) {
    nextState = processor.reduce?.({ event: args.event, state: nextState }) ?? nextState;
  }

  return nextState;
}

export async function runBuiltinProcessorAfterCommit(args: ProcessorRuntimeArgs) {
  for (const processor of streamProcessors) {
    await processor.afterCommit?.(args);
  }
}

export function runBuiltinProcessorAfterAppend(args: ProcessorRuntimeArgs) {
  for (const processor of sliceProcessors) {
    const result = processor.afterAppend?.({
      append: args.append,
      event: args.event,
      state: getProcessorState(args.state, processor.slug),
    });

    if (result == null) {
      continue;
    }

    void result.catch((error) => {
      console.error("[stream-do] processor afterAppend failed", {
        path: args.state.path,
        processor: processor.slug,
        eventType: args.event.type,
        error,
      });
    });
  }
}

export async function runBuiltinProcessorAlarm(args: {
  append: AppendFn;
  ctx: DurableObjectState;
  instance: object;
  state: ReducedStreamState;
}) {
  for (const processor of streamProcessors) {
    await processor.alarm?.(args);
  }
}
