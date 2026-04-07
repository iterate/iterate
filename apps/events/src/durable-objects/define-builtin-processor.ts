import type { Event, EventInput, StreamPath } from "@iterate-com/events-contract";
import type { Processor } from "./define-processor.ts";

export type BuiltinProcessorContext = {
  append: (event: EventInput) => Event;
  createLoopbackBinding: (args: { exportName: string; props?: unknown }) => Fetcher;
  createStreamTarget: () => unknown;
  getPath: () => StreamPath;
  loader: WorkerLoader;
  waitUntil: (promise: Promise<unknown>) => void;
};

export type BuiltinProcessorRuntime<TState = Record<string, unknown>> = {
  beforeAppend?(args: { event: EventInput; state: TState }): void;
  afterAppend?(args: { event: Event; state: TState }): Promise<void> | void;
  onStateLoaded?(args: { state: TState }): Promise<void> | void;
};

/**
 * A BuiltinProcessor runs in-process inside the Durable Object, so it can
 * synchronously reject events via `beforeAppend` before they are committed.
 * Non-builtin processors cannot do this because they may execute across the
 * network where synchronous rejection is not possible.
 */
export type BuiltinProcessor<TState = Record<string, unknown>> = Processor<TState> & {
  beforeAppend?(args: { event: EventInput; state: TState }): void;
  createRuntime?(context: BuiltinProcessorContext): BuiltinProcessorRuntime<TState>;
};

export function defineBuiltinProcessor<const TState>(
  factory: () => BuiltinProcessor<TState>,
): BuiltinProcessor<TState> {
  return factory();
}
