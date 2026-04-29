import type { Event, EventInput, StreamState } from "@iterate-com/events-contract";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";
import { dynamicWorkerProcessor } from "./dynamic-processor.ts";
import { externalSubscriberProcessor } from "./external-subscriber.ts";
import { jsonataTransformerProcessor } from "./jsonata-transformer.ts";

type ProcessorSlugKey = keyof StreamState["processors"];
type StreamBuiltinProcessor = {
  slug: string;
  initialState: unknown;
  beforeAppend?(args: { event: EventInput; state: unknown }): void;
  reduce?(args: { event: Event; state: unknown }): unknown;
  afterAppend?(args: {
    append: (event: EventInput) => Event;
    event: Event;
    state: unknown;
  }): Promise<void>;
};

/**
 * Builtin processors run inside the stream Durable Object and may therefore
 * use privileged hooks such as `beforeAppend`.
 *
 * Keep this list small. Processors that do not need synchronous rejection
 * should eventually move to ordinary StreamProcessorRunner deployments, but
 * centralizing the list here already keeps `stream.ts` from growing one branch
 * per feature.
 */
const builtinProcessors = [
  circuitBreakerProcessor,
  externalSubscriberProcessor,
  dynamicWorkerProcessor,
  jsonataTransformerProcessor,
] as readonly unknown[] as readonly StreamBuiltinProcessor[];

export function createInitialBuiltinProcessorState(): StreamState["processors"] {
  return Object.fromEntries(
    builtinProcessors.map((processor) => [processor.slug, structuredClone(processor.initialState)]),
  ) as StreamState["processors"];
}

export function runBuiltinBeforeAppend(args: {
  event: EventInput;
  processors: StreamState["processors"];
}) {
  for (const processor of builtinProcessors) {
    runProcessorBeforeAppend({
      event: args.event,
      processor,
      processors: args.processors,
    });
  }
}

export function reduceBuiltinProcessors(args: {
  event: Event;
  processors: StreamState["processors"];
}): StreamState["processors"] {
  let processors = args.processors;

  for (const processor of builtinProcessors) {
    processors = reduceBuiltinProcessor({
      event: args.event,
      processor,
      processors,
    });
  }

  return processors;
}

export function runBuiltinAfterAppend(args: {
  append: (event: EventInput) => Event;
  event: Event;
  processors: StreamState["processors"];
  waitUntil: (promise: Promise<unknown>) => void;
  onError(args: { error: unknown; event: Event; processorSlug: string }): void;
}) {
  for (const processor of builtinProcessors) {
    const result = runProcessorAfterAppend({
      append: args.append,
      event: args.event,
      processor,
      processors: args.processors,
    });

    if (result == null) {
      continue;
    }

    args.waitUntil(
      result.catch((error) => {
        args.onError({
          error,
          event: args.event,
          processorSlug: processor.slug,
        });
      }),
    );
  }
}

function runProcessorBeforeAppend(args: {
  event: EventInput;
  processor: StreamBuiltinProcessor;
  processors: StreamState["processors"];
}) {
  args.processor.beforeAppend?.({
    event: args.event,
    state: getProcessorState(args.processors, args.processor.slug),
  });
}

function reduceBuiltinProcessor(args: {
  event: Event;
  processor: StreamBuiltinProcessor;
  processors: StreamState["processors"];
}): StreamState["processors"] {
  if (args.processor.reduce == null) {
    return args.processors;
  }

  const nextSlice = args.processor.reduce({
    event: args.event,
    state: getProcessorState(args.processors, args.processor.slug),
  });

  return {
    ...args.processors,
    [args.processor.slug]: nextSlice,
  };
}

function runProcessorAfterAppend(args: {
  append: (event: EventInput) => Event;
  event: Event;
  processor: StreamBuiltinProcessor;
  processors: StreamState["processors"];
}) {
  return args.processor.afterAppend?.({
    append: args.append,
    event: args.event,
    state: getProcessorState(args.processors, args.processor.slug),
  });
}

function getProcessorState(processors: StreamState["processors"], slug: string): unknown {
  return processors[slug as ProcessorSlugKey];
}
